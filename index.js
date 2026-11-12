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

// 2. Limiteur global & Parser JSON (avec conservation du rawBody pour HMAC)
app.use(globalLimiter);
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
}));

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
app.use('/', require('./routes/admin-orders'));
app.use('/', require('./routes/engagement'));

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

// 8. Balayage automatique (toutes les 15 min) des courses acceptées mais non ramassées > 3h30 (210 min)
const STALE_PICKUP_TIMEOUT_MS = 210 * 60 * 1000;
async function sweepStaleAcceptedDeliveries() {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) return;
    const cutoffIso = new Date(Date.now() - STALE_PICKUP_TIMEOUT_MS).toISOString();
    const { data: staleRows } = await supabase
      .from('delivery_assignments')
      .select('id, accepted_at, updated_at, created_at')
      .eq('status', 'accepted');

    if (!Array.isArray(staleRows) || staleRows.length === 0) return;

    const expiredIds = staleRows
      .filter((row) => {
        const ts = row.accepted_at || row.updated_at || row.created_at;
        return ts && new Date(ts).toISOString() <= cutoffIso;
      })
      .map((row) => row.id);

    if (expiredIds.length === 0) return;

    const { error } = await supabase
      .from('delivery_assignments')
      .update({
        status: 'awaiting_pickup',
        delivery_person_id: null,
        accepted_at: null,
        pickup_otp_attempts: 0,
        updated_at: new Date().toISOString(),
      })
      .in('id', expiredIds)
      .eq('status', 'accepted');

    if (!error) {
      console.log(`[Delivery Timeout Sweep] ${expiredIds.length} course(s) remise(s) en ligne après 3h30 sans retrait.`);
    }
  } catch (err) {
    console.warn('[Delivery Timeout Sweep] Erreur non-bloquante:', err.message);
  }
}

setInterval(sweepStaleAcceptedDeliveries, 15 * 60 * 1000);
setTimeout(sweepStaleAcceptedDeliveries, 10_000);

module.exports = app;
