const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { checkConfig, getSupabaseAdminClient, ENV } = require('../config/env');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { getCheckoutSession } = require('../services/saspay');
const { createOrderFromEscrow } = require('../services/escrow');
const { isUnderpaid, paidGrossAmount, confirmMonetizationOnce } = require('../services/monetization');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recherche sécurisée d'une transaction par ID UUID ou par jeton prestataire,
 * sans interpolation de chaîne dans un filtre PostgREST `.or()`.
 */
async function findTransactionByIdOrToken(supabase, table, tokenColumn, rawIdentifier) {
  const cleanId = String(rawIdentifier || '').trim();
  if (!cleanId) return null;

  if (UUID_RE.test(cleanId)) {
    const { data: byId } = await supabase
      .from(table)
      .select('*')
      .eq('id', cleanId)
      .maybeSingle();
    if (byId) return byId;
  }

  const { data: byToken } = await supabase
    .from(table)
    .select('*')
    .eq(tokenColumn, cleanId)
    .maybeSingle();
  return byToken || null;
}

/**
 * Traitement des webhooks MoneyFusion
 */
async function handleMoneyFusionWebhook(req, res, personal) {
  const transactionId = personal?.transactionId;
  const type = personal?.type;

  if (!transactionId || !type) return res.status(400).json({ ok: false, message: 'Données de requête invalides' });

  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

  const isOrder = type === 'order';
  const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';

  const { data: tx, error } = await supabase.from(table).select('*').eq('id', transactionId).maybeSingle();
  if (error || !tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable' });

  if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
    return res.json({ ok: true, message: 'Déjà confirmée' });
  }

  const token = isOrder ? tx.payment_reference : tx.provider_token;
  if (!token) return res.status(400).json({ ok: false, message: 'Token absent' });

  const fusionData = await checkPaymentNotification(token);
  if (!fusionData || fusionData.statut !== true || !fusionData.data) {
    return res.json({ ok: true, status: 'pending' });
  }

  const fusionStatus = fusionData.data.statut;
  const expectedAmount = Number(tx.total_amount ?? tx.amount);
  if (fusionStatus === 'paid' && isUnderpaid(fusionData, expectedAmount)) {
    const paid = paidGrossAmount(fusionData);
    console.warn(`webhook: paiement insuffisant tx=${transactionId} brut=${paid} attendu=${expectedAmount}`);
    return res.json({ ok: true, status: 'underpaid', paid, expected: expectedAmount });
  }

  if (fusionStatus === 'paid') {
    if (isOrder) {
      await createOrderFromEscrow(supabase, tx, personal);
    } else {
      await confirmMonetizationOnce(supabase, tx);
    }
    return res.json({ ok: true, status: 'paid' });
  }

  if (fusionStatus === 'failure' || fusionStatus === 'no paid') {
    await supabase.from(table).update({ status: isOrder ? 'cancelled' : 'failed' }).eq('id', transactionId);
    return res.json({ ok: true, status: fusionStatus });
  }

  return res.json({ ok: true, status: 'pending' });
}

/**
 * Valide la signature HMAC-SHA256 envoyée par SasPay.
 * Algorithme : HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * Rejet des horodatages > 5 minutes (300 secondes) pour parer aux attaques par rejeu.
 */
function verifySasPaySignature(req) {
  const secretConfig = (ENV.SASPAY_WEBHOOK_SECRET || '').trim();
  if (!secretConfig) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[SasPay Webhook]: SASPAY_WEBHOOK_SECRET non configuré — vérification serveur getCheckoutSession stricte exigée.');
    }
    return { valid: true, unsignedFallback: true };
  }

  const signature = req.get('x-webhook-signature') || req.get('x-saspay-signature');
  const timestampHeader = req.get('x-webhook-timestamp') || req.get('x-saspay-timestamp');

  if (!signature || !timestampHeader) {
    return { valid: false, reason: 'En-têtes X-Webhook-Signature ou X-Webhook-Timestamp manquants' };
  }

  const now = Math.floor(Date.now() / 1000);
  let parsedTimestamp = Number(timestampHeader);
  if (parsedTimestamp > 1e11) {
    parsedTimestamp = Math.floor(parsedTimestamp / 1000);
  }

  if (Number.isNaN(parsedTimestamp) || Math.abs(now - parsedTimestamp) > 300) {
    return { valid: false, reason: 'Horodatage expiré ou invalide (> 5 minutes)' };
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const signedPayload = `${timestampHeader}.${rawBody}`;
  const secrets = secretConfig.split(',').map((s) => s.trim()).filter(Boolean);

  for (const secret of secrets) {
    try {
      const computedHash = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

      const sigBuf = Buffer.from(signature, 'utf8');
      const hashBuf = Buffer.from(computedHash, 'utf8');

      if (sigBuf.length === hashBuf.length && crypto.timingSafeEqual(sigBuf, hashBuf)) {
        return { valid: true };
      }
    } catch {
      // Tester le secret suivant
    }
  }

  return { valid: false, reason: 'Signature HMAC invalide' };
}

/**
 * Traitement des webhooks SasPay
 */
async function handleSasPayWebhook(req, res) {
  const verification = verifySasPaySignature(req);
  if (!verification.valid) {
    console.warn('[SasPay Webhook Rejected]:', verification.reason);
    return res.status(403).json({ ok: false, message: verification.reason });
  }

  const payload = req.body;
  const data = payload?.data || payload;
  const metadata = data?.metadata || payload?.metadata || {};
  const transactionId = metadata.transactionId || data?.transaction_id || data?.id;

  const supabase = getSupabaseAdminClient();
  if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

  let tx = null;
  let isOrder = true;

  if (transactionId) {
    const escrow = await findTransactionByIdOrToken(supabase, 'escrow_transactions', 'payment_reference', transactionId);
    if (escrow) {
      tx = escrow;
      isOrder = true;
    } else {
      const monTx = await findTransactionByIdOrToken(supabase, 'monetization_transactions', 'provider_token', transactionId);
      if (monTx) {
        tx = monTx;
        isOrder = false;
      }
    }
  }

  if (!tx) {
    return res.status(200).json({ ok: true, message: 'Transaction ignorée' });
  }

  const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';
  if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
    return res.json({ ok: true, message: 'Déjà confirmée' });
  }

  const token = isOrder ? tx.payment_reference : tx.provider_token;
  if (!token) {
    return res.status(400).json({ ok: false, message: 'Référence de session manquante' });
  }

  // Seul l'état retourné par l'API SasPay (getCheckoutSession) fait foi
  const session = await getCheckoutSession(token);
  const isPaid = Boolean(
    session && (
      session.status === 'PAID' ||
      session.status === 'SUCCESS' ||
      session.transaction_status === 'SUCCESS'
    )
  );

  if (isPaid) {
    const expectedAmount = Number(tx.total_amount ?? tx.amount);
    const sessionAmount = Number(session.amount ?? session.total_amount ?? expectedAmount);
    if (Number.isFinite(expectedAmount) && expectedAmount > 0 && sessionAmount + 1 < expectedAmount) {
      console.warn(`[SasPay Webhook]: Montant payé insuffisant tx=${tx.id} payé=${sessionAmount} attendu=${expectedAmount}`);
      return res.json({ ok: true, status: 'underpaid', paid: sessionAmount, expected: expectedAmount });
    }

    if (isOrder) {
      await createOrderFromEscrow(supabase, tx, metadata);
    } else {
      await confirmMonetizationOnce(supabase, tx);
    }
    return res.json({ ok: true, status: 'paid' });
  }

  if (session && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(session.status)) {
    await supabase.from(table).update({ status: isOrder ? 'cancelled' : 'failed' }).eq('id', tx.id);
    return res.json({ ok: true, status: session.status });
  }

  return res.json({ ok: true, status: 'pending' });
}

router.post('/payment-webhook', async (req, res) => {
  try {
    checkConfig();
    const payload = req.body;
    const personal = Array.isArray(payload?.personal_Info) ? payload.personal_Info[0] : null;

    if (personal) {
      return await handleMoneyFusionWebhook(req, res, personal);
    }
    return await handleSasPayWebhook(req, res);
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.post('/saspay-webhook', handleSasPayWebhook);

module.exports = router;
