const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { checkConfig, getSupabaseAdminClient, secretMatches, ENV } = require('../config/env');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { getCheckoutSession, verifyTransaction } = require('../services/saspay');
const { createOrderFromEscrow } = require('../services/escrow');
const { isUnderpaid, paidGrossAmount, confirmMonetizationOnce } = require('../services/monetization');

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
      console.log('webhook: payment confirmed, creating order...');
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
 * Normalise et extrait les signatures candidates d'un en-tête.
 */
function extractCandidateSignatures(signatureHeader) {
  const candidates = new Set();
  const rawSig = String(signatureHeader || '').trim();
  if (!rawSig) return candidates;

  candidates.add(rawSig);

  if (rawSig.startsWith('sha256=')) {
    candidates.add(rawSig.slice(7).trim());
  }
  if (rawSig.startsWith('v1=')) {
    candidates.add(rawSig.slice(3).trim());
  }

  const parts = rawSig.split(',');
  for (const part of parts) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if ((k === 'v1' || k === 'sha256') && v) {
      candidates.add(v);
    }
  }
  return candidates;
}

/**
 * Construit la liste des payloads candidats à signer.
 */
function buildCandidatePayloads(req, timestamp) {
  const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  const trimmedBody = (req.rawBody || '').trim();
  const jsonBody = JSON.stringify(req.body || {});

  const payloads = new Set();
  if (rawBody) {
    payloads.add(rawBody);
    if (timestamp) {
      payloads.add(`${timestamp}.${rawBody}`);
      payloads.add(`${timestamp}${rawBody}`);
      payloads.add(`${rawBody}.${timestamp}`);
    }
  }
  if (trimmedBody && trimmedBody !== rawBody) {
    payloads.add(trimmedBody);
    if (timestamp) {
      payloads.add(`${timestamp}.${trimmedBody}`);
    }
  }
  if (jsonBody && jsonBody !== rawBody) {
    payloads.add(jsonBody);
    if (timestamp) {
      payloads.add(`${timestamp}.${jsonBody}`);
    }
  }
  return Array.from(payloads);
}

/**
 * Compare une signature en temps constant si les longueurs correspondent.
 */
function matchesSignature(candidateSig, computedHash) {
  try {
    const sigBuf = Buffer.from(candidateSig, 'utf8');
    const hashBuf = Buffer.from(computedHash, 'utf8');
    return sigBuf.length === hashBuf.length && crypto.timingSafeEqual(sigBuf, hashBuf);
  } catch {
    return false;
  }
}

/**
 * Valide la signature HMAC-SHA256 envoyée par SasPay.
 */
function verifySasPaySignature(req) {
  const secretConfig = (ENV.SASPAY_WEBHOOK_SECRET || '').trim();
  if (!secretConfig) {
    if (process.env.NODE_ENV === 'production') {
      return { valid: false, reason: 'SASPAY_WEBHOOK_SECRET non configuré' };
    }
    console.warn('[SasPay Webhook]: SASPAY_WEBHOOK_SECRET non configuré en dev — fallback API SasPay');
    return { valid: true, unsignedFallback: true };
  }

  const sigHeader =
    req.get('x-webhook-signature') ||
    req.get('x-saspay-signature') ||
    req.get('x-signature') ||
    req.get('signature') ||
    '';
  const tsHeader =
    req.get('x-webhook-timestamp') ||
    req.get('x-saspay-timestamp') ||
    req.get('x-timestamp') ||
    req.get('timestamp') ||
    '';

  const candidateSignatures = extractCandidateSignatures(sigHeader);
  if (candidateSignatures.size === 0) {
    return { valid: false, reason: 'En-têtes de signature manquants' };
  }

  const candidatePayloads = buildCandidatePayloads(req, tsHeader);
  const secrets = secretConfig.split(',').map((s) => s.trim()).filter(Boolean);

  for (const secret of secrets) {
    for (const payload of candidatePayloads) {
      const computedHash = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      for (const sig of candidateSignatures) {
        if (matchesSignature(sig, computedHash)) {
          return { valid: true };
        }
      }
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
    console.warn(`[SasPay Webhook]: Signature HMAC non validée (${verification.reason}). Tentative de vérification officielle via API SasPay...`);
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
    const { data: escrow } = await supabase
      .from('escrow_transactions')
      .select('*')
      .or(`id.eq.${transactionId},payment_reference.eq.${transactionId}`)
      .maybeSingle();

    if (escrow) {
      tx = escrow;
      isOrder = true;
    } else {
      const { data: monTx } = await supabase
        .from('monetization_transactions')
        .select('*')
        .or(`id.eq.${transactionId},provider_token.eq.${transactionId}`)
        .maybeSingle();
      if (monTx) {
        tx = monTx;
        isOrder = false;
      }
    }
  }

  if (!tx && data?.id) {
    const { data: monTx } = await supabase
      .from('monetization_transactions')
      .select('*')
      .eq('provider_token', data.id)
      .maybeSingle();
    if (monTx) {
      tx = monTx;
      isOrder = false;
    }
  }

  if (!tx) {
    console.log(`[SasPay Webhook]: Transaction ignorée (${transactionId || data?.id})`);
    return res.status(200).json({ ok: true, message: 'Transaction ignorée' });
  }

  const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';
  if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
    console.log(`[SasPay Webhook]: Transaction ${tx.id} déjà confirmée`);
    return res.json({ ok: true, message: 'Déjà confirmée' });
  }

  const token = isOrder ? tx.payment_reference : tx.provider_token;

  // Interrogation directe de l'API officielle SasPay (Zero-Trust)
  let isApiPaid = false;
  let session = null;

  if (token) {
    session = await getCheckoutSession(token);
    if (session && (session.status === 'PAID' || session.transaction_status === 'SUCCESS' || session.status === 'SUCCESS')) {
      isApiPaid = true;
    }
  }

  if (!isApiPaid && data?.id) {
    const verifiedTx = await verifyTransaction(data.id);
    if (verifiedTx && verifiedTx.ok && verifiedTx.status === 'SUCCESS') {
      isApiPaid = true;
    }
  }

  // Rejet si HMAC invalide ET que l'API SasPay ne confirme pas le paiement
  if (!verification.valid && !isApiPaid) {
    console.warn(`[SasPay Webhook Rejected]: ${verification.reason} pour tx=${tx.id}`);
    return res.status(403).json({ ok: false, message: verification.reason });
  }

  const isPaid = isApiPaid || (verification.valid && (data?.status === 'SUCCESS' || payload?.event === 'transaction.success'));

  if (isPaid) {
    console.log(`[SasPay Webhook]: Paiement validé avec succès pour tx=${tx.id} (authentifié: ${isApiPaid ? 'API SasPay' : 'HMAC'})`);
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

// 2) Webhook unifié MoneyFusion / SasPay
router.post('/payment-webhook', async (req, res) => {
  try {
    checkConfig();
    const payload = req.body;
    const personal = Array.isArray(payload?.personal_Info) ? payload.personal_Info[0] : null;

    if (personal) {
      return await handleMoneyFusionWebhook(req, res, personal);
    } else {
      return await handleSasPayWebhook(req, res);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Endpoint dédié explicite SasPay
router.post('/saspay-webhook', handleSasPayWebhook);

module.exports = router;
