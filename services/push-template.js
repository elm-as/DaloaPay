const { ENV } = require('../config/env');

const SUPPORT_WHATSAPP_NUMBER = '+225 07 04 16 33 61';
const OFFICIAL_WHATSAPP_CHANNEL = 'https://whatsapp.com/channel/0029Vb94o2vJENy5kkADR42U';

const TEMPLATE_VARIABLE_REGEX =
  /\{\{?nom\}?\}|\$\{nom\}|\$nom\b|\{\{?lien\}?\}|\$\{lien\}|\$lien\b|\{\{?chaine(?:\s*wa)?\}?\}|\$\{chaine(?:\s*wa)?\}|\$chaine(?:\s*wa)?\b|\{\{?\+?numero(?:\s*wa)?\}?\}|\$\{\+?numero(?:\s*wa)?\}|\$\+?numero(?:\s*wa)?\b/i;

/**
 * Découpe un tableau en lots de taille bornée.
 * @param {Array} items Éléments à découper
 * @param {number} size Taille maximale par lot
 * @returns {Array<Array>} Lots successifs
 */
function splitIntoChunks(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Extrait le prénom ou nom d'affichage d'un utilisateur pour personnaliser sa notification.
 * @param {object} user Enregistrement issu de `public.users`
 * @returns {string} Prénom ou nom de boutique, avec repli professionnel sur "client"
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
  return 'client';
}

/**
 * Construit le lien public de partage de la boutique d'un vendeur (sans protocole pour rester lisible en push).
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
 * Remplace les variables dynamiques (`$nom`, `{nom}`, `${nom}`, `$lien`, `$chaine`, `$numero`)
 * dans un texte de notification. Fonction pure : ne mute aucun argument.
 * @param {string} template Texte contenant des variables
 * @param {object} user Enregistrement utilisateur (`id`, `full_name`, `shop_name`, `shop_slug`)
 * @returns {string} Texte personnalisé prêt à l'envoi
 */
function renderCampaignTemplate(template, user) {
  if (!template) return '';
  const displayName = resolveRecipientDisplayName(user);
  const shopLink = buildRecipientShopShareLink(user);

  return String(template)
    .replace(/\{\{nom\}\}|\$\{nom\}|\{nom\}|\$nom\b/gi, displayName)
    .replace(/\{\{lien\}\}|\$\{lien\}|\{lien\}|\$lien\b/gi, shopLink)
    .replace(/\{\{chaine(?:\s*wa)?\}\}|\$\{chaine(?:\s*wa)?\}|\{chaine(?:\s*wa)?\}|\$chaine(?:\s*wa)?\b/gi, OFFICIAL_WHATSAPP_CHANNEL)
    .replace(/\{\{\+?numero(?:\s*wa)?\}\}|\$\{\+?numero(?:\s*wa)?\}|\{\+?numero(?:\s*wa)?\}|\$\+?numero(?:\s*wa)?\b/gi, SUPPORT_WHATSAPP_NUMBER);
}

/**
 * Construit le chemin d'ouverture au clic adapté au destinataire.
 * @param {string} rawUrl URL ou route configurée
 * @param {object} user Enregistrement issu de `public.users`
 * @returns {string} URL ou chemin résolu
 */
function resolveRecipientTargetUrl(rawUrl, user) {
  const cleanUrl = String(rawUrl || '/').trim() || '/';
  return renderCampaignTemplate(cleanUrl, user);
}

/**
 * Indique si au moins un champ texte du payload contient une variable dynamique.
 * @param {object} payload Payload de notification push
 * @returns {boolean} True si une substitution par destinataire est requise
 */
function hasTemplateVariables(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return [payload.title, payload.body, payload.subtitle, payload.url]
    .some((field) => typeof field === 'string' && TEMPLATE_VARIABLE_REGEX.test(field));
}

/**
 * Retourne un nouveau payload personnalisé pour un utilisateur sans muter l'objet source.
 * @param {object} payload Payload de base
 * @param {object} user Profil destinataire
 * @returns {object} Payload cloné avec variables résolues
 */
function renderPayloadForUser(payload, user) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    ...payload,
    title: payload.title ? renderCampaignTemplate(payload.title, user) : payload.title,
    body: payload.body ? renderCampaignTemplate(payload.body, user) : payload.body,
    subtitle: payload.subtitle ? renderCampaignTemplate(payload.subtitle, user) : payload.subtitle,
    url: payload.url ? resolveRecipientTargetUrl(payload.url, user) : payload.url,
  };
}

module.exports = {
  splitIntoChunks,
  resolveRecipientDisplayName,
  buildRecipientShopShareLink,
  renderCampaignTemplate,
  resolveRecipientTargetUrl,
  hasTemplateVariables,
  renderPayloadForUser,
};
