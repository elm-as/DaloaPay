const express = require('express');
const router = express.Router();
const { ENV, getSupabaseAdminClient } = require('../config/env');
const { requireAuthenticatedUser, requireAdminUser, requireAdminSecret, requireWebhookSecret } = require('../middlewares/auth');
const { broadcastPush, sendPushToUser } = require('../services/push');

function firstPhoto(photos) {
  const first = Array.isArray(photos) ? photos[0] : null;
  return typeof first === 'string' && first.startsWith('http') ? first : null;
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n).trimEnd() + '…' : s || '');
const formatFCFA = (n) => `${Number(n).toLocaleString('fr-FR')} FCFA`;
const orderRef = (id) => `#${String(id).slice(0, 6).toUpperCase()}`;

router.post('/push/broadcast', requireAdminUser, async (req, res) => {
  try {
    const { title, body, url, tag, image, appType } = req.body || {};
    if (!title || !body) return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    const targetApp = appType === 'market' || appType === 'delivery' ? appType : undefined;
    const payload = { title, body, url: url || '/', tag: tag || 'admin-broadcast', image: image || null, icon: '/web-app-manifest-192x192.png' };

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

router.post('/push/notify-user', requireAdminUser, async (req, res) => {
  try {
    const { targetUserId, title, body, url, tag, image, chatPartnerId, listingId, orderId, appType } = req.body || {};
    if (!targetUserId || !title || !body) return res.status(400).json({ success: false, message: 'targetUserId, title et body requis' });

    const payload = {
      title, body, url: url || '/', tag: tag || 'user-notification', image: image || null,
      icon: '/web-app-manifest-192x192.png', chatPartnerId: chatPartnerId || null, listingId: listingId || null, orderId: orderId || null,
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
      const results = await Promise.allSettled(target.map((uid) => sendPushToUser(uid, payload)));
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

router.post('/push/webhook', requireWebhookSecret(ENV.PUSH_WEBHOOK_SECRET, 'x-push-webhook-secret'), async (req, res) => {
  const { type, table, record, old_record } = req.body || {};
  if (!record || !table) return res.status(400).json({ ok: false, error: 'Payload webhook invalide' });

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB indisponible' });

    if (table === 'messages' && type === 'INSERT') {
      const targetUserId = record.receiver_id;
      if (!targetUserId) return res.json({ ok: true, skipped: 'no receiver_id' });

      let senderName = null;
      let senderAvatar = null;
      let listingTitle = null;
      let listingPhoto = null;
      let listingPrice = null;
      let unreadCount = 1;
      try {
        const [senderRes, listingRes, unreadRes] = await Promise.all([
          record.sender_id ? supabase.from('users').select('full_name, shop_name, avatar_url').eq('id', record.sender_id).maybeSingle() : Promise.resolve({ data: null }),
          record.listing_id ? supabase.from('listings').select('title, photos, price').eq('id', record.listing_id).maybeSingle() : Promise.resolve({ data: null }),
          supabase.from('messages').select('id', { count: 'exact', head: true }).eq('sender_id', record.sender_id).eq('receiver_id', targetUserId).eq('read', false),
        ]);
        const shopName = senderRes.data?.shop_name?.trim();
        if (shopName) senderName = shopName;
        else if (senderRes.data?.full_name) senderName = senderRes.data.full_name.split(' ')[0];
        senderAvatar = senderRes.data?.avatar_url || null;
        if (listingRes.data?.title) listingTitle = listingRes.data.title;
        listingPhoto = firstPhoto(listingRes.data?.photos);
        listingPrice = listingRes.data?.price ? String(listingRes.data.price) : null;
        if (unreadRes && typeof unreadRes.count === 'number' && unreadRes.count > 0) unreadCount = unreadRes.count;
      } catch (_) { /* non-bloquant */ }

      const countBadge = unreadCount > 1 ? ` (${unreadCount} messages)` : '';
      const shortListing = truncate(listingTitle, 20) || null;
      const notifTitle = senderName
        ? (shortListing ? `💬 ${senderName} • ${shortListing}${countBadge}` : `💬 ${senderName}${countBadge}`)
        : `💬 Nouveau message${countBadge}`;
      const payload = {
        title: notifTitle,
        body: truncate(record.content, 140) || 'Vous avez reçu un nouveau message.',
        channelId: 'chat',
        url: `/messages/${record.listing_id || 'support'}/${record.sender_id}`,
        tag: `chat-${record.sender_id}`,
        image: null,
        badgeCount: unreadCount,
        chatPartnerId: record.sender_id,
        listingId: record.listing_id || null,
        partnerName: senderName || null,
        partnerAvatar: senderAvatar || null,
        listingTitle: listingTitle || null,
        listingPhoto: listingPhoto || null,
        listingPrice: listingPrice || null,
      };
      const result = await sendPushToUser(targetUserId, payload, { appType: 'market' });
      return res.json({ ok: true, ...result });
    }

    if (table === 'orders' && type === 'UPDATE') {
      const status = record.status;
      const oldStatus = old_record?.status;
      if (status === oldStatus) return res.json({ ok: true, skipped: 'status inchangé' });

      const ref = orderRef(record.id);
      let itemTitle = null;
      let itemPhoto = null;
      if (record.listing_id) {
        try {
          const { data: listing } = await supabase.from('listings').select('title, photos').eq('id', record.listing_id).maybeSingle();
          itemTitle = truncate(listing?.title, 40) || null;
          itemPhoto = firstPhoto(listing?.photos);
        } catch (_) { /* non-bloquant */ }
      }
      const forItem = itemTitle ? `\n📌 ${itemTitle}` : '';
      const isSellerUnavailable = record.cancel_reason === 'unavailable' || record.cancel_reason === 'seller_unavailable';
      const isAdminRefund = String(record.cancel_reason || '').startsWith('admin_refund');

      if (record.buyer_id) {
        let buyerTitle = '📦 Commande mise à jour';
        let buyerMsg = `Votre commande ${ref} a été mise à jour.`;
        if (status === 'paid') {
          buyerTitle = '✅ Commande confirmée !';
          buyerMsg = `Votre commande ${ref} est en préparation.${forItem}`;
        } else if (status === 'in_transit' || status === 'picked_up') {
          buyerTitle = '🛵 Livreur en route !';
          buyerMsg = `Le livreur fait route vers vous avec votre colis ${ref}.${forItem}`;
        } else if (status === 'delivered') {
          buyerTitle = '🎉 Colis livré !';
          buyerMsg = `Votre commande ${ref} a été remise en mains propres.${forItem}\nMerci pour votre confiance ❤️`;
        } else if (status === 'cancelled') {
          buyerTitle = isSellerUnavailable ? '❌ Article indisponible' : isAdminRefund ? '⚖️ Litige réglé' : '❌ Commande annulée';
          const refundText = record.payment_method === 'online' ? '\nLe remboursement Mobile Money est en cours.' : '';
          buyerMsg = isSellerUnavailable
            ? `Le vendeur ne peut pas honorer la commande ${ref}.${forItem}${refundText}`
            : `Votre commande ${ref} a été annulée.${forItem}${refundText}`;
        } else if (status === 'disputed') {
          buyerTitle = '⚠️ Litige ouvert';
          buyerMsg = `Un litige a été ouvert sur la commande ${ref}.${forItem}\nNotre équipe intervient.`;
        }
        await sendPushToUser(record.buyer_id, {
          title: buyerTitle, body: buyerMsg, channelId: 'orders', url: `/suivi/${record.id}`, tag: `order-${record.id}`, image: itemPhoto, orderId: record.id,
        }, { appType: 'market' });
      }

      if (record.seller_id) {
        let sellerTitle = null;
        let sellerMsg = null;
        if (status === 'paid') {
          sellerTitle = '🎉 Nouvelle vente !';
          sellerMsg = `Paiement reçu pour la commande ${ref}.${forItem}\nPréparez le colis pour le livreur. 📦`;
        } else if (status === 'delivered') {
          sellerTitle = '✅ Livraison validée';
          sellerMsg = record.payment_method === 'online'
            ? `Le colis ${ref} a été remis au client.${forItem}\nVotre virement Mobile Money est programmé.`
            : `Le colis ${ref} a été remis au client.${forItem}\nLa commande est clôturée.`;
        } else if (status === 'cancelled' && !isSellerUnavailable) {
          sellerTitle = isAdminRefund ? '⚖️ Litige réglé' : '❌ Commande annulée par le client';
          sellerMsg = isAdminRefund
            ? `Le litige sur la commande ${ref} a été arbitré.${forItem}`
            : `L'acheteur a annulé la commande ${ref} avant expédition.${forItem}\nL'article a été remis en stock.`;
        } else if (status === 'disputed') {
          sellerTitle = '⚠️ Litige ouvert sur une vente';
          sellerMsg = `Un incident a été signalé sur la commande ${ref}.${forItem}\nL'équipe DaloaMarket examine le dossier.`;
        }
        if (sellerMsg) {
          await sendPushToUser(record.seller_id, {
            title: sellerTitle, body: sellerMsg, channelId: 'orders', url: `/suivi/${record.id}`, tag: `order-seller-${record.id}`, image: itemPhoto, orderId: record.id,
          }, { appType: 'market' });
        }
      }

      return res.json({ ok: true });
    }

    if (table === 'delivery_assignments') {
      const status = record.status;
      const oldStatus = old_record?.status;
      const netPrice = record.delivery_price ? Math.round(Number(record.delivery_price) * 0.9) : 0;
      const priceText = netPrice > 0 ? `${formatFCFA(netPrice)} net` : 'Rémunérée';
      const courseUrl = `/course/${record.id}`;
      const isNowAwaitingPickup =
        (type === 'INSERT' && status === 'awaiting_pickup') ||
        (type === 'UPDATE' && status === 'awaiting_pickup' && oldStatus !== 'awaiting_pickup');

      if (isNowAwaitingPickup) {
        if (record.delivery_person_id) {
          const { data: dp } = await supabase.from('delivery_persons').select('user_id').eq('id', record.delivery_person_id).maybeSingle();
          if (dp?.user_id) {
            await sendPushToUser(dp.user_id, {
              title: '🛵 Nouvelle course assignée !',
              body: `Une livraison vous a été confiée à Daloa (${priceText}).\nOuvrez l'application pour démarrer.`,
              url: courseUrl,
              tag: `delivery-assign-${record.id}`,
            }, { appType: 'delivery' });
          }
        } else {
          let drivers = null;
          if (record.is_private) {
            if (record.seller_id) {
              const { data: affiliated } = await supabase
                .from('seller_delivery_affiliations')
                .select('delivery_persons!inner(user_id, is_available, is_verified)')
                .eq('seller_id', record.seller_id)
                .eq('status', 'active');
              drivers = (affiliated || []).map((a) => a.delivery_persons).filter((dp) => dp && dp.is_available && dp.is_verified);
            }
          } else {
            const { data: available } = await supabase
              .from('delivery_persons')
              .select('user_id')
              .eq('is_available', true)
              .eq('is_verified', true);
            drivers = available;
          }

          if (drivers && drivers.length > 0) {
            for (const driver of drivers) {
              if (driver.user_id) {
                sendPushToUser(driver.user_id, {
                  title: `🛵 Course disponible · ${priceText}`,
                  body: `Livraison à Daloa • Premier arrivé, premier servi ! ⚡`,
                  url: courseUrl,
                  tag: `delivery-open-${record.id}`,
                }, { appType: 'delivery' }).catch((err) => console.warn('[Push Delivery Error]:', err));
              }
            }
          }
        }
      } else if (type === 'UPDATE' && (status === 'cancelled' || status === 'disputed') && oldStatus !== status && record.delivery_person_id) {
        const { data: dp } = await supabase.from('delivery_persons').select('user_id').eq('id', record.delivery_person_id).maybeSingle();
        if (dp?.user_id) {
          await sendPushToUser(dp.user_id, {
            title: status === 'cancelled' ? '❌ Course annulée' : '⚠️ Course en litige',
            body: status === 'cancelled'
              ? 'La commande associée a été annulée avant le ramassage. Ne vous déplacez plus.'
              : 'Un incident a été signalé sur cette course. L’équipe DaloaMarket examine le dossier.',
            url: courseUrl,
            tag: `delivery-assign-${record.id}`,
          }, { appType: 'delivery' });
        }
      }

      return res.json({ ok: true });
    }

    return res.json({ ok: true, skipped: `table ${table} non gérée` });
  } catch (err) {
    console.error('[Push Webhook Exception]:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
