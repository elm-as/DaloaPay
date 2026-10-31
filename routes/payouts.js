const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient, secretMatches } = require('../config/env');
const { payoutLimiter } = require('../config/rate-limiters');
const { allowSecretOrAuthenticatedUser, requireWebhookSecret } = require('../middlewares/auth');
const { sendWithdraw } = require('../services/moneyfusion');
const { sendSasPayPayout } = require('../services/saspay');
const { sendPushToUser } = require('../services/push');

// 3) Traitement des Payouts (MoneyFusion ou SasPay selon configuration)
router.get('/process-payouts', allowSecretOrAuthenticatedUser, payoutLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const secretCandidate = req.get('x-admin-secret') || req.query.secret || req.query.key || req.query.token;
    let isAdminCall = Boolean(ENV.ADMIN_SECRET) && secretMatches(secretCandidate, ENV.ADMIN_SECRET);

    if (!isAdminCall && req.user?.id) {
      const { data: adminUser } = await supabase
        .from('users')
        .select('role')
        .eq('id', req.user.id)
        .maybeSingle();
      const role = String(adminUser?.role || '').toLowerCase();
      if (['admin', 'superadmin', 'moderator', 'moderateur'].includes(role)) {
        isAdminCall = true;
      }
    }

    const forceRequested = req.query.force === 'true';
    const force = forceRequested && isAdminCall;

    if (isAdminCall && req.query.retry_failed === 'true') {
      await supabase
        .from('payouts')
        .update({ status: 'pending', failure_reason: null })
        .eq('status', 'failed');
    }

    let query = supabase
      .from('payouts')
      .select('*')
      .eq('status', 'pending');

    if (!force) {
      query = query.lte('scheduled_for', new Date().toISOString());
    }

    const { data: payouts, error } = await query;
    if (error) throw error;

    if (!payouts || payouts.length === 0) {
      return res.json({
        success: true,
        message: force
          ? 'Aucun payout de statut pending'
          : 'Aucun payout en attente (délai d\'escrow non expiré)',
        processed: 0,
        forced: force,
        force_ignored: forceRequested && !force,
      });
    }

    const { data: payRow } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'payment_settings')
      .maybeSingle();
    const payConfig = payRow?.value || {};
    const activeProvider = payConfig.provider || ENV.PAYMENT_PROVIDER || 'moneyfusion';

    const results = [];
    const MONEYFUSION_PRIVATE_KEY = ENV.MONEYFUSION_PRIVATE_KEY;

    for (const payout of payouts) {
      if (!payout.withdraw_mode) {
        results.push({ id: payout.id, status: 'skipped', reason: 'withdraw_mode manquant' });
        continue;
      }

      const { data: locked, error: lockErr } = await supabase
        .from('payouts')
        .update({ status: 'processing' })
        .eq('id', payout.id)
        .eq('status', 'pending')
        .select('id');

      if (lockErr || !locked || locked.length === 0) {
        results.push({ id: payout.id, status: 'skipped', reason: 'already_processing_or_claimed' });
        continue;
      }

      try {
        if (activeProvider === 'saspay') {
          const result = await sendSasPayPayout({
            amount: payout.amount,
            phone: payout.recipient_phone,
            withdrawMode: payout.withdraw_mode,
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
            withdraw_mode: payout.withdraw_mode,
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
            provider: activeProvider,
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
      const { data: adminUser } = await supabase
        .from('users')
        .select('role')
        .eq('id', req.user.id)
        .maybeSingle();
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

// 4) Webhook pour le résultat des Payouts (MoneyFusion & SasPay)
router.post('/payout-webhook', requireWebhookSecret(ENV.PAYOUT_WEBHOOK_SECRET, 'x-payout-webhook-secret'), async (req, res) => {
  console.log('[Webhook Payout Received] Payload:', JSON.stringify(req.body));
  try {
    checkConfig();
    const { event, tokenPay, message, id } = req.body;
    const refToken = tokenPay || id;

    if (!refToken) {
      return res.status(400).json({ ok: false, message: 'Token absent' });
    }

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

    const isSuccess = event === 'payout.session.completed' || event === 'payout.success';
    const isCancelled = event === 'payout.session.cancelled' || event === 'payout.failed';

    if (isSuccess) {
      const { data: updated } = await supabase
        .from('payouts')
        .update({ status: 'paid', completed_at: new Date().toISOString() })
        .eq('provider_token', refToken)
        .select('id, recipient_id, recipient_type, net_amount')
        .maybeSingle();
      if (updated?.recipient_id) {
        const isDriver = updated.recipient_type === 'delivery';
        const amt = Number(updated.net_amount || 0).toLocaleString('fr-FR');
        sendPushToUser(updated.recipient_id, {
          title: '💸 Versement Mobile Money envoyé !',
          body: `Votre virement de ${amt} FCFA a été crédité sur votre compte Mobile Money.`,
          url: isDriver ? '/earnings' : '/mes-paiements',
          tag: `payout-${updated.id}`,
        }, { appType: isDriver ? 'delivery' : 'market' }).catch(() => {});
      }
    } else if (isCancelled) {
      const { data: updated } = await supabase
        .from('payouts')
        .update({ status: 'failed', failure_reason: message || 'Annulé par passerelle de paiement' })
        .eq('provider_token', refToken)
        .select('id, recipient_id, recipient_type, net_amount')
        .maybeSingle();
      if (updated?.recipient_id) {
        const isDriver = updated.recipient_type === 'delivery';
        const amt = Number(updated.net_amount || 0).toLocaleString('fr-FR');
        sendPushToUser(updated.recipient_id, {
          title: '⚠️ Échec du versement Mobile Money',
          body: `Le virement de ${amt} FCFA n'a pas abouti. Vérifiez votre numéro de retrait.`,
          url: isDriver ? '/payout-setup' : '/settings/payout',
          tag: `payout-${updated.id}`,
        }, { appType: isDriver ? 'delivery' : 'market' }).catch(() => {});
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook Payout Exception]:', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
