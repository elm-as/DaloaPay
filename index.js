/**
 * API Principale DaloaMarket & DaloaDelivery — Railway Server
 *
 * Architecture modulaire conforme à la charte ElmasCore (< 350 lignes par fichier).
 * Organisation par domaine : config/, middlewares/, services/, routes/.
 */

const dns = require('dns');
const express = require('express');

// Node 18+ fetch() préfère l'IPv6, ce qui fait planter les requêtes vers MoneyFusion sur Render/Railway
dns.setDefaultResultOrder('ipv4first');

const { ENV, getSupabaseAdminClient } = require('./config/env');
const { corsMiddleware, corsOptions } = require('./config/cors');
const cors = require('cors');
const { globalLimiter } = require('./config/rate-limiters');
const { createIpBanMiddleware } = require('./ipBanMiddleware');

// SEO Prerender helpers
const { isBot } = require('./seo/botDetector');
const { renderCategoryPage } = require('./seo/marketPrerender');
const { renderDriverProfile } = require('./seo/deliveryPrerender');

const app = express();
app.set('trust proxy', 1);

// 1. CORS
app.use(corsMiddleware);
app.options('*', cors(corsOptions));

// 2. Limiteur global & Parser JSON
app.use(globalLimiter);
app.use(express.json());

// 3. Contrôle du bannissement d'IP
app.use(createIpBanMiddleware(getSupabaseAdminClient()));

// 4. Interception pour les robots SEO (Googlebot, WhatsApp, Facebook...)
app.use(async (req, res, next) => {
  const ua = req.get('user-agent') || '';
  const isBotDetected = isBot(ua);

  if (!isBotDetected) return next();

  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return next();

    const path = req.path;

    // A. DaloaDelivery : Profil Livreur (/livreur/:id)
    if (path.startsWith('/livreur/')) {
      const driverId = path.split('/')[2];
      if (driverId) {
        const html = await renderDriverProfile(supabase, driverId);
        return res.send(html);
      }
    }

    // B. DaloaMarket : Catégorie (/c/:slug, /categorie/:slug ou /mode, /electronique...)
    let categorySlug = null;
    if (path.startsWith('/c/')) {
      categorySlug = path.split('/')[2];
    } else if (path.startsWith('/categorie/')) {
      categorySlug = path.split('/')[2];
    } else {
      const catRoutes = ['electronique', 'vehicules', 'mode', 'cosmetiques', 'maison-deco', 'sports-loisirs', 'livres', 'alimentaire'];
      const rawSlug = path.replace(/^\//, '').toLowerCase();
      if (catRoutes.includes(rawSlug)) {
        categorySlug = rawSlug;
      } else if (req.query.category) {
        categorySlug = req.query.category;
      }
    }

    if (categorySlug) {
      const html = await renderCategoryPage(supabase, categorySlug);
      return res.send(html);
    }
  } catch (err) {
    console.error('[SEO Bot Prerender Error]:', err);
  }

  next();
});

// 5. Montage des routeurs par domaine
app.use('/', require('./routes/health'));
app.use('/', require('./routes/payments'));
app.use('/', require('./routes/payment-status'));
app.use('/', require('./routes/payment-webhook'));
app.use('/', require('./routes/payouts'));
app.use('/', require('./routes/notifications'));
app.use('/', require('./routes/channels'));

// 6. Gestionnaire d'erreurs global
app.use((err, req, res, next) => {
  console.error('[Server Unhandled Error]:', err);
  res.status(500).json({ success: false, message: err.message || 'Erreur interne du serveur' });
});

// 7. Démarrage de l'écoute HTTP
const PORT = ENV.PORT;
console.log('FUSION_API_URL from env:', JSON.stringify(ENV.FUSION_API_URL));
console.log('SUPABASE_URL from env:', JSON.stringify(ENV.SUPABASE_URL));
app.listen(PORT, () => console.log(`Payment & Push API running on port ${PORT}`));

module.exports = app;
