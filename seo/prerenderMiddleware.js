const { getSupabaseAdminClient } = require('../config/env');
const { isBot } = require('./botDetector');
const { renderCategoryPage } = require('./marketPrerender');
const { renderDriverProfile } = require('./deliveryPrerender');

const CATEGORY_SLUGS = [
  'electronique',
  'vehicules',
  'mode',
  'cosmetiques',
  'maison-deco',
  'sports-loisirs',
  'livres',
  'alimentaire',
];

function extractCategorySlug(req) {
  const path = req.path || '';
  if (path.startsWith('/c/') || path.startsWith('/categorie/')) {
    return path.split('/')[2] || null;
  }
  const rawSlug = path.replace(/^\//, '').toLowerCase();
  if (CATEGORY_SLUGS.includes(rawSlug)) {
    return rawSlug;
  }
  return req.query?.category ? String(req.query.category) : null;
}

/**
 * Middleware d'interception des robots SEO (Googlebot, WhatsApp, etc.)
 * découplé du bootstrap serveur principal.
 */
async function seoPrerenderMiddleware(req, res, next) {
  const userAgent = req.get('user-agent') || '';
  if (!isBot(userAgent)) return next();

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return next();

    const path = req.path || '';
    if (path.startsWith('/livreur/')) {
      const driverId = path.split('/')[2];
      if (driverId) {
        return res.send(await renderDriverProfile(supabase, driverId));
      }
    }

    const categorySlug = extractCategorySlug(req);
    if (categorySlug) {
      return res.send(await renderCategoryPage(supabase, categorySlug));
    }
  } catch (err) {
    console.error('[SEO Bot Prerender Error]:', err);
  }

  return next();
}

module.exports = { seoPrerenderMiddleware };
