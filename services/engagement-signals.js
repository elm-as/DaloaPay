const { ENV, getSupabaseAdminClient } = require('../config/env');

const CACHE_TTL_MS = 30 * 1000;
let cachedListingSignals = new Map();
let cachedMarketplaceStats = { data: null, expiresAt: 0 };

/**
 * Récupère les signaux réels d'engagement pour une annonce (visiteurs uniques 7j, favoris, stock, réduction).
 * Utilise le client service_role afin de lire `listing_views` (protégé par RLS) sans exposer les identifiants des visiteurs.
 * @param {string} listingId Identifiant UUID de l'annonce
 * @returns {Promise<object>} Signaux agrégés
 */
async function fetchListingEngagementSignals(listingId) {
  if (!listingId) {
    return { recentViewers7d: 0, favoritesCount: 0, stock: 1, priceDropAmount: 0 };
  }

  const now = Date.now();
  const cached = cachedListingSignals.get(listingId);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error('Base de données indisponible');
  }

  const since7d = new Date(now - 7 * 86400 * 1000).toISOString();

  const [listingRes, viewsRes, favsRes] = await Promise.all([
    supabase
      .from('listings')
      .select('id, user_id, price, original_price, stock, status')
      .eq('id', listingId)
      .maybeSingle(),
    supabase
      .from('listing_views')
      .select('viewer_id, last_viewed_at')
      .eq('listing_id', listingId)
      .gte('last_viewed_at', since7d),
    supabase
      .from('favorites')
      .select('id', { count: 'exact', head: true })
      .eq('listing_id', listingId),
  ]);

  const listing = listingRes.data;
  if (!listing) {
    return { recentViewers7d: 0, favoritesCount: 0, stock: 0, priceDropAmount: 0 };
  }

  const recentViewers7d = (viewsRes.data || []).filter(
    (v) => v.viewer_id && v.viewer_id !== listing.user_id
  ).length;

  const favoritesCount = typeof favsRes.count === 'number' ? favsRes.count : 0;
  const stock = typeof listing.stock === 'number' ? listing.stock : 1;
  const priceDropAmount =
    listing.original_price != null && listing.original_price > listing.price
      ? Math.max(0, Number(listing.original_price) - Number(listing.price))
      : 0;

  const data = {
    recentViewers7d,
    favoritesCount,
    stock,
    priceDropAmount,
  };

  cachedListingSignals.set(listingId, { data, expiresAt: now + CACHE_TTL_MS });
  return data;
}

/**
 * Récupère les statistiques réelles de preuve sociale de la marketplace (membres Daloa, annonces, nouveautés 7j, promos, avis).
 * @returns {Promise<object>} Statistiques globales réelles
 */
async function fetchMarketplaceProofStats() {
  const now = Date.now();
  if (cachedMarketplaceStats.data && cachedMarketplaceStats.expiresAt > now) {
    return cachedMarketplaceStats.data;
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error('Base de données indisponible');
  }

  const since7d = new Date(now - 7 * 86400 * 1000).toISOString();

  const [usersRes, activeListingsRes, newListingsRes, reviewsRes] = await Promise.all([
    supabase
      .from('users')
      .select('id', { count: 'exact', head: true })
      .neq('banned', true)
      .is('deleted_at', null),
    supabase
      .from('listings')
      .select('price, original_price')
      .eq('status', 'active'),
    supabase
      .from('listings')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .gte('created_at', since7d),
    supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true }),
  ]);

  const activeList = activeListingsRes.data || [];
  const activePromos = activeList.filter(
    (l) => l.original_price != null && Number(l.original_price) > Number(l.price)
  ).length;

  const data = {
    totalMembers: typeof usersRes.count === 'number' ? usersRes.count : 185,
    activeListings: activeList.length,
    newListings7d: typeof newListingsRes.count === 'number' ? newListingsRes.count : 0,
    activePromos,
    verifiedReviews: typeof reviewsRes.count === 'number' ? reviewsRes.count : 0,
  };

  cachedMarketplaceStats = { data, expiresAt: now + 60 * 1000 };
  return data;
}

/**
 * Calcule la progression hebdomadaire d'un vendeur (visiteurs cette semaine vs semaine passée, favoris gagnés).
 * @param {string} sellerId Identifiant UUID du vendeur
 * @returns {Promise<object>} Progression Avant / Après
 */
async function fetchSellerWeeklyProgress(sellerId) {
  if (!sellerId) {
    return { visitorsThisWeek: 0, visitorsPrevWeek: 0, favoritesThisWeek: 0, activePromosCount: 0 };
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error('Base de données indisponible');
  }

  const { data: sellerListings } = await supabase
    .from('listings')
    .select('id, price, original_price, status')
    .eq('user_id', sellerId);

  const listingIds = (sellerListings || []).map((l) => l.id);
  if (listingIds.length === 0) {
    return { visitorsThisWeek: 0, visitorsPrevWeek: 0, favoritesThisWeek: 0, activePromosCount: 0 };
  }

  const now = Date.now();
  const since7d = new Date(now - 7 * 86400 * 1000).toISOString();
  const since14d = new Date(now - 14 * 86400 * 1000).toISOString();

  const [viewsRes, favsRes] = await Promise.all([
    supabase
      .from('listing_views')
      .select('viewer_id, last_viewed_at')
      .in('listing_id', listingIds)
      .gte('last_viewed_at', since14d),
    supabase
      .from('favorites')
      .select('id', { count: 'exact', head: true })
      .in('listing_id', listingIds)
      .gte('created_at', since7d),
  ]);

  let visitorsThisWeek = 0;
  let visitorsPrevWeek = 0;

  for (const row of viewsRes.data || []) {
    if (!row.viewer_id || row.viewer_id === sellerId) continue;
    if (row.last_viewed_at >= since7d) {
      visitorsThisWeek += 1;
    } else {
      visitorsPrevWeek += 1;
    }
  }

  const activePromosCount = (sellerListings || []).filter(
    (l) => l.status === 'active' && l.original_price != null && Number(l.original_price) > Number(l.price)
  ).length;

  return {
    visitorsThisWeek,
    visitorsPrevWeek,
    favoritesThisWeek: typeof favsRes.count === 'number' ? favsRes.count : 0,
    activePromosCount,
  };
}

module.exports = {
  fetchListingEngagementSignals,
  fetchMarketplaceProofStats,
  fetchSellerWeeklyProgress,
};

