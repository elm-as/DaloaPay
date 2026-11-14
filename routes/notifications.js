const express = require('express');
const router = express.Router();
const { getSupabaseAdminClient } = require('../config/env');
const { requireAuthenticatedUser, requireAdminUser, requireAdminSecret } = require('../middlewares/auth');
const { broadcastPush, sendPushToUser } = require('../services/push');
const { VALID_SEGMENTS, executeSegmentedPushCampaign } = require('../services/push-campaigns');
const { DEFAULT_PUSH_CONCURRENCY, runWithConcurrency } = require('../services/push-dispatch-batch');

const SEGMENT_LABELS = {
  dormant: 'Inactifs',
  active_seller: 'Vendeurs',
  seller_no_promo: 'Vendeurs sans promo',
  buyer_cancelled: 'Acheteurs relance',
};

router.post('/push/broadcast', requireAdminUser, async (req, res) => {
  try {
    const { title, body, url, tag, image, appType, dryRun } = req.body || {};
    if (!title || !body) return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    const targetApp = appType === 'market' || appType === 'delivery' ? appType : undefined;
    const payload = { title, body, url: url || '/', tag: tag || 'admin-broadcast', image: image || null, icon: '/web-app-manifest-192x192.png' };

    if (dryRun) {
      const preview = await broadcastPush(payload, { appType: targetApp, dryRun: true });
      return res.json(preview);
    }

    try {
      const supabase = getSupabaseAdminClient();
      if (supabase) await supabase.from('notifications').insert({ title, body, url: url || null });
    } catch (dbErr) {
      console.warn('[Push Broadcast] Supabase insert warning:', dbErr.message);
    }

    const result = await broadcastPush(payload, { appType: targetApp });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Broadcast Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/push/campaign', requireAdminUser, async (req, res) => {
  try {
    const { segment, title, body, url, dryRun } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }
    if (!VALID_SEGMENTS.includes(segment)) {
      return res.status(400).json({
        success: false,
        message: `Segment cible invalide (${VALID_SEGMENTS.join(' | ')})`,
      });
    }

    const result = await executeSegmentedPushCampaign({
      segment,
      title,
      body,
      url: url || '/',
      dryRun: Boolean(dryRun),
    });

    if (!dryRun && result.sent > 0) {
      try {
        const supabase = getSupabaseAdminClient();
        if (supabase) {
          await supabase.from('notifications').insert({
            title: `[${SEGMENT_LABELS[segment] || segment}] ${title}`,
            body,
            url: url || null,
          });
        }
      } catch (dbErr) {
        console.warn('[Push Campaign] Supabase insert warning:', dbErr.message);
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('[Push Campaign Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/push/notify-user', requireAdminUser, async (req, res) => {
  try {
    const { targetUserId, title, body, url, tag, image, chatPartnerId, listingId, orderId, appType } = req.body || {};
    if (!targetUserId || !title || !body) return res.status(400).json({ success: false, message: 'targetUserId, title et body requis' });

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'user-notification',
      image: image || null,
      icon: '/web-app-manifest-192x192.png',
      chatPartnerId: chatPartnerId || null,
      listingId: listingId || null,
      orderId: orderId || null,
    };
    const result = await sendPushToUser(targetUserId, payload, {
      appType: appType === 'delivery' || appType === 'market' ? appType : undefined,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Notify User Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/push/send', requireAdminSecret, async (req, res) => {
  try {
    const { target, title, body, url, tag } = req.body || {};
    if (!title || !body) return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    const payload = { title, body, url: url || '/', tag: tag || 'notification', icon: '/web-app-manifest-192x192.png' };

    if (target === 'all' || !target) return res.json({ success: true, ...(await broadcastPush(payload)) });
    if (Array.isArray(target)) {
      const results = await runWithConcurrency(
        target,
        (uid) => sendPushToUser(uid, payload),
        DEFAULT_PUSH_CONCURRENCY
      );
      const sentTotal = results.reduce((acc, r) => acc + (r.status === 'fulfilled' && r.value?.sent ? r.value.sent : 0), 0);
      return res.json({ success: true, sent: sentTotal, targets: target.length });
    }
    if (typeof target === 'string') return res.json({ success: true, ...(await sendPushToUser(target, payload)) });
    return res.status(400).json({ success: false, message: 'Cible invalide' });
  } catch (err) {
    console.error('[Push Send Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/push/register', requireAuthenticatedUser, async (req, res) => {
  try {
    const { expo_push_token, app_type, endpoint, keys_p256dh, keys_auth, user_agent } = req.body || {};
    const user_id = req.user.id;
    if (!expo_push_token && (!endpoint || !keys_p256dh || !keys_auth)) {
      return res.status(400).json({ success: false, message: 'Champs requis manquants: expo_push_token OU endpoint/keys' });
    }

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    if (expo_push_token) {
      const { error } = await supabase.from('push_subscriptions').upsert(
        { user_id, expo_push_token, app_type: app_type || 'market', is_active: true, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,expo_push_token' }
      );
      if (error && error.code !== '23505') return res.status(500).json({ success: false, message: error.message });
      return res.json({ success: true, type: 'expo' });
    }

    const { error } = await supabase.from('push_subscriptions').upsert(
      { user_id, endpoint, keys_p256dh, keys_auth, user_agent: user_agent || null, app_type: app_type || 'market', is_active: true, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,endpoint' }
    );
    if (error && error.code !== '23505') return res.status(500).json({ success: false, message: error.message });
    return res.json({ success: true, type: 'web' });
  } catch (err) {
    console.error('[Push Register] Exception:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
