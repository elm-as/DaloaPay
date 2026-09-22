const crypto = require('crypto');
const { sendPushToUser } = require('./push');

const PRICING = {
  DELIVERY_MIN: 500,
  DELIVERY_RATE_PER_KM: 85,
  DELIVERY_FREE_KM: 1.5,
  BUYER_FEE_RATE: 0.02, // 2% aligné sur @daloa/config
  SELLER_FEE_RATE: 0.035,
  PRO_SELLER_FEE_RATE: 0.025,
  DRIVER_FEE_RATE: 0.10,
};

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateDeliveryFee(distanceKm) {
  const baseFee = PRICING.DELIVERY_MIN;
  let extraFee = 0;
  if (distanceKm > PRICING.DELIVERY_FREE_KM) {
    extraFee = Math.round((distanceKm - PRICING.DELIVERY_FREE_KM) * PRICING.DELIVERY_RATE_PER_KM);
  }
  return baseFee + extraFee;
}

const generateOTP = () => crypto.randomInt(100000, 1000000).toString();

/**
 * Crée l'order + delivery_assignment UNIQUEMENT quand le paiement est confirmé.
 * Idempotent : si l'escrow a déjà un order_id, on ne recrée pas.
 * @returns {Promise<string>} order_id
 */
async function createOrderFromEscrow(supabase, escrow, personalInfo) {
  if (escrow.order_id) {
    return escrow.order_id;
  }

  const meta = escrow.order_metadata || {};

  const rawItems =
    Array.isArray(meta.items) && meta.items.length > 0 ? meta.items : [meta];
  const isLegacySingle = rawItems.length === 1 && meta.items == null;

  const items = rawItems.map((i) => ({
    listing_id: i.listing_id,
    seller_id: i.seller_id || escrow.seller_id,
    variant_id: i.variant_id || null,
    variant_label: i.variant_label || null,
    unit_price: i.unit_price || null,
    quantity: Math.max(1, Number(i.quantity) || 1),
    product_amount:
      i.product_amount != null
        ? i.product_amount
        : isLegacySingle
        ? escrow.total_amount - (escrow.delivery_fee || 0) - (escrow.platform_fee || 0)
        : 0,
    delivery_fee: i.delivery_fee != null ? i.delivery_fee : isLegacySingle ? escrow.delivery_fee || 0 : 0,
    platform_fee: i.platform_fee != null ? i.platform_fee : isLegacySingle ? escrow.platform_fee || 0 : 0,
  }));

  const address = meta.delivery_address || personalInfo?.delivery_address || 'Daloa';
  const deliveryMode = meta.delivery_mode || personalInfo?.delivery_mode || 'delivery';
  const isPickup = deliveryMode === 'pickup_point' || deliveryMode === 'pickup';

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.seller_id)) groups.set(it.seller_id, []);
    groups.get(it.seller_id).push(it);
  }

  let firstOrderId = null;

  for (const [sellerId, group] of groups.entries()) {
    const productAmount = group.reduce((s, i) => s + (i.product_amount || 0), 0);
    const deliveryFee = group.reduce((s, i) => s + (i.delivery_fee || 0), 0);
    const platformFee = group.reduce((s, i) => s + (i.platform_fee || 0), 0);
    const totalQuantity = group.reduce((s, i) => s + i.quantity, 0);
    const orderTotal = productAmount + deliveryFee + platformFee;
    const first = group[0];

    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .insert({
        buyer_id: escrow.buyer_id,
        seller_id: sellerId,
        listing_id: first.listing_id,
        variant_id: first.variant_id,
        variant_label: first.variant_label,
        unit_price: first.unit_price,
        quantity: totalQuantity,
        product_amount: productAmount,
        delivery_fee: deliveryFee,
        platform_commission: platformFee,
        total_amount: orderTotal,
        delivery_address: address,
        delivery_mode: deliveryMode,
        status: 'paid',
      })
      .select('id')
      .single();

    if (orderErr || !order) {
      console.error('Order creation error:', orderErr);
      throw new Error('Erreur création order: ' + (orderErr?.message || 'unknown'));
    }
    if (!firstOrderId) firstOrderId = order.id;

    const itemsPayload = group.map((i) => ({
      order_id: order.id,
      listing_id: i.listing_id,
      variant_id: i.variant_id,
      variant_label: i.variant_label,
      unit_price: i.unit_price || 0,
      quantity: i.quantity,
      product_amount: i.product_amount || 0,
    }));
    const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemsErr) {
      console.error('order_items creation error:', itemsErr.message);
    }

    // Décrémenter le stock de chaque article et marquer comme vendu si stock = 0
    for (const it of group) {
      try {
        const { data: curListing } = await supabase
          .from('listings')
          .select('id, stock, status, variants')
          .eq('id', it.listing_id)
          .maybeSingle();

        if (curListing) {
          const prevStock = Number(curListing.stock) || 1;
          const newStock = Math.max(0, prevStock - it.quantity);
          const updatePayload = {
            stock: newStock,
            status: newStock === 0 ? 'sold' : curListing.status,
          };

          if (Array.isArray(curListing.variants) && it.variant_id) {
            updatePayload.variants = curListing.variants.map((v) => {
              if (v.id === it.variant_id) {
                const vStock = Math.max(0, (Number(v.stock) || 0) - it.quantity);
                return { ...v, stock: vStock, active: vStock > 0 };
              }
              return v;
            });
          }

          await supabase.from('listings').update(updatePayload).eq('id', it.listing_id);
        }
      } catch (stockErr) {
        console.error('[escrow] Erreur décrémentation stock:', stockErr);
      }
    }

    const pickupOTP = generateOTP();
    const deliveryOTP = generateOTP();
    await supabase.from('delivery_assignments').insert({
      order_id: order.id,
      delivery_person_id: null,
      status: 'pending_seller_confirmation',
      pickup_confirmed_by_seller: isPickup,
      pickup_otp: pickupOTP,
      delivery_otp: deliveryOTP,
      pickup_otp_attempts: 0,
      delivery_otp_attempts: 0,
      pickup_location: 'Boutique du vendeur',
      dropoff_location: address || 'Retrait en boutique',
      delivery_price: deliveryFee || 0,
      seller_id: sellerId,
      is_private: isPickup,
    });

    if (sellerId) {
      const count = group.length;
      sendPushToUser(sellerId, {
        title: '🎉 Nouvelle commande reçue !',
        body: `${count} article${count > 1 ? 's' : ''} vendu${count > 1 ? 's' : ''} • ${Number(orderTotal || 0).toLocaleString('fr-FR')} FCFA. Préparez le colis ! 📦`,
        channelId: 'orders',
        url: `/mes-commandes`,
        tag: `order-${order.id}`,
        orderId: order.id,
      }).catch((e) => console.error('[Push Order Error]:', e));
    }
  }

  await supabase
    .from('escrow_transactions')
    .update({ order_id: firstOrderId, status: 'funded', funded_at: new Date().toISOString() })
    .eq('id', escrow.id);

  return firstOrderId;
}

module.exports = {
  PRICING,
  haversineDistance,
  calculateDeliveryFee,
  generateOTP,
  createOrderFromEscrow,
};
