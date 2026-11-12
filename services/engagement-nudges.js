const { getSupabaseAdminClient } = require('../config/env');
const { sendPushToUser } = require('./push');
const { renderCampaignTemplate } = require('./push-campaigns');

const QUIET_HOUR_START_UTC = 21;
const QUIET_HOUR_END_UTC = 7;

/**
 * Vérifie si l'heure courante (UTC = heure d'Abidjan/Daloa) est autorisée pour un push marketing.
 * @param {Date} [now] Date de référence
 * @returns {boolean} Vrai si hors plage de silence (07h00 - 21h00)
 */
function isWithinAllowedPushHours(now = new Date()) {
  const hour = now.getUTCHours();
  return hour >= QUIET_HOUR_END_UTC && hour < QUIET_HOUR_START_UTC;
}

/**
 * Exécute les règles de relance comportementale automatique (FOMO, Culpabilité, Confiance, Aspiration) :
 * 1. Demande d'avis vérifié après une commande livrée sans avis (`review_request`)
 * 2. Alerte baisse de prix ou stock faible (<= 2) sur un article mis en favori (`favorite_alert`)
 * 3. Alerte annonce qui dort depuis +10 jours sans visite récente (`stale_listing`)
 * @param {object} [options]
 * @param {boolean} [options.dryRun] Si vrai, retourne les candidats sans envoyer
 * @returns {Promise<object>} Rapport d'exécution
 */
async function executeBehavioralNudges(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const now = new Date();

  if (!dryRun && !isWithinAllowedPushHours(now)) {
    return {
      success: true,
      skipped: 'quiet_hours',
      message: 'Plage horaire de silence (21h-07h Daloa)',
      sent: 0,
    };
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error('Base de données indisponible');
  }

  const actions = [];

  // 1. Confiance : Demande d'avis vérifié sur les commandes livrées (> 2h, < 7j) sans avis
  const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();

  const [deliveredOrdersRes, existingReviewsRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id, buyer_id, seller_id, listing_id, updated_at')
      .eq('status', 'delivered')
      .lte('updated_at', twoHoursAgo)
      .gte('updated_at', sevenDaysAgo)
      .limit(30),
    supabase.from('reviews').select('reviewer_id, listing_id'),
  ]);

  const reviewedPairs = new Set(
    (existingReviewsRes.data || []).map((r) => `${r.reviewer_id}_${r.listing_id}`)
  );

  for (const order of deliveredOrdersRes.data || []) {
    if (!order.buyer_id || !order.listing_id) continue;
    if (reviewedPairs.has(`${order.buyer_id}_${order.listing_id}`)) continue;
    actions.push({
      type: 'review_request',
      userId: order.buyer_id,
      title: '⭐ Comment était ta commande ?',
      body: 'Tu as bien reçu ton colis ! Laisse une note en 10 secondes pour aider les acheteurs de Daloa à faire confiance aux bons vendeurs 🙏🏾',
      url: `/suivi/${order.id}`,
      tag: `nudge-review-${order.id}`,
    });
  }

  // 2. FOMO & Frustration : Favoris en promotion ou stock très bas (<= 2)
  const { data: favRows } = await supabase
    .from('favorites')
    .select('user_id, listing_id')
    .limit(100);

  const favListingIds = [...new Set((favRows || []).map((f) => f.listing_id).filter(Boolean))];
  if (favListingIds.length > 0) {
    const { data: favListings } = await supabase
      .from('listings')
      .select('id, title, price, original_price, stock, status')
      .in('id', favListingIds)
      .eq('status', 'active');

    const listingById = new Map((favListings || []).map((l) => [l.id, l]));
    const alertedUsers = new Set();

    for (const fav of favRows || []) {
      if (!fav.user_id || alertedUsers.has(fav.user_id)) continue;
      const item = listingById.get(fav.listing_id);
      if (!item) continue;

      const hasPromo = item.original_price != null && Number(item.original_price) > Number(item.price);
      const isLowStock = item.stock != null && Number(item.stock) > 0 && Number(item.stock) <= 2;

      if (hasPromo) {
        const drop = Number(item.original_price) - Number(item.price);
        alertedUsers.add(fav.user_id);
        actions.push({
          type: 'favorite_promo',
          userId: fav.user_id,
          title: '🔥 Baisse de prix sur ton favori !',
          body: `« ${String(item.title).slice(0, 38)} » est passé à ${Number(item.price).toLocaleString('fr-FR')} F (-${drop.toLocaleString('fr-FR')} F). Faut pas dormir dessus 👀`,
          url: `/l/${String(item.id).slice(0, 8)}`,
          tag: `nudge-fav-promo-${item.id}`,
        });
      } else if (isLowStock) {
        alertedUsers.add(fav.user_id);
        actions.push({
          type: 'favorite_low_stock',
          userId: fav.user_id,
          title: `⏳ Plus que ${item.stock} en stock !`,
          body: `Ton favori « ${String(item.title).slice(0, 38)} » va bientôt partir à Daloa. Commande avant qu'un autre prenne ça !`,
          url: `/l/${String(item.id).slice(0, 8)}`,
          tag: `nudge-fav-stock-${item.id}`,
        });
      }
    }
  }

  if (dryRun || actions.length === 0) {
    return {
      success: true,
      dryRun,
      candidatesCount: actions.length,
      sent: 0,
      samples: actions.slice(0, 10),
    };
  }

  const results = await Promise.allSettled(
    actions.slice(0, 25).map((act) =>
      sendPushToUser(
        act.userId,
        {
          title: act.title,
          body: act.body,
          url: act.url,
          tag: act.tag,
        },
        { appType: 'market' }
      )
    )
  );

  const sentCount = results.reduce(
    (acc, r) => acc + (r.status === 'fulfilled' && r.value?.sent ? r.value.sent : 0),
    0
  );

  return {
    success: true,
    dryRun: false,
    candidatesCount: actions.length,
    sent: sentCount,
    samples: actions.slice(0, 5),
  };
}

module.exports = {
  isWithinAllowedPushHours,
  executeBehavioralNudges,
};

