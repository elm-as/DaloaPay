const express = require('express');
const router = express.Router();
const { ENV, getSupabaseAdminClient } = require('../config/env');
const { requireAuthenticatedUser, requireAdminUser, requireAdminSecret, requireWebhookSecret } = require('../middlewares/auth');
const { broadcastPush, sendPushToUser } = require('../services/push');

// A. Broadcast vers tous les appareils abonnés (Admin / Annonces globales)
router.post('/push/broadcast', requireAdminUser, async (req, res) => {
  try {
    const { title, body, url, tag, image } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'admin-broadcast',
      image: image || null,
      icon: '/web-app-manifest-192x192.png',
    };

    try {
      const supabase = getSupabaseAdminClient();
      if (supabase) {
        await supabase.from('notifications').insert({ title, body, url: url || null });
      }
    } catch (dbErr) {
      console.warn('[Push Broadcast] Supabase insert warning:', dbErr.message);
    }

    const result = await broadcastPush(payload);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Broadcast Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// B. Notification ciblée pour un utilisateur spécifique
router.post('/push/notify-user', requireAuthenticatedUser, async (req, res) => {
  try {
    const { targetUserId, title, body, url, tag, image, chatPartnerId, listingId, orderId } = req.body || {};
    if (!targetUserId || !title || !body) {
      return res.status(400).json({ success: false, message: 'targetUserId, title et body requis' });
    }

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

    const result = await sendPushToUser(targetUserId, payload);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Notify User Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// C. Endpoint générique /push/send
router.post('/push/send', requireAdminSecret, async (req, res) => {
  try {
    const { target, title, body, url, tag } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'notification',
      icon: '/web-app-manifest-192x192.png',
    };

    if (target === 'all' || !target) {
      const result = await broadcastPush(payload);
      return res.json({ success: true, ...result });
    }

    if (Array.isArray(target)) {
      const results = await Promise.allSettled(target.map((uid) => sendPushToUser(uid, payload)));
      const sentTotal = results.reduce((acc, r) => acc + (r.status === 'fulfilled' && r.value?.sent ? r.value.sent : 0), 0);
      return res.json({ success: true, sent: sentTotal, targets: target.length });
    }

    if (typeof target === 'string') {
      const result = await sendPushToUser(target, payload);
      return res.json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, message: 'Cible invalide' });
  } catch (err) {
    console.error('[Push Send Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// D. Enregistrement d'un token push (Expo Mobile ou Web Push)
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
        {
          user_id,
          expo_push_token,
          app_type: app_type || 'market',
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,expo_push_token' }
      );

      if (error && error.code !== '23505') {
        console.error('[Push Register Expo] ❌ Erreur insertion Supabase:', error.message);
        return res.status(500).json({ success: false, message: error.message });
      }

      console.log(`[Push Register Expo] ✅ Token Expo enregistré pour user ${user_id} (${app_type || 'market'})`);
      return res.json({ success: true, type: 'expo' });
    }

    // `app_type` et `is_active` étaient omis ici : un abonnement web était donc
    // rangé par défaut avec les acheteurs ('market'). Un livreur qui s'abonnait
    // depuis le tableau de bord web restait invisible pour tout envoi ciblé
    // 'delivery'.
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id,
        endpoint,
        keys_p256dh,
        keys_auth,
        user_agent: user_agent || null,
        app_type: app_type || 'market',
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,endpoint' }
    );

    if (error) {
      if (error.code === '23505') {
        return res.json({ success: true, duplicate: true });
      }
      console.error('[Push Register] ❌ Erreur insertion Supabase:', error.message);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log(`[Push Register] ✅ Token Web enregistré pour user ${user_id} (endpoint: ${endpoint.slice(0, 60)}...)`);
    return res.json({ success: true, type: 'web' });
  } catch (err) {
    console.error('[Push Register] Exception:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// E. Webhook Supabase Database Trigger
router.post('/push/webhook', requireWebhookSecret(ENV.PUSH_WEBHOOK_SECRET, 'x-push-webhook-secret'), async (req, res) => {
  if (!ENV.VAPID_PUBLIC_KEY || !ENV.VAPID_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'Push VAPID keys non configurées' });
  }

  const { type, table, record, old_record } = req.body || {};
  if (!record || !table) {
    return res.status(400).json({ ok: false, error: 'Payload webhook invalide' });
  }

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB indisponible' });

    // 1. Messages du chat
    if (table === 'messages' && type === 'INSERT') {
      const targetUserId = record.receiver_id;
      if (!targetUserId) return res.json({ ok: true, skipped: 'no receiver_id' });

      let senderName = null;
      let listingTitle = null;
      try {
        const [senderRes, listingRes] = await Promise.all([
          record.sender_id
            ? supabase.from('users').select('full_name').eq('id', record.sender_id).maybeSingle()
            : Promise.resolve({ data: null }),
          record.listing_id
            ? supabase.from('listings').select('title').eq('id', record.listing_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        if (senderRes.data?.full_name) senderName = senderRes.data.full_name.split(' ')[0];
        if (listingRes.data?.title) listingTitle = listingRes.data.title;
      } catch (_) { /* non-bloquant */ }

      const shortListing = listingTitle ? (listingTitle.length > 28 ? listingTitle.slice(0, 28) + '…' : listingTitle) : null;
      const notifTitle = senderName ? (shortListing ? `💬 ${senderName} • ${shortListing}` : `💬 Message de ${senderName}`) : '💬 Nouveau message';
      const notifBody = (record.content || '').length > 100 ? (record.content || '').slice(0, 100) + '…' : (record.content || 'Vous avez reçu un nouveau message.');

      const payload = {
        title: notifTitle,
        body: notifBody,
        channelId: 'chat',
        url: `/messages/${record.listing_id || 'inbox'}/${record.sender_id}`,
        tag: `chat-${record.sender_id}`,
        chatPartnerId: record.sender_id,
        listingId: record.listing_id || null,
      };

      const result = await sendPushToUser(targetUserId, payload);
      return res.json({ ok: true, ...result });
    }

    // 2. Statuts de commande (Acheteur + Vendeur)
    if (table === 'orders' && type === 'UPDATE') {
      const status = record.status;
      const oldStatus = old_record?.status;
      if (status === oldStatus) return res.json({ ok: true, skipped: 'status inchangé' });

      if (record.buyer_id) {
        let buyerTitle = '📦 Commande mise à jour';
        let buyerMsg = 'Votre commande a été mise à jour.';
        if (status === 'paid') {
          buyerTitle = '✅ Paiement confirmé !';
          buyerMsg = 'Votre commande est en cours de préparation. Vous serez notifié dès la prise en charge.';
        } else if (status === 'in_transit' || status === 'picked_up') {
          // `orders.status` ne contient pas 'picked_up' : verify_pickup écrit
          // 'in_transit'. Cette branche ne se déclenchait donc jamais.
          buyerTitle = '🛵 Livreur en route !';
          buyerMsg = 'Votre colis a été récupéré. Le livreur fait route vers vous.';
        } else if (status === 'delivered') {
          buyerTitle = '🎉 Colis livré !';
          buyerMsg = 'Livraison effectuée avec succès. Merci pour votre confiance ❤️';
        } else if (status === 'disputed') {
          buyerTitle = '⚠️ Litige ouvert';
          buyerMsg = 'Un litige a été ouvert sur votre commande. Notre équipe intervient.';
        }

        await sendPushToUser(record.buyer_id, {
          title: buyerTitle,
          body: buyerMsg,
          channelId: 'orders',
          url: `/suivi/${record.id}`,
          tag: `order-${record.id}`,
          orderId: record.id,
        });
      }

      if (record.seller_id) {
        let sellerTitle = null;
        let sellerMsg = null;
        if (status === 'paid') {
          sellerTitle = '🎉 Nouvelle vente !';
          sellerMsg = 'Paiement reçu ! Préparez le colis pour le livreur. 📦';
        } else if (status === 'delivered') {
          sellerTitle = '✅ Livraison validée';
          sellerMsg = 'Votre colis a été remis. Vos gains seront disponibles sous 24h.';
        }

        if (sellerMsg) {
          await sendPushToUser(record.seller_id, {
            title: sellerTitle,
            body: sellerMsg,
            channelId: 'orders',
            url: '/mes-commandes',
            tag: `order-seller-${record.id}`,
            orderId: record.id,
          });
        }
      }

      return res.json({ ok: true });
    }

    // 3. Courses et Livraisons
    if (table === 'delivery_assignments') {
      const status = record.status;
      const oldStatus = old_record?.status;
      const priceText = record.delivery_price ? `${Number(record.delivery_price).toLocaleString('fr-FR')} FCFA` : 'Rémunérée';
      const orderUrl = `/suivi/${record.order_id}`;

      if (type === 'INSERT' || (type === 'UPDATE' && status === 'awaiting_pickup' && oldStatus !== 'awaiting_pickup')) {
        if (record.delivery_person_id) {
          const { data: dp } = await supabase.from('delivery_persons').select('user_id').eq('id', record.delivery_person_id).maybeSingle();
          if (dp?.user_id) {
            await sendPushToUser(dp.user_id, {
              title: '🛵 Nouvelle course assignée !',
              body: `Une livraison vous a été confiée à Daloa (${priceText}). Ouvrez l'application pour démarrer.`,
              url: orderUrl,
              tag: `delivery-assign-${record.id}`,
            });
          }
        } else {
          // Course privée (paiement espèces) : elle est réservée aux livreurs
          // affiliés au vendeur. Elle ne notifiait personne du tout, alors
          // qu'elle attend elle aussi un preneur.
          let drivers = null;
          if (record.is_private) {
            if (record.seller_id) {
              const { data: affiliated } = await supabase
                .from('seller_delivery_affiliations')
                .select('delivery_persons!inner(user_id, is_available)')
                .eq('seller_id', record.seller_id)
                .eq('status', 'active');
              drivers = (affiliated || [])
                .map((a) => a.delivery_persons)
                .filter((dp) => dp && dp.is_available);
            }
          } else {
            const { data: available } = await supabase
              .from('delivery_persons')
              .select('user_id')
              .eq('is_available', true);
            drivers = available;
          }

          if (drivers && drivers.length > 0) {
            for (const driver of drivers) {
              if (driver.user_id) {
                sendPushToUser(driver.user_id, {
                  title: '🛵 Nouvelle course disponible !',
                  body: `Livraison à Daloa • Gain : ${priceText}. Premier arrivé, premier servi ! ⚡`,
                  url: orderUrl,
                  tag: `delivery-open-${record.id}`,
                }).catch((err) => console.warn('[Push Delivery Error]:', err));
              }
            }
          }
        }
      }

      // Idem : verify_pickup fait passer l'assignation en 'in_transit'.
      const isTransit = (s) => s === 'in_transit' || s === 'picked_up';
      if (type === 'UPDATE' && isTransit(status) && !isTransit(oldStatus)) {
        const { data: order } = await supabase.from('orders').select('buyer_id').eq('id', record.order_id).maybeSingle();
        if (order?.buyer_id) {
          await sendPushToUser(order.buyer_id, {
            title: '🚚 Votre livreur est en route !',
            body: 'Le livreur a récupéré votre colis et fait route vers votre adresse.',
            url: orderUrl,
            tag: `order-transit-${record.order_id}`,
          });
        }
      }

      if (type === 'UPDATE' && status === 'delivered' && oldStatus !== 'delivered') {
        const { data: order } = await supabase.from('orders').select('buyer_id, seller_id').eq('id', record.order_id).maybeSingle();
        if (order?.buyer_id) {
          await sendPushToUser(order.buyer_id, {
            title: '📦 Colis arrivé !',
            body: 'Votre livreur est là. Communiquez votre code OTP pour valider la livraison.',
            url: orderUrl,
            tag: `order-delivered-${record.order_id}`,
          });
        }
        if (order?.seller_id) {
          await sendPushToUser(order.seller_id, {
            title: '✅ Livraison effectuée !',
            body: 'Le colis a été remis à l\'acheteur avec succès.',
            url: '/mes-commandes',
            tag: `seller-delivered-${record.order_id}`,
          });
        }
      }

      return res.json({ ok: true });
    }

    return res.json({ ok: true, skipped: 'unhandled table/type' });
  } catch (err) {
    console.error('[Push Webhook Exception]:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
