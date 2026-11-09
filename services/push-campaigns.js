const { ENV, getSupabaseAdminClient } = require('../config/env');
const { sendPushToUser } = require('./push');

const SUPPORT_WHATSAPP_NUMBER = '+225 07 04 16 33 61';
const OFFICIAL_WHATSAPP_CHANNEL = 'https://whatsapp.com/channel/0029Vb94o2vJENy5kkADR42U';
const VALID_SEGMENTS = ['dormant', 'active_seller'];

/**
 * Extrait le prénom ou nom d'affichage d'un utilisateur pour personnaliser sa notification.
 * @param {object} user Enregistrement issu de `public.users`
 * @returns {string} Prénom ou nom de boutique, avec repli sur "l'ami"
 */
function resolveRecipientDisplayName(user) {
  const fullName = String(user?.full_name || '').trim();
  if (fullName) {
    return fullName.split(/\s+/)[0];
  }
  const shopName = String(user?.shop_name || '').trim();
  if (shopName) {
    return shopName;
  }
  return "l'ami";
}

/**
 * Construit le lien public de partage de la boutique d'un vendeur (sans https:// pour tenir dans une notif).
 * @param {object} user Enregistrement issu de `public.users`
 * @returns {string} Lien court de la boutique (ex: daloamarket.com/shop/ma-boutique)
 */
function buildRecipientShopShareLink(user) {
  const baseHost = String(ENV.SITE_URL || 'https://daloamarket.com')
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '');
  const slug = String(user?.shop_slug || '').trim();
  if (slug) {
    return `${baseHost}/shop/${slug}`;
  }
  const rawId = String(user?.id || '').trim();
  const shortId = rawId.length >= 8 ? rawId.slice(0, 8) : rawId;
  return shortId ? `${baseHost}/b/${shortId}` : baseHost;
}

/**
 * Construit le chemin d'ouverture au clic adapté au destinataire.
 * Remplace les variables dynamiques éventuellement présentes dans l'URL.
 * @param {string} rawUrl URL ou route configurée dans la campagne
 * @param {object} user Enregistrement issu de `public.users`
 * @returns {string} URL ou chemin résolu
 */
function resolveRecipientTargetUrl(rawUrl, user) {
  const cleanUrl = String(rawUrl || '/').trim() || '/';
  return renderCampaignTemplate(cleanUrl, user);
}

/**
 * Remplace les variables dynamiques (`$nom`, `{nom}`, `$lien`, `{lien}`,
 * `$chaine`, `{chaine}`, `$numero`, `{numero}`) dans un texte de notification.
 * Fonction pure : ne mute aucun argument.
 * @param {string} template Texte contenant des variables
 * @param {object} user Enregistrement utilisateur (`id`, `full_name`, `shop_name`, `shop_slug`)
 * @returns {string} Texte personnalisé prêt à l'envoi
 */
function renderCampaignTemplate(template, user) {
  if (!template) return '';
  const displayName = resolveRecipientDisplayName(user);
  const shopLink = buildRecipientShopShareLink(user);

  return String(template)
    .replace(/\{nom\}|\$nom\b/gi, displayName)
    .replace(/\{lien\}|\$lien\b/gi, shopLink)
    .replace(/\{chaine(?:\s*wa)?\}|\$chaine(?:\s*wa)?\b/gi, OFFICIAL_WHATSAPP_CHANNEL)
    .replace(/\{\+?numero(?:\s*wa)?\}|\$\+?numero(?:\s*wa)?\b/gi, SUPPORT_WHATSAPP_NUMBER);
}

/**
 * Récupère les utilisateurs disposant d'au moins un abonnement push actif sur DaloaMarket
 * et les filtre selon le segment demandé :
 * - `dormant` : 0 annonce publiée ET 0 commande passée
 * - `active_seller` : au moins 1 annonce active en ligne
 * @param {object} supabase Client Supabase Admin
 * @param {'dormant'|'active_seller'} segment Identifiant du segment cible
 * @returns {Promise<Array<object>>} Liste dédoublonnée des profils éligibles
 */
async function fetchCampaignSegmentRecipients(supabase, segment) {
  if (!VALID_SEGMENTS.includes(segment)) {
    throw new Error(`Segment inconnu : ${segment}`);
  }

  const [subsRes, listingsRes, ordersRes] = await Promise.all([
    supabase
      .from('push_subscriptions')
      .select('user_id, app_type')
      .eq('is_active', true),
    supabase
      .from('listings')
      .select('user_id, status')
      .neq('status', 'deleted'),
    supabase
      .from('orders')
      .select('buyer_id, status')
      .neq('status', 'cancelled'),
  ]);

  if (subsRes.error) throw new Error(`Erreur lecture abonnements push: ${subsRes.error.message}`);
  if (listingsRes.error) throw new Error(`Erreur lecture annonces: ${listingsRes.error.message}`);
  if (ordersRes.error) throw new Error(`Erreur lecture commandes: ${ordersRes.error.message}`);

  const subscribedMarketUserIds = new Set(
    (subsRes.data || [])
      .filter((s) => s.user_id && (s.app_type || 'market') === 'market')
      .map((s) => s.user_id)
  );

  if (subscribedMarketUserIds.size === 0) {
    return [];
  }

  const usersWithAnyListing = new Set();
  const usersWithActiveListing = new Set();
  for (const row of listingsRes.data || []) {
    if (!row.user_id) continue;
    usersWithAnyListing.add(row.user_id);
    if (row.status === 'active') {
      usersWithActiveListing.add(row.user_id);
    }
  }

  const usersWithAnyOrder = new Set(
    (ordersRes.data || []).map((o) => o.buyer_id).filter(Boolean)
  );

  const matchingUserIds = Array.from(subscribedMarketUserIds).filter((uid) => {
    if (segment === 'dormant') {
      return !usersWithAnyListing.has(uid) && !usersWithAnyOrder.has(uid);
    }
    return usersWithActiveListing.has(uid);
  });

  if (matchingUserIds.length === 0) {
    return [];
  }

  const { data: users, error: usersErr } = await supabase
    .from('users')
    .select('id, full_name, shop_name, shop_slug')
    .in('id', matchingUserIds);

  if (usersErr) {
    throw new Error(`Erreur lecture profils utilisateurs: ${usersErr.message}`);
  }

  return users || [];
}

/**
 * Exécute ou prévisualise une campagne push personnalisée par segment.
 * @param {object} config Configuration de la campagne
 * @param {'dormant'|'active_seller'} config.segment Segment cible
 * @param {string} config.title Modèle de titre (supporte `$nom`, `$lien`, etc.)
 * @param {string} config.body Modèle de message (supporte `$nom`, `$lien`, etc.)
 * @param {string} [config.url] Lien d'ouverture au clic
 * @param {boolean} [config.dryRun] Si vrai, retourne uniquement le nombre de cibles et 3 aperçus
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

  const dispatchResults = await Promise.allSettled(
    recipients.map((user) =>
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
      )
    )
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

