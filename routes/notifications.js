const express = require('express');
const router = express.Router();
const { ENV, getSupabaseAdminClient } = require('../config/env');
const { requireAuthenticatedUser, requireAdminUser, requireAdminSecret, requireWebhookSecret } = require('../middlewares/auth');
const { broadcastPush, sendPushToUser } = require('../services/push');

/** Première photo d'une annonce (URL publique), ou null. */
function firstPhoto(photos) {
  const first = Array.isArray(photos) ? photos[0] : null;
  return typeof first === 'string' && first.startsWith('http') ? first : null;
}

// A. Broadcast vers tous les appareils abonnés (Admin / Annonces globales)
router.post('/push/broadcast', requireAdminUser, async (req, res) => {
  try {
    const { title, body, url, tag, image, appType } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }
    const targetApp = appType === 'market' || appType === 'delivery' ? appType : undefined;

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

    const result = await broadcastPush(payload, { appType: targetApp });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Broadcast Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// B. Notification ciblée pour un utilisateur spécifique — administration uniquement.
// Elle était ouverte à tout utilisateur connecté, avec titre, texte et lien
// libres : n'importe qui pouvait envoyer une fausse notification à n'importe
// quel compte. Les notifications de chat sont émises par la base (trigger
// push_webhook_messages → /push/webhook), à partir du vrai message.
router.post('/push/notify-user', requireAdminUser, async (req, res) => {
  try {
    const { targetUserId, title, body, url, tag, image, chatPartnerId, listingId, orderId, appType } = req.body || {};
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

    const result = await sendPushToUser(targetUserId, payload, {
      appType: appType === 'delivery' || appType === 'market' ? appType : undefined,
    });
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
  // Pas de refus global sans clés VAPID : elles ne servent qu'au web push, les
  // apps (Expo) doivent continuer à recevoir leurs notifications.
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
      let listingPhoto = null;
      try {
        const [senderRes, listingRes] = await Promise.all([
          record.sender_id
            ? supabase.from('users').select('full_name, shop_name').eq('id', record.sender_id).maybeSingle()
            : Promise.resolve({ data: null }),
          record.listing_id
            ? supabase.from('listings').select('title, photos').eq('id', record.listing_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        // Un vendeur apparaît sous le nom de sa boutique, comme dans le chat.
        const shopName = senderRes.data?.shop_name?.trim();
        if (shopName) senderName = shopName;
        else if (senderRes.data?.full_name) senderName = senderRes.data.full_name.split(' ')[0];
        if (listingRes.data?.title) listingTitle = listingRes.data.title;
        listingPhoto = firstPhoto(listingRes.data?.photos);
      } catch (_) { /* non-bloquant */ }

      const shortListing = listingTitle ? (listingTitle.length > 28 ? listingTitle.slice(0, 28) + '…' : listingTitle) : null;
      const notifTitle = senderName ? (shortListing ? `💬 ${senderName} • ${shortListing}` : `💬 Message de ${senderName}`) : '💬 Nouveau message';
      const notifBody = (record.content || '').length > 100 ? (record.content || '').slice(0, 100) + '…' : (record.content || 'Vous avez reçu un nouveau message.');

      const payload = {
        title: notifTitle,
        body: notifBody,
        channelId: 'chat',
        // Sans annonce : conversation support (le web ne connaît pas « inbox »).
        url: `/messages/${record.listing_id || 'support'}/${record.sender_id}`,
        tag: `chat-${record.sender_id}`,
        image: listingPhoto,
        chatPartnerId: record.sender_id,
        listingId: record.listing_id || null,
      };

      const result = await sendPushToUser(targetUserId, payload, { appType: 'market' });
      return res.json({ ok: true, ...result });
    }

    // 2. Statuts de commande (Acheteur + Vendeur)
    if (table === 'orders' && type === 'UPDATE') {
      const status = record.status;
      const oldStatus = old_record?.status;
      if (status === oldStatus) return res.json({ ok: true, skipped: 'status inchangé' });

      // Article concerné : son titre personnalise le texte, sa photo s'affiche
      // en grand dans la notification web.
      let itemTitle = null;
      let itemPhoto = null;
      if (record.listing_id) {
        try {
          const { data: listing } = await supabase
            .from('listings').select('title, photos').eq('id', record.listing_id).maybeSingle();
          itemTitle = listing?.title ? (listing.title.length > 40 ? listing.title.slice(0, 40) + '…' : listing.title) : null;
          itemPhoto = firstPhoto(listing?.photos);
        } catch (_) { /* non-bloquant */ }
      }
      const forItem = itemTitle ? ` « ${itemTitle} »` : '';

      if (record.buyer_id) {
        let buyerTitle = '📦 Commande mise à jour';
        let buyerMsg = 'Votre commande a été mise à jour.';
        if (status === 'paid') {
          buyerTitle = '✅ Paiement confirmé !';
          buyerMsg = `Votre commande${forItem} est en préparation. Vous serez notifié dès la prise en charge.`;
        } else if (status === 'in_transit' || status === 'picked_up') {
          // `orders.status` ne contient pas 'picked_up' : verify_pickup écrit
          // 'in_transit'. Cette branche ne se déclenchait donc jamais.
          buyerTitle = '🛵 Livreur en route !';
          buyerMsg = 'Votre colis a été récupéré. Le livreur fait route vers vous.';
        } else if (status === 'delivered') {
          buyerTitle = '🎉 Colis livré !';
          buyerMsg = `Votre commande${forItem} a été remise. Merci pour votre confiance ❤️`;
        } else if (status === 'cancelled') {
          // S'affichait « Commande mise à jour » : l'acheteur ne savait pas
          // que sa commande était annulée.
          buyerTitle = '❌ Commande annulée';
          buyerMsg = record.payment_method === 'online'
            ? `Votre commande${forItem} a été annulée. Le remboursement Mobile Money est en cours.`
            : `Votre commande${forItem} a été annulée.`;
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
          image: itemPhoto,
          orderId: record.id,
        }, { appType: 'market' });
      }

      if (record.seller_id) {
        let sellerTitle = null;
        let sellerMsg = null;
        if (status === 'paid') {
          sellerTitle = '🎉 Nouvelle vente !';
          sellerMsg = `Paiement reçu pour${forItem || ' votre article'} : préparez le colis. 📦`;
        } else if (status === 'delivered') {
          sellerTitle = '✅ Livraison validée';
          // En espèces, le vendeur a déjà encaissé : aucun virement à annoncer.
          sellerMsg = record.payment_method === 'online'
            ? 'Votre colis a été remis. Votre virement Mobile Money est programmé.'
            : 'Votre colis a été remis. La commande est clôturée.';
        }

        if (sellerMsg) {
          await sendPushToUser(record.seller_id, {
            title: sellerTitle,
            body: sellerMsg,
            channelId: 'orders',
            url: '/mes-commandes',
            tag: `order-seller-${record.id}`,
            image: itemPhoto,
            orderId: record.id,
          }, { appType: 'market' });
        }
      }

      return res.json({ ok: true });
    }

    // 3. Courses et Livraisons
    if (table === 'delivery_assignments') {
      const status = record.status;
      const oldStatus = old_record?.status;
      const priceText = record.delivery_price ? `${Number(record.delivery_price).toLocaleString('fr-FR')} FCFA` : 'Rémunérée';
      // Lien ouvert par le site livreur (/course/:id). L'app livreur, elle,
      // route sur le `tag` (delivery-assign-<id> / delivery-open-<id>).
      const courseUrl = `/course/${record.id}`;

      if (type === 'INSERT' || (type === 'UPDATE' && status === 'awaiting_pickup' && oldStatus !== 'awaiting_pickup')) {
        if (record.delivery_person_id) {
          const { data: dp } = await supabase.from('delivery_persons').select('user_id').eq('id', record.delivery_person_id).maybeSingle();
          if (dp?.user_id) {
            await sendPushToUser(dp.user_id, {
              title: '🛵 Nouvelle course assignée !',
              body: `Une livraison vous a été confiée à Daloa (${priceText}). Ouvrez l'application pour démarrer.`,
              url: courseUrl,
              tag: `delivery-assign-${record.id}`,
            }, { appType: 'delivery' });
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
                  url: courseUrl,
                  tag: `delivery-open-${record.id}`,
                }, { appType: 'delivery' }).catch((err) => console.warn('[Push Delivery Error]:', err));
              }
            }
          }
        }
      }

      // Prise en charge et livraison : l'acheteur et le vendeur sont déjà
      // prévenus par le changement de `orders.status` (branche 2), que
      // verify_pickup et verify_delivery font en même temps. Les notifier ici
      // aussi leur envoyait chaque message en double — dont un « Colis
      // arrivé, donnez votre code » envoyé APRÈS la saisie du code.

      return res.json({ ok: true });
    }

    return res.json({ ok: true, skipped: 'unhandled table/type' });
  } catch (err) {
    console.error('[Push Webhook Exception]:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
