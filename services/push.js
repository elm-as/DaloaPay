const webpush = require('web-push');
const { ENV, getSupabaseAdminClient } = require('../config/env');

const VAPID_CONFIGURED = Boolean(ENV.VAPID_PUBLIC_KEY && ENV.VAPID_PRIVATE_KEY);

if (VAPID_CONFIGURED) {
  try {
    webpush.setVapidDetails(ENV.VAPID_SUBJECT, ENV.VAPID_PUBLIC_KEY, ENV.VAPID_PRIVATE_KEY);
    console.log('[WebPush] VAPID configured successfully from env');
  } catch (vapidErr) {
    console.error('[WebPush] Error setting VAPID details:', vapidErr);
  }
} else {
  console.warn('[WebPush Warning] VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing from environment variables.');
}

async function sendExpoPush(expoPushToken, payload) {
  try {
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) {
      return { success: false, message: 'Format token Expo invalide' };
    }

    let chatPartnerId = payload.chatPartnerId || null;
    let listingId = payload.listingId || null;
    let orderId = payload.orderId || null;

    if (payload.url) {
      if (!chatPartnerId && payload.url.includes('/messages/')) {
        const parts = payload.url.split('/messages/')[1].split('/').filter(Boolean);
        if (parts.length >= 2) {
          listingId = listingId || parts[0];
          chatPartnerId = parts[1];
        } else if (parts.length === 1) {
          chatPartnerId = parts[0];
        }
      }

      if (!orderId) {
        if (payload.url.includes('/suivi/')) {
          orderId = payload.url.split('/suivi/')[1].split('/')[0] || null;
        } else if (payload.url.includes('/order/')) {
          orderId = payload.url.split('/order/')[1].split('/')[0] || null;
        }
      }
    }

    const expoMessage = {
      to: expoPushToken,
      sound: 'default',
      title: payload.title,
      subtitle: payload.subtitle || undefined,
      body: payload.body,
      data: {
        url: payload.url || '/',
        tag: payload.tag,
        orderId,
        chatPartnerId,
        listingId,
      },
      priority: 'high',
      channelId: payload.channelId || 'default',
    };

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(expoMessage),
    });

    const data = await res.json();
    if (data?.data?.status === 'ok') {
      return { success: true };
    } else {
      console.warn('[ExpoPush] Push send warning:', data?.data?.message || data?.errors);
      return { success: false, error: data?.data?.message };
    }
  } catch (err) {
    console.error('[ExpoPush] Exception:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendWebPush(subscription, payload) {
  try {
    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys_p256dh,
        auth: subscription.keys_auth,
      },
    };
    const stringPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await webpush.sendNotification(pushSubscription, stringPayload);
    return { success: true };
  } catch (err) {
    const status = err.statusCode || err.status;
    const body = err.body || err.message;
    console.error(`[WebPush] Error (${status}): ${body} (endpoint: ${subscription.endpoint?.slice(0, 50)}...)`);

    if (status === 401 || status === 403 || status === 404 || status === 410) {
      console.log(`[WebPush] Cleaning up invalid/stale subscription (${status})`);
      try {
        const supabase = getSupabaseAdminClient();
        if (supabase) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        }
      } catch (delErr) {
        console.error('[WebPush] Error deleting invalid subscription:', delErr);
      }
    }
    return { success: false, error: err.message, statusCode: status };
  }
}

async function dispatchPush(sub, payload) {
  if (sub.expo_push_token) {
    return sendExpoPush(sub.expo_push_token, payload);
  } else if (sub.endpoint) {
    // Sans clés VAPID, seul le web push est impossible : les apps (Expo) restent servies.
    if (!VAPID_CONFIGURED) return { success: false, message: 'Clés VAPID absentes' };
    return sendWebPush(sub, payload);
  }
  return { success: false, message: 'Aucun token valide' };
}

/**
 * @param {object} [options]
 * @param {'market'|'delivery'} [options.appType] Limite l'envoi aux abonnements
 *   de cette application. Sans ce filtre, une notification de course partait
 *   aussi dans l'app DaloaMarket d'un livreur (et inversement), avec un lien
 *   que l'autre application ne sait pas ouvrir.
 */
async function sendPushToUser(userId, payload, options = {}) {
  if (!userId) return { success: false, message: 'Identifiant utilisateur requis' };
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return { success: false, message: 'DB indisponible' };

    const { data: allSubs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error(`[Push] Erreur DB pour user ${userId}:`, error.message);
      return { success: false, error: error.message };
    }

    const subs = options.appType
      ? (allSubs || []).filter((sub) => (sub.app_type || 'market') === options.appType)
      : allSubs;

    if (!subs || subs.length === 0) {
      return { success: true, sent: 0, message: 'Aucun abonnement push trouvé pour cet utilisateur' };
    }

    const expoSubsByApp = new Map();
    for (const sub of subs) {
      if (sub.expo_push_token) {
        const appKey = sub.app_type || 'market';
        if (!expoSubsByApp.has(appKey)) {
          expoSubsByApp.set(appKey, sub);
        }
      }
    }

    const hasExpo = expoSubsByApp.size > 0;
    const uniqueSubs = Array.from(expoSubsByApp.values());

    const seenEndpoints = new Set();
    for (const sub of subs) {
      if (sub.endpoint && !seenEndpoints.has(sub.endpoint)) {
        seenEndpoints.add(sub.endpoint);
        const isMobileWeb = sub.user_agent && (sub.user_agent.includes('Android') || sub.user_agent.includes('Mobile'));
        if (hasExpo && isMobileWeb) {
          continue;
        }
        uniqueSubs.push(sub);
      }
    }

    const results = await Promise.allSettled(uniqueSubs.map((sub) => dispatchPush(sub, payload)));
    const sentCount = results.filter((r) => r.status === 'fulfilled' && r.value?.success).length;
    return { success: true, sent: sentCount, total: uniqueSubs.length };
  } catch (err) {
    console.error('[Push] sendPushToUser failed:', err);
    return { success: false, error: err.message };
  }
}

/**
 * @param {object} [options]
 * @param {'market'|'delivery'} [options.appType] Limite la diffusion aux
 *   abonnés d'une application. L'admin proposait un choix d'audience qui
 *   n'était jamais transmis : tout partait à tout le monde.
 */
async function broadcastPush(payload, options = {}) {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return { success: false, message: 'DB indisponible' };

    let query = supabase
      .from('push_subscriptions')
      .select('*')
      .eq('is_active', true);
    if (options.appType) query = query.eq('app_type', options.appType);
    const { data: subs, error } = await query.order('updated_at', { ascending: false });

    if (error || !subs || subs.length === 0) {
      return { success: true, sent: 0, message: 'Aucun abonnement push actif trouvé' };
    }

    const usersWithExpo = new Set();
    const expoSubsByUserApp = new Map();
    for (const sub of subs) {
      if (sub.expo_push_token) {
        const key = `${sub.user_id}_${sub.app_type || 'market'}`;
        if (!expoSubsByUserApp.has(key)) {
          expoSubsByUserApp.set(key, sub);
          usersWithExpo.add(sub.user_id);
        }
      }
    }

    const uniqueSubs = Array.from(expoSubsByUserApp.values());
    const seenEndpoints = new Set();
    for (const sub of subs) {
      if (sub.endpoint && !seenEndpoints.has(sub.endpoint)) {
        seenEndpoints.add(sub.endpoint);
        const isMobileWeb = sub.user_agent && (sub.user_agent.includes('Android') || sub.user_agent.includes('Mobile'));
        if (usersWithExpo.has(sub.user_id) && isMobileWeb) {
          continue;
        }
        uniqueSubs.push(sub);
      }
    }

    const results = await Promise.allSettled(uniqueSubs.map((sub) => dispatchPush(sub, payload)));
    const sentCount = results.filter((r) => r.status === 'fulfilled' && r.value?.success).length;
    return { success: true, sent: sentCount, total: uniqueSubs.length };
  } catch (err) {
    console.error('[Push] broadcastPush failed:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendExpoPush,
  sendWebPush,
  dispatchPush,
  sendPushToUser,
  broadcastPush,
};
