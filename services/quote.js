/**
 * Devis de commande — le seul calcul qui fait foi.
 *
 * Utilisé par `POST /quote` (le client l'affiche tel quel) et par
 * `POST /create-payment` sans devis (anciennes applications).
 */

const {
  PRICING,
  calculateDeliveryFee,
  resolvePoint,
  resolveBillableDistanceKm,
  parseDistrictFromAddress,
  loadDistricts,
} = require('./pricing');

const QUOTE_TTL_MINUTES = 15;
const GROUPED_ADDITIONAL_STOP_FEE = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class QuoteError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function loadListing(supabase, rawListingId) {
  if (!rawListingId) return null;
  if (UUID_RE.test(rawListingId)) {
    const r = await supabase
      .from('listings')
      .select('id, price, user_id, category, stock, status, variants')
      .eq('id', rawListingId)
      .maybeSingle();
    if (r.data) return r.data;
  }
  const r = await supabase
    .from('listings')
    .select('id, price, user_id, category, stock, status, variants')
    .ilike('id', `${rawListingId}%`)
    .limit(1)
    .maybeSingle();
  return r.data || null;
}

/**
 * Prix unitaire courant d'un article (variante comprise), après contrôle de
 * disponibilité. Lève une QuoteError si l'article ne peut plus être vendu.
 */
function resolveLine(listing, oi) {
  if (!listing) {
    throw new QuoteError(404, `Article introuvable (${oi?.listing_id || '?'})`, 'listing_not_found');
  }
  if (listing.status !== 'active') {
    throw new QuoteError(409, 'Un article du panier n’est plus disponible.', 'listing_unavailable');
  }
  const quantity = Math.max(1, Math.floor(Number(oi?.quantity) || 1));
  const variants = Array.isArray(listing.variants) ? listing.variants : [];
  const selectedVariant = oi?.variant_id ? variants.find((v) => v.id === oi.variant_id) : null;

  if (variants.length > 0 && (!selectedVariant || selectedVariant.active === false)) {
    throw new QuoteError(400, 'Veuillez choisir une taille valide.', 'invalid_variant');
  }
  const availableStock = selectedVariant ? Number(selectedVariant.stock) || 0 : Number(listing.stock) || 0;
  if (availableStock < quantity) {
    throw new QuoteError(409, 'La quantité demandée n’est plus disponible.', 'out_of_stock');
  }
  const unitPrice = selectedVariant?.price != null ? Number(selectedVariant.price) : Number(listing.price);
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw new QuoteError(400, 'Prix de l’article invalide.', 'invalid_price');
  }
  return { quantity, selectedVariant, unitPrice };
}

/**
 * Calcule un devis complet (incluant produits numériques 0 F et tarif groupé multi-vendeurs F06).
 * @returns {{ items, sellers, buyerPoint, deliveryMode, totals }}
 */
async function buildOrderQuote(supabase, { rawItems, phaseConfig }) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new QuoteError(400, 'Aucun article à commander.', 'empty_cart');
  }

  const districts = await loadDistricts(supabase);
  const items = [];
  const sellers = new Map();
  let buyerPoint = null;
  let deliveryMode = null;

  for (const oi of rawItems) {
    const listing = await loadListing(supabase, oi?.listing_id);
    const { quantity, selectedVariant, unitPrice } = resolveLine(listing, oi);
    const productAmount = unitPrice * quantity;
    const isDigital = listing.category === 'digital';

    const { data: sellerProfile } = await supabase
      .from('users')
      .select('pro_until, shop_latitude, shop_longitude, district')
      .eq('id', listing.user_id)
      .single();
    const isProSeller = sellerProfile?.pro_until ? new Date(sellerProfile.pro_until) > new Date() : false;
    const feeOverride = phaseConfig.seller_fee_override;
    const sellerFeeRate = feeOverride != null && Number.isFinite(Number(feeOverride))
      ? Number(feeOverride)
      : (isProSeller ? PRICING.PRO_SELLER_FEE_RATE : PRICING.SELLER_FEE_RATE);

    const isPickupMode = isDigital || oi?.delivery_mode === 'pickup' || oi?.delivery_mode === 'pickup_point';
    if (isPickupMode && !isDigital && phaseConfig.allow_pickup_for_all === false && !isProSeller) {
      throw new QuoteError(403, "Le retrait en boutique n'est pas disponible pour cet article.", 'pickup_not_allowed');
    }
    deliveryMode = isPickupMode ? 'pickup_point' : 'delivery';

    const buyerDistrict = oi?.delivery_district || parseDistrictFromAddress(oi?.delivery_address);
    const pointB = resolvePoint(oi?.delivery_lat, oi?.delivery_lng, buyerDistrict, districts);
    if (!buyerPoint) buyerPoint = { ...pointB, district: buyerDistrict || null };

    let seller = sellers.get(listing.user_id);
    if (!seller) {
      const sellerPoint = resolvePoint(
        sellerProfile?.shop_latitude,
        sellerProfile?.shop_longitude,
        sellerProfile?.district,
        districts
      );
      const distanceKm = isPickupMode ? 0 : await resolveBillableDistanceKm(sellerPoint, pointB);
      seller = {
        seller_id: listing.user_id,
        distance_km: Math.round(distanceKm * 10) / 10,
        delivery_fee: isPickupMode ? 0 : calculateDeliveryFee(distanceKm),
        buyer_fee: 0,
        product_amount: 0,
        first: true,
      };
      sellers.set(listing.user_id, seller);
    }

    const buyerFee = Math.round(productAmount * PRICING.BUYER_FEE_RATE);
    const sellerCommission = Math.round(productAmount * sellerFeeRate);
    seller.buyer_fee += buyerFee;
    seller.product_amount += productAmount;

    items.push({
      listing_id: listing.id,
      seller_id: listing.user_id,
      variant_id: selectedVariant?.id || null,
      variant_label: selectedVariant?.label || null,
      unit_price: unitPrice,
      quantity,
      product_amount: productAmount,
      delivery_fee: seller.first ? seller.delivery_fee : 0,
      platform_fee: buyerFee,
      seller_amount: productAmount - sellerCommission,
      delivery_address: oi?.delivery_address || 'Daloa',
      delivery_mode: isPickupMode ? 'pickup_point' : 'delivery',
      delivery_lat: pointB.lat,
      delivery_lng: pointB.lng,
      distance_km: seller.distance_km,
      is_first_for_seller: seller.first,
    });
    seller.first = false;
  }

  // Application de la tarification dégressive multi-vendeurs (F06 : +300 FCFA par stop additionnel)
  const sellerEntries = Array.from(sellers.values());
  if (deliveryMode === 'delivery' && sellerEntries.length > 1) {
    let primarySellerId = sellerEntries[0].seller_id;
    let maxFee = -1;
    for (const s of sellerEntries) {
      if (s.delivery_fee > maxFee) {
        maxFee = s.delivery_fee;
        primarySellerId = s.seller_id;
      }
    }
    for (const s of sellerEntries) {
      if (s.seller_id !== primarySellerId && s.delivery_fee > 0) {
        s.delivery_fee = Math.min(s.delivery_fee, GROUPED_ADDITIONAL_STOP_FEE);
      }
    }
    for (const item of items) {
      if (item.is_first_for_seller) {
        const s = sellers.get(item.seller_id);
        item.delivery_fee = s ? s.delivery_fee : item.delivery_fee;
      }
    }
  }

  for (const item of items) {
    delete item.is_first_for_seller;
  }

  const sellerList = sellerEntries.map(({ first, ...s }) => s);
  const productTotal = items.reduce((s, i) => s + i.product_amount, 0);
  const deliveryTotal = sellerList.reduce((s, x) => s + x.delivery_fee, 0);
  const buyerFeeTotal = items.reduce((s, i) => s + i.platform_fee, 0);

  return {
    items,
    sellers: sellerList,
    buyerPoint,
    deliveryMode,
    totals: {
      product_total: productTotal,
      delivery_total: deliveryTotal,
      buyer_fee_total: buyerFeeTotal,
      total_amount: productTotal + deliveryTotal + buyerFeeTotal,
    },
  };
}

/** Enregistre un devis et renvoie la ligne créée. */
async function saveQuote(supabase, buyerId, quote, deliveryAddress) {
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('delivery_quotes')
    .insert({
      buyer_id: buyerId,
      delivery_mode: quote.deliveryMode,
      buyer_lat: quote.deliveryMode === 'delivery' ? quote.buyerPoint.lat : null,
      buyer_lng: quote.deliveryMode === 'delivery' ? quote.buyerPoint.lng : null,
      district: quote.buyerPoint.district,
      delivery_address: deliveryAddress || null,
      items: quote.items,
      sellers: quote.sellers,
      ...quote.totals,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (error || !data) throw new QuoteError(500, error?.message || 'Devis impossible à enregistrer.', 'quote_save_failed');
  return data;
}

/**
 * Charge un devis pour paiement : il doit appartenir à l'acheteur, être
 * valide, inutilisé, et les articles doivent toujours se vendre au même prix.
 */
async function loadQuoteForPayment(supabase, quoteId, buyerId) {
  if (!quoteId || !UUID_RE.test(quoteId)) throw new QuoteError(400, 'Devis invalide.', 'quote_not_found');
  const { data: quote } = await supabase
    .from('delivery_quotes')
    .select('*')
    .eq('id', quoteId)
    .eq('buyer_id', buyerId)
    .maybeSingle();
  if (!quote) throw new QuoteError(404, 'Devis introuvable.', 'quote_not_found');
  if (quote.used_at) throw new QuoteError(409, 'Ce devis a déjà été utilisé.', 'quote_used');
  if (new Date(quote.expires_at) < new Date()) {
    throw new QuoteError(409, 'Le devis a expiré, le prix va être recalculé.', 'quote_expired');
  }

  for (const line of quote.items || []) {
    const listing = await loadListing(supabase, line.listing_id);
    let current;
    try {
      current = resolveLine(listing, line);
    } catch (err) {
      throw new QuoteError(409, err.message, 'quote_stale');
    }
    if (current.unitPrice !== Number(line.unit_price)) {
      throw new QuoteError(409, 'Le prix d’un article a changé, le devis va être recalculé.', 'quote_stale');
    }
  }
  return quote;
}

/** Marque le devis utilisé ; échoue s'il l'a été entre-temps. */
async function markQuoteUsed(supabase, quoteId, usedBy) {
  const { data } = await supabase
    .from('delivery_quotes')
    .update({ used_at: new Date().toISOString(), used_by: usedBy })
    .eq('id', quoteId)
    .is('used_at', null)
    .select('id');
  if (!data || data.length === 0) throw new QuoteError(409, 'Ce devis a déjà été utilisé.', 'quote_used');
}

module.exports = {
  QUOTE_TTL_MINUTES,
  QuoteError,
  buildOrderQuote,
  saveQuote,
  loadQuoteForPayment,
  markQuoteUsed,
};
