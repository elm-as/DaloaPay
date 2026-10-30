const crypto = require('crypto');
const { sendPushToUser } = require('./push');
const { PRICING, haversineDistance, calculateDeliveryFee } = require('./pricing');

const generateOTP = () => crypto.randomInt(100000, 1000000).toString();

/**
 * Crée les commandes et courses à partir d'un séquestre financé.
 * Idempotent et atomique : un UPDATE conditionnel `pending → funded` garantit
 * qu'un seul appel (webhook ou polling) crée les commandes.
 */
async function createOrderFromEscrow(supabase, escrow, personalInfo) {
  if (escrow.order_id) {
    return escrow.order_id;
  }

  const { data: claimed, error: claimErr } = await supabase
    .from('escrow_transactions')
    .update({ status: 'funded', funded_at: new Date().toISOString() })
    .eq('id', escrow.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (claimErr) throw claimErr;
  if (!claimed) {
    const { data: current } = await supabase
      .from('escrow_transactions')
      .select('order_id')
      .eq('id', escrow.id)
      .maybeSingle();
    return current?.order_id || null;
  }

  try {
    return await createOrdersForClaimedEscrow(supabase, escrow, personalInfo);
  } catch (err) {
    await supabase
      .from('escrow_transactions')
      .update({ status: 'pending', funded_at: null })
      .eq('id', escrow.id)
      .is('order_id', null);
    throw err;
  }
}

async function createOrdersForClaimedEscrow(supabase, escrow, personalInfo) {
  const meta = escrow.order_metadata || {};
  const rawItems = Array.isArray(meta.items) && meta.items.length > 0 ? meta.items : [meta];
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
    seller_amount: i.seller_amount != null ? i.seller_amount : isLegacySingle ? escrow.seller_amount : null,
    delivery_lat: i.delivery_lat ?? null,
    delivery_lng: i.delivery_lng ?? null,
    distance_km: i.distance_km ?? null,
  }));

  const address = meta.delivery_address || personalInfo?.delivery_address || 'Daloa';
  const deliveryMode = meta.delivery_mode || personalInfo?.delivery_mode || 'delivery';
  const isPickup = deliveryMode === 'pickup_point' || deliveryMode === 'pickup';
  const requestedDaloaCash = Math.max(0, Number(meta.daloa_cash_discount) || 0);

  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.seller_id)) groups.set(it.seller_id, []);
    groups.get(it.seller_id).push(it);
  }

  let firstOrderId = null;
  const orderIds = [];
  let sellerIndex = 0;

  for (const [sellerId, group] of groups.entries()) {
    const productAmount = group.reduce((s, i) => s + (i.product_amount || 0), 0);
    const deliveryFee = group.reduce((s, i) => s + (i.delivery_fee || 0), 0);
    const platformFee = group.reduce((s, i) => s + (i.platform_fee || 0), 0);
    const sellerNetAmount = group.reduce(
      (s, i) => s + (i.seller_amount != null ? i.seller_amount : (i.product_amount || 0)),
      0
    );
    const sellerCommission = Math.max(0, productAmount - sellerNetAmount);
    const driverCommission = Math.round(deliveryFee * 0.10);
    const driverNetAmount = Math.max(0, deliveryFee - driverCommission);
    const totalQuantity = group.reduce((s, i) => s + i.quantity, 0);
    const orderDaloaCash = sellerIndex === 0 ? Math.min(requestedDaloaCash, deliveryFee) : 0;
    const orderTotal = Math.max(0, productAmount + deliveryFee + platformFee - orderDaloaCash);
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
        platform_commission: sellerCommission,
        reserve_fee: platformFee,
        daloa_cash_discount: orderDaloaCash,
        total_amount: orderTotal,
        delivery_address: address,
        delivery_mode: deliveryMode,
        delivery_lat: isPickup ? null : first.delivery_lat,
        delivery_lng: isPickup ? null : first.delivery_lng,
        distance_km: first.distance_km,
        status: 'paid',
      })
      .select('id')
      .single();

    if (orderErr || !order) {
      console.error('Order creation error:', orderErr);
      throw new Error('Erreur création order: ' + (orderErr?.message || 'unknown'));
    }

    orderIds.push(order.id);

    if (sellerIndex === 0) {
      firstOrderId = order.id;
      // Mise à jour du séquestre principal avec les montants exacts du vendeur 1
      await supabase
        .from('escrow_transactions')
        .update({
          order_id: order.id,
          seller_id: sellerId,
          total_amount: orderTotal,
          seller_amount: sellerNetAmount,
          driver_amount: driverNetAmount,
          delivery_fee: deliveryFee,
          platform_fee: platformFee + sellerCommission + driverCommission,
        })
        .eq('id', escrow.id);
    } else {
      // Séquestre dédié pour chaque vendeur supplémentaire afin que verify_delivery
      // et complete_pickup_order déclenchent le versement exact de chaque vendeur et livreur.
      await supabase.from('escrow_transactions').insert({
        order_id: order.id,
        buyer_id: escrow.buyer_id,
        seller_id: sellerId,
        total_amount: orderTotal,
        seller_amount: sellerNetAmount,
        driver_amount: driverNetAmount,
        delivery_fee: deliveryFee,
        platform_fee: platformFee + sellerCommission + driverCommission,
        status: 'funded',
        funded_at: escrow.funded_at || new Date().toISOString(),
        payment_method: escrow.payment_method || 'mobile_money',
        payment_reference: escrow.payment_reference ? `${escrow.payment_reference}_s${sellerIndex + 1}` : null,
        order_metadata: {
          parent_escrow_id: escrow.id,
          items: group,
          delivery_address: address,
          delivery_mode: deliveryMode,
        },
      });
    }

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

    sellerIndex += 1;
  }

  // Déduction effective du solde Daloa Cash de l'acheteur après confirmation du paiement
  if (requestedDaloaCash > 0 && firstOrderId && escrow.buyer_id) {
    try {
      const { data: buyerRow } = await supabase
        .from('users')
        .select('daloa_cash_balance')
        .eq('id', escrow.buyer_id)
        .maybeSingle();
      const curBalance = Number(buyerRow?.daloa_cash_balance) || 0;
      const deducted = Math.min(curBalance, requestedDaloaCash);
      if (deducted > 0) {
        await supabase
          .from('users')
          .update({ daloa_cash_balance: Math.max(0, curBalance - deducted) })
          .eq('id', escrow.buyer_id);
        await supabase.from('daloa_cash_transactions').insert({
          user_id: escrow.buyer_id,
          amount: -deducted,
          type: 'checkout_discount',
          order_id: firstOrderId,
          notes: 'Réduction Daloa Cash appliquée sur paiement Mobile Money',
        });
      }
    } catch (dcErr) {
      console.error('[escrow] Erreur déduction Daloa Cash:', dcErr);
    }
  }

  // Initialisation de la tournée groupée multi-vendeurs (F06) si >= 2 vendeurs en livraison
  if (!isPickup && orderIds.length > 1) {
    try {
      await supabase.rpc('setup_grouped_delivery_run', {
        p_order_ids: orderIds,
        p_dropoff_address: address,
        p_dropoff_district: null,
        p_dropoff_lat: items[0]?.delivery_lat ?? null,
        p_dropoff_lng: items[0]?.delivery_lng ?? null,
      });
    } catch (grpErr) {
      console.error('[escrow] Erreur initialisation livraison groupée:', grpErr);
    }
  }

  return firstOrderId;
}

module.exports = {
  PRICING,
  haversineDistance,
  calculateDeliveryFee,
  generateOTP,
  createOrderFromEscrow,
};
