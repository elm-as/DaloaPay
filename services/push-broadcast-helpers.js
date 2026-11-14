const {
  splitIntoChunks,
  resolveRecipientDisplayName,
  renderPayloadForUser,
} = require('./push-template');

const PROFILE_CHUNK_SIZE = 200;

/**
 * Déduplique les abonnements push en priorisant l'app native Expo sur le web mobile.
 * @param {Array<object>} subs Liste brute des abonnements actifs
 * @returns {Array<object>} Abonnements dédoublonnés
 */
function deduplicateBroadcastSubscriptions(subs) {
  const usersWithExpo = new Set();
  const expoSubsByUserApp = new Map();

  for (const sub of subs) {
    if (!sub.expo_push_token) continue;
    const key = `${sub.user_id}_${sub.app_type || 'market'}`;
    if (!expoSubsByUserApp.has(key)) {
      expoSubsByUserApp.set(key, sub);
      usersWithExpo.add(sub.user_id);
    }
  }

  const uniqueSubs = Array.from(expoSubsByUserApp.values());
  const seenEndpoints = new Set();

  for (const sub of subs) {
    if (!sub.endpoint || seenEndpoints.has(sub.endpoint)) continue;
    seenEndpoints.add(sub.endpoint);
    const isMobileWeb =
      sub.user_agent && (sub.user_agent.includes('Android') || sub.user_agent.includes('Mobile'));
    if (usersWithExpo.has(sub.user_id) && isMobileWeb) continue;
    uniqueSubs.push(sub);
  }

  return uniqueSubs;
}

/**
 * Charge par lots de 200 les profils nécessaires au rendu des variables (`$nom`, `$lien`).
 * @param {object} supabase Client Supabase service_role
 * @param {Array<object>} subs Abonnements dédoublonnés
 * @returns {Promise<{ userMap: Map<string, object>, excludedUserIds: Set<string> }>}
 */
async function fetchBroadcastProfilesMap(supabase, subs) {
  const userIds = Array.from(new Set(subs.map((s) => s.user_id).filter(Boolean)));
  const userMap = new Map();
  const excludedUserIds = new Set();

  for (const chunk of splitIntoChunks(userIds, PROFILE_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, shop_name, shop_slug, banned, deleted_at')
      .in('id', chunk);

    if (error) {
      console.warn('[Push] Erreur lecture profils broadcast:', error.message);
      continue;
    }

    for (const user of data || []) {
      if (user.banned || user.deleted_at) {
        excludedUserIds.add(user.id);
        continue;
      }
      userMap.set(user.id, user);
    }
  }

  return { userMap, excludedUserIds };
}

/**
 * Génère un aperçu dry-run sur 3 destinataires distincts d'une diffusion globale.
 */
function buildBroadcastDryRunPreview(activeSubs, userMap, payload) {
  const distinctUserIds = Array.from(new Set(activeSubs.map((s) => s.user_id).filter(Boolean)));
  const samples = distinctUserIds.slice(0, 3).map((userId) => {
    const user = userMap.get(userId) || { id: userId };
    const rendered = renderPayloadForUser(payload, user);
    return {
      userId,
      recipientName: resolveRecipientDisplayName(user),
      title: rendered.title,
      body: rendered.body,
      url: rendered.url || '/',
    };
  });

  return {
    success: true,
    dryRun: true,
    recipientsCount: distinctUserIds.length,
    devicesCount: activeSubs.length,
    sent: 0,
    samples,
  };
}

module.exports = {
  deduplicateBroadcastSubscriptions,
  fetchBroadcastProfilesMap,
  buildBroadcastDryRunPreview,
};
