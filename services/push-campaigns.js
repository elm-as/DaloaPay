const { getSupabaseAdminClient } = require('../config/env');
const { sendPushToUser } = require('./push');
const { DEFAULT_PUSH_CONCURRENCY, runWithConcurrency } = require('./push-dispatch-batch');
const {
  splitIntoChunks,
  resolveRecipientDisplayName,
  renderCampaignTemplate,
  resolveRecipientTargetUrl,
} = require('./push-template');

const SUBSCRIPTION_CHUNK_SIZE = 200;

const VALID_SEGMENTS = [
  'dormant',
  'active_seller',
  'seller_no_promo',
  'buyer_cancelled',
];

async function fetchListingActivityForUsers(supabase, userIds) {
  const anyListing = new Set();
  const activeListing = new Set();
  const activePromo = new Set();

  for (const chunk of splitIntoChunks(userIds, SUBSCRIPTION_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('listings')
      .select('user_id, status, price, original_price')
      .neq('status', 'deleted')
      .in('user_id', chunk);

    if (error) throw new Error(`Erreur lecture annonces ciblées: ${error.message}`);

    for (const row of data || []) {
      if (!row.user_id) continue;
      anyListing.add(row.user_id);
      if (row.status !== 'active') continue;
      activeListing.add(row.user_id);
      if (row.original_price != null && Number(row.original_price) > Number(row.price)) {
        activePromo.add(row.user_id);
      }
    }
  }

  return { anyListing, activeListing, activePromo };
}

async function fetchOrderActivityForUsers(supabase, userIds) {
  const validOrder = new Set();
  const cancelledOrder = new Set();

  for (const chunk of splitIntoChunks(userIds, SUBSCRIPTION_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('orders')
      .select('buyer_id, status')
      .in('buyer_id', chunk);

    if (error) throw new Error(`Erreur lecture commandes ciblées: ${error.message}`);

    for (const row of data || []) {
      if (!row.buyer_id) continue;
      if (row.status === 'cancelled') cancelledOrder.add(row.buyer_id);
      else validOrder.add(row.buyer_id);
    }
  }

  return { validOrder, cancelledOrder };
}

function matchesSegment(uid, segment, activity) {
  const { anyListing, activeListing, activePromo, validOrder, cancelledOrder } = activity;
  if (segment === 'dormant') {
    return !anyListing.has(uid) && !validOrder.has(uid);
  }
  if (segment === 'seller_no_promo') {
    return activeListing.has(uid) && !activePromo.has(uid);
  }
  if (segment === 'buyer_cancelled') {
    return cancelledOrder.has(uid) && !validOrder.has(uid);
  }
  return activeListing.has(uid);
}

/**
 * Repli borné sans scan global de base lorsque la RPC SQL n'est pas encore déployée :
 * charge uniquement les `user_id` abonnés puis filtre par lots de 200 utilisateurs.
 */
async function fetchRecipientsViaBatchedQueries(supabase, segment) {
  const { data: subsData, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('user_id')
    .eq('is_active', true)
    .or('app_type.is.null,app_type.eq.market');

  if (subsError) {
    throw new Error(`Erreur lecture abonnements push: ${subsError.message}`);
  }

  const subscribedIds = Array.from(
    new Set((subsData || []).map((s) => s.user_id).filter(Boolean))
  );
  if (subscribedIds.length === 0) return [];

  const needOrders = segment === 'dormant' || segment === 'buyer_cancelled';
  const needListings = segment !== 'buyer_cancelled';

  const [listingActivity, orderActivity] = await Promise.all([
    needListings
      ? fetchListingActivityForUsers(supabase, subscribedIds)
      : Promise.resolve({ anyListing: new Set(), activeListing: new Set(), activePromo: new Set() }),
    needOrders
      ? fetchOrderActivityForUsers(supabase, subscribedIds)
      : Promise.resolve({ validOrder: new Set(), cancelledOrder: new Set() }),
  ]);

  const activity = { ...listingActivity, ...orderActivity };
  const matchingIds = subscribedIds.filter((uid) => matchesSegment(uid, segment, activity));
  if (matchingIds.length === 0) return [];

  const users = [];
  for (const chunk of splitIntoChunks(matchingIds, SUBSCRIPTION_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, shop_name, shop_slug')
      .in('id', chunk)
      .neq('banned', true)
      .is('deleted_at', null);

    if (error) throw new Error(`Erreur lecture profils utilisateurs: ${error.message}`);
    if (data) users.push(...data);
  }

  return users;
}

/**
 * Récupère les utilisateurs éligibles d'un segment via la RPC SQL filtrée
 * `get_campaign_target_user_ids` (avec repli par lots bornés si RPC absente).
 * @param {object} supabase Client Supabase Admin
 * @param {string} segment Identifiant du segment cible
 * @returns {Promise<Array<object>>} Liste dédoublonnée des profils éligibles
 */
async function fetchCampaignSegmentRecipients(supabase, segment) {
  if (!VALID_SEGMENTS.includes(segment)) {
    throw new Error(`Segment inconnu : ${segment}`);
  }

  const { data: rpcUsers, error: rpcError } = await supabase.rpc('get_campaign_target_user_ids', {
    p_segment: segment,
  });

  if (!rpcError && Array.isArray(rpcUsers)) {
    return rpcUsers;
  }

  const isMissingRpc =
    rpcError?.code === '42883' ||
    rpcError?.code === 'PGRST202' ||
    String(rpcError?.message || '').includes('get_campaign_target_user_ids');

  if (!isMissingRpc) {
    throw new Error(`Erreur RPC ciblage campagne: ${rpcError?.message || 'inconnue'}`);
  }

  console.warn('[PushCampaigns] RPC get_campaign_target_user_ids absente, repli par lots bornés.');
  return fetchRecipientsViaBatchedQueries(supabase, segment);
}

/**
 * Exécute ou prévisualise une campagne push personnalisée par segment.
 * @param {object} config Configuration de la campagne
 * @returns {Promise<object>} Résultat d'aperçu ou rapport d'envoi
 */
async function executeSegmentedPushCampaign(config) {
  const { segment, title, body, url = '/', dryRun = false } = config || {};
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    throw new Error('Base de données indisponible');
  }

  const recipients = await fetchCampaignSegmentRecipients(supabase, segment);
  const samples = recipients.slice(0, 3).map((user) => ({
    userId: user.id,
    recipientName: resolveRecipientDisplayName(user),
    title: renderCampaignTemplate(title, user),
    body: renderCampaignTemplate(body, user),
    url: resolveRecipientTargetUrl(url, user),
  }));

  if (dryRun || recipients.length === 0) {
    return {
      success: true,
      dryRun: Boolean(dryRun),
      segment,
      recipientsCount: recipients.length,
      sent: 0,
      samples,
    };
  }

  const dispatchResults = await runWithConcurrency(
    recipients,
    (user) =>
      sendPushToUser(
        user.id,
        {
          title: renderCampaignTemplate(title, user),
          body: renderCampaignTemplate(body, user),
          url: resolveRecipientTargetUrl(url, user),
          tag: `campaign-${segment}`,
          icon: '/web-app-manifest-192x192.png',
        },
        { appType: 'market' }
      ),
    DEFAULT_PUSH_CONCURRENCY
  );

  const devicesSent = dispatchResults.reduce(
    (acc, r) => acc + (r.status === 'fulfilled' && r.value?.sent ? r.value.sent : 0),
    0
  );

  return {
    success: true,
    dryRun: false,
    segment,
    recipientsCount: recipients.length,
    sent: devicesSent,
    samples,
  };
}

module.exports = {
  VALID_SEGMENTS,
  renderCampaignTemplate,
  fetchCampaignSegmentRecipients,
  executeSegmentedPushCampaign,
};
