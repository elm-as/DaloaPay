const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient, secretMatches } = require('../config/env');
const { payoutLimiter } = require('../config/rate-limiters');
const { allowSecretOrAuthenticatedUser, requireWebhookSecret } = require('../middlewares/auth');
const { sendWithdraw } = require('../services/moneyfusion');

// 3) Traitement des Payouts (peut être appelé par un cron ou tire-et-oublie post-livraison)
router.get('/process-payouts', allowSecretOrAuthenticatedUser, payoutLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const secretCandidate = req.get('x-admin-secret') || req.query.secret || req.query.key || req.query.token;
    let isAdminCall = Boolean(ENV.ADMIN_SECRET) && secretMatches(secretCandidate, ENV.ADMIN_SECRET);

    // Si pas de secret machine, vérifier si l'utilisateur connecté via JWT est admin/superadmin
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

    // Si l'admin demande également de réinjecter les échecs dans la file d'attente
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

    const results = [];
    const MONEYFUSION_PRIVATE_KEY = ENV.MONEYFUSION_PRIVATE_KEY;
    if (!MONEYFUSION_PRIVATE_KEY) {
      return res.status(500).json({ success: false, message: 'La clé privée MONEYFUSION_PRIVATE_KEY est manquante dans les variables d\'environnement.' });
    }

    for (const payout of payouts) {
      if (!payout.withdraw_mode) {
        results.push({ id: payout.id, status: 'skipped', reason: 'withdraw_mode manquant' });
        continue;
      }

      // Verrouillage atomique en base (P0 Sécurité - Concurrence et multi-instances)
      const { data: locked, error: lockErr } = await supabase
        .from('payouts')
        .update({
          status: 'processing',
        })
        .eq('id', payout.id)
        .eq('status', 'pending')
        .select('id');

      if (lockErr) {
        console.error(`[Payout Error] Échec de verrouillage DB pour payout ${payout.id}:`, lockErr);
        results.push({ id: payout.id, status: 'skipped', reason: 'db_lock_error' });
        continue;
      }

      if (!locked || locked.length === 0) {
        results.push({ id: payout.id, status: 'skipped', reason: 'already_processing_or_claimed' });
        continue;
      }

      try {
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
          const { error: updateErr } = await supabase
            .from('payouts')
            .update({ provider_token: result.tokenPay })
            .eq('id', payout.id);
          if (updateErr) console.error('[Payout DB Warning] Échec mise à jour provider_token:', updateErr);
          results.push({ id: payout.id, status: 'processing', token: result.tokenPay });
        } else {
          const { error: updateErr } = await supabase
            .from('payouts')
            .update({
              status: 'failed',
              failure_reason: result.message || 'Erreur API MoneyFusion',
            })
            .eq('id', payout.id);
          if (updateErr) console.error('[Payout DB Error] Échec mise à jour status failed:', updateErr);
          results.push({ id: payout.id, status: 'failed', reason: result.message });
        }
      } catch (err) {
        const { error: updateErr } = await supabase
          .from('payouts')
          .update({
            status: 'failed',
            failure_reason: err.message || 'Exception réseau',
          })
          .eq('id', payout.id);
        if (updateErr) console.error('[Payout DB Error] Échec mise à jour exception réseau:', updateErr);
        results.push({ id: payout.id, status: 'failed', reason: err.message });
      }
    }

    return res.json({ success: true, processed: payouts.length, results });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 3.bis) Réessayer un payout individuel échoué (admin ou secret machine)
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
      return res.status(403).json({ success: false, message: "Action réservée aux administrateurs." });
    }

    const payoutId = req.params.id;
    const { data: payout, error: fetchErr } = await supabase
      .from('payouts')
      .select('*')
      .eq('id', payoutId)
      .maybeSingle();

    if (fetchErr || !payout) {
      return res.status(404).json({ success: false, message: 'Versement introuvable' });
    }

    // Remettre le statut à pending et effacer la raison d'échec
    const { error: resetErr } = await supabase
      .from('payouts')
      .update({ status: 'pending', failure_reason: null })
      .eq('id', payoutId);

    if (resetErr) throw resetErr;

    return res.json({ success: true, message: 'Versement réinitialisé en attente avec succès.' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 4) Webhook pour le résultat des Payouts (envoyé par MoneyFusion)
router.post('/payout-webhook', requireWebhookSecret(ENV.PAYOUT_WEBHOOK_SECRET, 'x-payout-webhook-secret'), async (req, res) => {
  console.log('[Webhook Payout Received] Payload:', JSON.stringify(req.body));
  try {
    checkConfig();
    const { event, tokenPay, message } = req.body;

    if (!tokenPay) {
      console.warn('[Webhook Payout Warning] Token is missing');
      return res.status(400).json({ ok: false, message: 'Token absent' });
    }

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

    if (event === 'payout.session.completed') {
      console.log(`[Webhook Payout Success] Updating payout for token: ${tokenPay} to status 'paid'`);

      let updatedRows = null;
      let attempts = 0;

      while (attempts < 5) {
        const { data, error } = await supabase
          .from('payouts')
          .update({ status: 'paid', completed_at: new Date().toISOString() })
          .eq('provider_token', tokenPay)
          .select();

        if (error) {
          console.error('[Webhook Payout Error] Database update failed:', error);
          break;
        }

        if (data && data.length > 0) {
          updatedRows = data;
          break;
        }

        attempts++;
        console.log(`[Webhook Payout Success] Payout row not found/updated yet (attempt ${attempts}/5). Retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (updatedRows) {
        console.log('[Webhook Payout Success] Database updated successfully.');
      } else {
        console.warn('[Webhook Payout Warning] Payout row was NOT updated (not found after 5 attempts).');
      }
    } else if (event === 'payout.session.cancelled') {
      console.log(`[Webhook Payout Cancelled] Updating payout for token: ${tokenPay} to status 'failed'`);

      let updatedRows = null;
      let attempts = 0;

      while (attempts < 5) {
        const { data, error } = await supabase
          .from('payouts')
          .update({ status: 'failed', failure_reason: message || 'Annulé par MoneyFusion' })
          .eq('provider_token', tokenPay)
          .select();

        if (error) {
          console.error('[Webhook Payout Error] Database update failed:', error);
          break;
        }

        if (data && data.length > 0) {
          updatedRows = data;
          break;
        }

        attempts++;
        console.log(`[Webhook Payout Cancelled] Payout row not found/updated yet (attempt ${attempts}/5). Retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (updatedRows) {
        console.log('[Webhook Payout Cancelled] Database updated successfully.');
      } else {
        console.warn('[Webhook Payout Warning] Payout row was NOT updated (not found after 5 attempts).');
      }
    } else {
      console.warn('[Webhook Payout Warning] Unknown event type:', event);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook Payout Exception]:', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
