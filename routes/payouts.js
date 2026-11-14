const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient, secretMatches } = require('../config/env');
const { payoutLimiter } = require('../config/rate-limiters');
const { allowSecretOrAuthenticatedUser, requireAdminUser } = require('../middlewares/auth');
const { sendWithdraw } = require('../services/moneyfusion');
const { sendSasPayPayout } = require('../services/saspay');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Déduit automatiquement le réseau Mobile Money si absent, selon l'indicatif ivoirien.
 */
function resolveWithdrawMode(phone, currentMode) {
  if (currentMode) return currentMode;
  let clean = String(phone || '').replace(/\s+/g, '');
  if (clean.startsWith('+225')) clean = clean.slice(4);
  else if (clean.startsWith('00225')) clean = clean.slice(5);
  else if (clean.startsWith('225')) clean = clean.slice(3);
  if (clean.startsWith('01')) return 'moov-ci';
  if (clean.startsWith('05')) return 'mtn-ci';
  if (clean.startsWith('07')) return 'wave-ci';
  return null;
}

// Rejet strict des requêtes GET sur /process-payouts (R3)
router.get('/process-payouts', (req, res) => {
  res.set('Allow', 'POST');
  return res.status(405).json({
    success: false,
    message: 'Méthode non autorisée. La route /process-payouts exige une requête HTTP POST.',
  });
});

// 3) Traitement des Payouts (POST uniquement)
router.post('/process-payouts', allowSecretOrAuthenticatedUser, payoutLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const secretCandidate = req.get('x-admin-secret') || req.query.secret || req.query.key || req.query.token;
    let isAdminCall = Boolean(ENV.ADMIN_SECRET) && secretMatches(secretCandidate, ENV.ADMIN_SECRET);

    if (!isAdminCall && req.user?.id) {
      const { data: adminUser } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
      const role = String(adminUser?.role || '').toLowerCase();
      if (['admin', 'superadmin', 'moderator', 'moderateur'].includes(role)) {
        isAdminCall = true;
      }
    }

    const forceRequested = req.query.force === 'true';
    const force = forceRequested && isAdminCall;

    if (isAdminCall && req.query.retry_failed === 'true') {
      await supabase.from('payouts').update({ status: 'pending', failure_reason: null }).eq('status', 'failed');
    }

    let query = supabase.from('payouts').select('*').eq('status', 'pending');
    if (!force) {
      query = query.lte('scheduled_for', new Date().toISOString());
    }

    const { data: payouts, error } = await query;
    if (error) throw error;

    if (!payouts || payouts.length === 0) {
      return res.json({
        success: true,
        message: force ? 'Aucun payout de statut pending' : 'Aucun payout en attente (délai d\'escrow non expiré)',
        processed: 0,
        forced: force,
        force_ignored: forceRequested && !force,
      });
    }

    const { data: payRow } = await supabase.from('system_settings').select('value').eq('key', 'payment_settings').maybeSingle();
    const payConfig = payRow?.value || {};
    const defaultProvider = payConfig.provider || ENV.PAYMENT_PROVIDER || 'moneyfusion';
    const forcedProvider = req.query.provider && ['saspay', 'moneyfusion'].includes(req.query.provider) ? req.query.provider : null;

    const results = [];
    const MONEYFUSION_PRIVATE_KEY = ENV.MONEYFUSION_PRIVATE_KEY;

    for (const payout of payouts) {
      const mode = resolveWithdrawMode(payout.recipient_phone, payout.withdraw_mode);
      if (!mode) {
        await supabase.from('payouts').update({
          status: 'failed',
          failure_reason: 'Réseau de retrait non configuré',
        }).eq('id', payout.id);
        results.push({ id: payout.id, status: 'failed', reason: 'withdraw_mode manquant' });
        continue;
      }

      const { data: locked, error: lockErr } = await supabase
        .from('payouts')
        .update({ status: 'processing', withdraw_mode: mode })
        .eq('id', payout.id)
        .eq('status', 'pending')
        .select('id');

      if (lockErr || !locked || locked.length === 0) {
        results.push({ id: payout.id, status: 'skipped', reason: 'already_processing_or_claimed' });
        continue;
      }

      // Routage intelligent vers la passerelle qui détient réellement les fonds
      let activeProvider = forcedProvider || defaultProvider;
      if (!forcedProvider && payout.escrow_id) {
        const { data: esc } = await supabase.from('escrow_transactions').select('payment_reference').eq('id', payout.escrow_id).maybeSingle();
        if (esc?.payment_reference) {
          activeProvider = UUID_RE.test(esc.payment_reference) ? 'saspay' : 'moneyfusion';
        }
      }

      try {
        if (activeProvider === 'saspay') {
          const result = await sendSasPayPayout({
            amount: payout.amount,
            phone: payout.recipient_phone,
            withdrawMode: mode,
            description: `Virement commande #${payout.id.slice(0, 8)}`,
            idempotencyKey: payout.id,
          });

          if (result.ok && result.id) {
            await supabase.from('payouts').update({ provider_token: result.id }).eq('id', payout.id);
            results.push({ id: payout.id, status: 'processing', token: result.id, provider: 'saspay' });
          } else {
            await supabase.from('payouts').update({
              status: 'failed',
              failure_reason: result.message || 'Erreur SasPay Payout',
            }).eq('id', payout.id);
            results.push({ id: payout.id, status: 'failed', reason: result.message, provider: 'saspay' });
          }
        } else {
          if (!MONEYFUSION_PRIVATE_KEY) {
            await supabase.from('payouts').update({ status: 'failed', failure_reason: 'MONEYFUSION_PRIVATE_KEY manquante' }).eq('id', payout.id);
            results.push({ id: payout.id, status: 'failed', reason: 'Clé privée MoneyFusion manquante' });
            continue;
          }

          const host = req.get('host');
          const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
          const secretParam = ENV.PAYOUT_WEBHOOK_SECRET ? `?secret=${encodeURIComponent(ENV.PAYOUT_WEBHOOK_SECRET)}` : '';
          const payload = {
            countryCode: 'ci',
            phone: payout.recipient_phone.replace(/\s/g, '').replace(/^\+225/, ''),
            amount: payout.amount,
            withdraw_mode: mode,
            webhook_url: `${protocol}://${host}/payout-webhook${secretParam}`,
          };

          const result = await sendWithdraw(payload, MONEYFUSION_PRIVATE_KEY);
          if (result.statut === true) {
            await supabase.from('payouts').update({ provider_token: result.tokenPay }).eq('id', payout.id);
            results.push({ id: payout.id, status: 'processing', token: result.tokenPay, provider: 'moneyfusion' });
          } else {
            await supabase.from('payouts').update({
              status: 'failed',
              failure_reason: result.message || 'Erreur API MoneyFusion',
            }).eq('id', payout.id);
            results.push({ id: payout.id, status: 'failed', reason: result.message, provider: 'moneyfusion' });
          }
        }
      } catch (err) {
        await supabase.from('payouts').update({
          status: 'failed',
          failure_reason: err.message || 'Exception réseau',
        }).eq('id', payout.id);
        results.push({ id: payout.id, status: 'failed', reason: err.message });
      }
    }

    if (isAdminCall && (forceRequested || req.user?.id)) {
      try {
        const totalAmount = payouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        await supabase.from('admin_financial_audit_logs').insert({
          admin_id: req.user?.id || '39ee0be2-ddb5-4124-b9f3-656a88b577bb',
          action_type: 'payout_force_sync',
          target_type: 'system',
          target_id: 'payouts_cron_queue',
          amount: totalAmount,
          details: {
            provider: forcedProvider || defaultProvider,
            forced_provider: forcedProvider,
            default_provider: defaultProvider,
            processed_count: payouts.length,
            retry_failed: req.query.retry_failed === 'true',
            forced: force,
            results_summary: results.map((r) => ({ id: r.id, status: r.status, reason: r.reason })),
          },
        });
      } catch (logErr) {
        console.warn('[Audit Log Warning] Échec insertion log forçage sync payouts:', logErr);
      }
    }

    return res.json({ success: true, processed: payouts.length, results });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 3.bis) Réessayer un payout individuel échoué
router.post('/retry-payout/:id', allowSecretOrAuthenticatedUser, payoutLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const secretCandidate = req.get('x-admin-secret') || req.query.secret || req.query.key || req.query.token;
    let isAdminCall = Boolean(ENV.ADMIN_SECRET) && secretMatches(secretCandidate, ENV.ADMIN_SECRET);

    if (!isAdminCall && req.user?.id) {
      const { data: adminUser } = await supabase.from('users').select('role').eq('id', req.user.id).maybeSingle();
      const role = String(adminUser?.role || '').toLowerCase();
      if (['admin', 'superadmin', 'moderator', 'moderateur'].includes(role)) {
        isAdminCall = true;
      }
    }

    if (!isAdminCall) {
      return res.status(403).json({ success: false, message: 'Action réservée aux administrateurs.' });
    }

    const payoutId = req.params.id;
    const { data: updatedRows, error: resetErr } = await supabase
      .from('payouts')
      .update({ status: 'pending', failure_reason: null })
      .eq('id', payoutId)
      .eq('status', 'failed')
      .select('id');

    if (resetErr) throw resetErr;
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ success: false, message: 'Seuls les versements en échec peuvent être relancés.' });
    }

    return res.json({ success: true, message: 'Versement réinitialisé en attente avec succès.' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 3.ter) Marquer un versement comme payé manuellement (avance administrateur sur fonds propres)
router.post('/mark-payout-manual/:id', requireAdminUser, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const payoutId = req.params.id;
    const { note, paymentMethod } = req.body || {};
    const adminId = req.user?.id || '39ee0be2-ddb5-4124-b9f3-656a88b577bb';

    const { data: payout, error: getErr } = await supabase.from('payouts').select('*').eq('id', payoutId).maybeSingle();
    if (getErr || !payout) {
      return res.status(404).json({ success: false, message: 'Versement introuvable' });
    }

    if (payout.status === 'paid') {
      return res.status(409).json({ success: false, message: 'Ce versement a déjà été payé.' });
    }

    const { error: updateErr } = await supabase
      .from('payouts')
      .update({
        status: 'paid',
        completed_at: new Date().toISOString(),
        provider_token: `manual_advance:${adminId.slice(0, 8)}:${payoutId.slice(0, 8)}`,
        failure_reason: null,
      })
      .eq('id', payoutId);

    if (updateErr) throw updateErr;

    try {
      await supabase.from('admin_financial_audit_logs').insert({
        admin_id: adminId,
        action_type: 'manual_payout_advance',
        target_type: 'payout',
        target_id: payoutId,
        amount: payout.amount,
        details: {
          recipient_phone: payout.recipient_phone,
          recipient_type: payout.type,
          escrow_id: payout.escrow_id,
          payment_method: paymentMethod || 'manual_wave',
          note: note || 'Avancé sur fonds propres administrateur',
        },
      });
    } catch (logErr) {
      console.warn('[Audit Log Warning] Échec insertion log paiement manuel:', logErr);
    }

    return res.json({ success: true, message: 'Versement marqué comme payé manuellement avec succès.' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
