const express = require('express');
const router = express.Router();
const { ENV, getSupabaseAdminClient } = require('../config/env');
const { requireWebhookSecret } = require('../middlewares/auth');
const { sendPushToUser } = require('../services/push');
const { DEFAULT_PUSH_CONCURRENCY, runWithConcurrency } = require('../services/push-dispatch-batch');

function firstPhoto(photos) {
  const first = Array.isArray(photos) ? photos[0] : null;
  return typeof first === 'string' && first.startsWith('http') ? first : null;
}

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n).trimEnd()}…` : s || '');
const formatFCFA = (n) => `${Number(n).toLocaleString('fr-FR')} FCFA`;
const orderRef = (id) => `#${String(id).slice(0, 6).toUpperCase()}`;

async function handleMessageInsertWebhook(supabase, record) {
  const targetUserId = record.receiver_id;
  if (!targetUserId) return { ok: true, skipped: 'no receiver_id' };

  let senderName = null;
  let senderAvatar = null;
  let listingTitle = null;
  let listingPhoto = null;
  let listingPrice = null;
  let unreadCount = 1;

  try {
    const [senderRes, listingRes, unreadRes] = await Promise.all([
      record.sender_id
        ? supabase.from('users').select('full_name, shop_name, avatar_url').eq('id', record.sender_id).maybeSingle()
        : Promise.resolve({ data: null }),
      record.listing_id
        ? supabase.from('listings').select('title, photos, price').eq('id', record.listing_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', record.sender_id)
        .eq('receiver_id', targetUserId)
        .eq('read', false),
    ]);

    const shopName = senderRes.data?.shop_name?.trim();
    if (shopName) senderName = shopName;
    else if (senderRes.data?.full_name) senderName = senderRes.data.full_name.split(' ')[0];

    senderAvatar = senderRes.data?.avatar_url || null;
    if (listingRes.data?.title) listingTitle = listingRes.data.title;
    listingPhoto = firstPhoto(listingRes.data?.photos);
    listingPrice = listingRes.data?.price ? String(listingRes.data.price) : null;
    if (unreadRes && typeof unreadRes.count === 'number' && unreadRes.count > 0) unreadCount = unreadRes.count;
  } catch (metaErr) {
    console.warn('[PushWebhook/messages] Métadonnées partielles indisponibles:', metaErr.message);
  }

  const countBadge = unreadCount > 1 ? ` (${unreadCount} messages)` : '';
  const shortListing = truncate(listingTitle, 20) || null;
  const notifTitle = senderName
    ? (shortListing ? `💬 ${senderName} • ${shortListing}${countBadge}` : `💬 ${senderName}${countBadge}`)
    : `💬 Nouveau message${countBadge}`;

  const result = await sendPushToUser(
    targetUserId,
    {
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
    },
    { appType: 'market' }
  );
  return { ok: true, ...result };
}

function buildOrderNotificationCopies(record, itemTitle) {
  const ref = orderRef(record.id);
  const forItem = itemTitle ? `\n📌 ${itemTitle}` : '';
  const isSellerUnavailable = record.cancel_reason === 'unavailable' || record.cancel_reason === 'seller_unavailable';
  const isAdminRefund = String(record.cancel_reason || '').startsWith('admin_refund');
  const status = record.status;

  let buyerTitle = '📦 Commande mise à jour';
  let buyerMsg = `Votre commande ${ref} a été mise à jour.`;
  let sellerTitle = null;
  let sellerMsg = null;

  if (status === 'paid') {
    buyerTitle = '✅ Commande confirmée !';
    buyerMsg = `Votre commande ${ref} est en préparation.${forItem}`;
    sellerTitle = '🎉 Nouvelle vente !';
    sellerMsg = `Paiement reçu pour la commande ${ref}.${forItem}\nPréparez le colis pour le livreur.`;
  } else if (status === 'in_transit' || status === 'picked_up') {
    buyerTitle = '🛵 Livreur en route !';
    buyerMsg = `Le livreur fait route vers vous avec votre colis ${ref}.${forItem}`;
  } else if (status === 'delivered') {
    buyerTitle = '🎉 Colis livré !';
    buyerMsg = `Votre commande ${ref} a été remise en mains propres.${forItem}\nMerci pour votre confiance.`;
    sellerTitle = '✅ Livraison validée';
    sellerMsg =
      record.payment_method === 'online'
        ? `Le colis ${ref} a été remis au client.${forItem}\nVotre virement Mobile Money est programmé.`
        : `Le colis ${ref} a été remis au client.${forItem}\nLa commande est clôturée.`;
  } else if (status === 'cancelled') {
    buyerTitle = isSellerUnavailable ? '❌ Article indisponible' : isAdminRefund ? '⚖️ Litige réglé' : '❌ Commande annulée';
    const refundText = record.payment_method === 'online' ? '\nLe remboursement Mobile Money est en cours.' : '';
    buyerMsg = isSellerUnavailable
      ? `Le vendeur ne peut pas honorer la commande ${ref}.${forItem}${refundText}`
      : `Votre commande ${ref} a été annulée.${forItem}${refundText}`;

    if (!isSellerUnavailable) {
      sellerTitle = isAdminRefund ? '⚖️ Litige réglé' : '❌ Commande annulée par le client';
      sellerMsg = isAdminRefund
        ? `Le litige sur la commande ${ref} a été arbitré.${forItem}`
        : `L'acheteur a annulé la commande ${ref} avant expédition.${forItem}\nL'article a été remis en stock.`;
    }
  } else if (status === 'disputed') {
    buyerTitle = '⚠️ Litige ouvert';
    buyerMsg = `Un litige a été ouvert sur la commande ${ref}.${forItem}\nNotre équipe intervient.`;
    sellerTitle = '⚠️ Litige ouvert sur une vente';
    sellerMsg = `Un incident a été signalé sur la commande ${ref}.${forItem}\nL'équipe DaloaMarket examine le dossier.`;
  }

  return { buyerTitle, buyerMsg, sellerTitle, sellerMsg };
}

async function handleOrderUpdateWebhook(supabase, { record, oldRecord }) {
  if (record.status === oldRecord?.status) {
    return { ok: true, skipped: 'status inchangé' };
  }

  let itemTitle = null;
  let itemPhoto = null;
  if (record.listing_id) {
    try {
      const { data: listing } = await supabase.from('listings').select('title, photos').eq('id', record.listing_id).maybeSingle();
      itemTitle = truncate(listing?.title, 40) || null;
      itemPhoto = firstPhoto(listing?.photos);
    } catch (listingErr) {
      console.warn('[PushWebhook/orders] Lecture annonce échouée:', listingErr.message);
    }
  }

  const copies = buildOrderNotificationCopies(record, itemTitle);
  const dispatches = [];

  if (record.buyer_id) {
    dispatches.push(
      sendPushToUser(
        record.buyer_id,
        { title: copies.buyerTitle, body: copies.buyerMsg, channelId: 'orders', url: `/suivi/${record.id}`, tag: `order-${record.id}`, image: itemPhoto, orderId: record.id },
        { appType: 'market' }
      )
    );
  }
  if (record.seller_id && copies.sellerMsg) {
    dispatches.push(
      sendPushToUser(
        record.seller_id,
        { title: copies.sellerTitle, body: copies.sellerMsg, channelId: 'orders', url: `/suivi/${record.id}`, tag: `order-seller-${record.id}`, image: itemPhoto, orderId: record.id },
        { appType: 'market' }
      )
    );
  }

  await Promise.all(dispatches);
  return { ok: true };
}

async function fetchBroadcastTargetDrivers(supabase, record) {
  if (!record.is_private) {
    const { data } = await supabase.from('delivery_persons').select('user_id').eq('is_available', true).eq('is_verified', true);
    return data || [];
  }
  if (!record.seller_id) return [];
  const { data: affiliated } = await supabase
    .from('seller_delivery_affiliations')
    .select('delivery_persons!inner(user_id, is_available, is_verified)')
    .eq('seller_id', record.seller_id)
    .eq('status', 'active');
  return (affiliated || []).map((a) => a.delivery_persons).filter((dp) => dp && dp.is_available && dp.is_verified);
}

async function handleDeliveryAssignmentWebhook(supabase, { type, record, oldRecord }) {
  const status = record.status;
  const oldStatus = oldRecord?.status;
  const courseUrl = `/course/${record.id}`;
  const isNowAwaitingPickup =
    (type === 'INSERT' && status === 'awaiting_pickup') ||
    (type === 'UPDATE' && status === 'awaiting_pickup' && oldStatus !== 'awaiting_pickup');

  if (isNowAwaitingPickup) {
    const netPrice = record.delivery_price ? Math.round(Number(record.delivery_price) * 0.9) : 0;
    const priceText = netPrice > 0 ? `${formatFCFA(netPrice)} net` : 'Rémunérée';

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
      return { ok: true };
    }

    const drivers = await fetchBroadcastTargetDrivers(supabase, record);
    await runWithConcurrency(
      drivers.filter((d) => d.user_id),
      (driver) =>
        sendPushToUser(
          driver.user_id,
          {
            title: `🛵 Course disponible · ${priceText}`,
            body: 'Livraison à Daloa · Premier arrivé, premier servi.',
            url: courseUrl,
            tag: `delivery-open-${record.id}`,
          },
          { appType: 'delivery' }
        ).catch((err) => console.warn('[Push Delivery Error]:', err)),
      DEFAULT_PUSH_CONCURRENCY
    );
    return { ok: true };
  }

  const isDriverAlertStatus = type === 'UPDATE' && (status === 'cancelled' || status === 'disputed') && oldStatus !== status && record.delivery_person_id;
  if (!isDriverAlertStatus) return { ok: true };

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
  return { ok: true };
}

router.post('/push/webhook', requireWebhookSecret(ENV.PUSH_WEBHOOK_SECRET, 'x-push-webhook-secret'), async (req, res) => {
  const { type, table, record, old_record } = req.body || {};
  if (!record || !table) return res.status(400).json({ ok: false, error: 'Payload webhook invalide' });

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB indisponible' });

    if (table === 'messages' && type === 'INSERT') {
      return res.json(await handleMessageInsertWebhook(supabase, record));
    }
    if (table === 'orders' && type === 'UPDATE') {
      return res.json(await handleOrderUpdateWebhook(supabase, { record, oldRecord: old_record }));
    }
    if (table === 'delivery_assignments') {
      return res.json(await handleDeliveryAssignmentWebhook(supabase, { type, record, oldRecord: old_record }));
    }
    return res.json({ ok: true, skipped: `table ${table} non gérée` });
  } catch (err) {
    console.error('[Push Webhook Exception]:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
