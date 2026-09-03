const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
const rateLimit = require('express-rate-limit');
const webpush = require('web-push');
require('dotenv').config();

// Node 18+ fetch() préfère l'IPv6, ce qui fait planter les requêtes vers MoneyFusion sur Render
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.set('trust proxy', 1);

// --- RATE LIMITERS ---
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requêtes par 15 min par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes globales. Veuillez patienter.' }
});

const createPaymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Max 10 créations de paiement par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop d\'intentions de paiement générées. Veuillez patienter 1 minute.' }
});

const checkPaymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Max 30 vérifications de paiement par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de vérifications de statut de paiement.' }
});

const payoutLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Max 5 appels de payout par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Limite de traitement de payouts atteinte.' }
});

app.use(globalLimiter);
app.use(cors());
app.use(express.json());

// --- SEO BOT PRERENDER MIDDLEWARE ---
const { isBot } = require('./seo/botDetector');
const { renderCategoryPage } = require('./seo/marketPrerender');
const { renderDriverProfile } = require('./seo/deliveryPrerender');

// Middleware d'interception pour les robots (Googlebot, WhatsApp, Facebook, etc.)
app.use(async (req, res, next) => {
  const ua = req.get('user-agent') || '';
  const isBotDetected = isBot(ua);
  console.log(`[SEO Prerender Check] Path: ${req.path} | IsBot: ${isBotDetected} | UA: ${ua.slice(0, 60)}`);

  if (!isBotDetected) return next();

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const path = req.path;

    // 1. DaloaDelivery : Profil Livreur (/livreur/:id)
    if (path.startsWith('/livreur/')) {
      const driverId = path.split('/')[2];
      if (driverId) {
        const html = await renderDriverProfile(supabase, driverId);
        return res.send(html);
      }
    }

    // 2. DaloaMarket : Catégorie (/c/:slug, /categorie/:slug ou /mode, /electronique, etc.)
    let categorySlug = null;
    if (path.startsWith('/c/')) {
      categorySlug = path.split('/')[2];
    } else if (path.startsWith('/categorie/')) {
      categorySlug = path.split('/')[2];
    } else {
      const catRoutes = ['electronique', 'vehicules', 'mode', 'maison-deco', 'sports-loisirs', 'livres', 'alimentaire'];
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
    console.error('SEO Bot prerender error:', err);
  }

  next();
});

// Variables d'environnement (à configurer dans le tableau de bord d'hébergement)
const FUSION_API_URL = process.env.FUSION_API_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://daloamarket.com';

// --- WEB PUSH CONFIGURATION (VAPID) ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contact@daloamarket.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    console.log('[WebPush] VAPID configured successfully from env');
  } catch (vapidErr) {
    console.error('[WebPush] Error setting VAPID details:', vapidErr);
  }
} else {
  console.warn('[WebPush Warning] VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY is missing from environment variables.');
}

async function sendExpoPush(expoPushToken, payload) {
  try {
    if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) {
      return { success: false, message: 'Format token Expo invalide' };
    }

    const expoMessage = {
      to: expoPushToken,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: {
        url: payload.url || '/',
        tag: payload.tag,
        orderId: payload.orderId || (payload.url && payload.url.includes('/suivi/') ? payload.url.split('/suivi/')[1] : null),
        chatPartnerId: payload.chatPartnerId || (payload.url && payload.url.includes('/messages/') ? payload.url.split('/messages/')[1] : null),
      },
      priority: 'high',
      channelId: 'default',
    };

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(expoMessage),
    });

    const data = await res.json();
    if (data?.data?.status === 'ok') {
      return { success: true };
    } else {
      console.warn('[ExpoPush] Push send warning:', data?.data?.message || data?.errors);
      return { success: false, error: data?.data?.message };
    }
  } catch (err) {
    console.error('[ExpoPush] Exception:', err.message);
    return { success: false, error: err.message };
  }
}

async function dispatchPush(sub, payload) {
  if (sub.expo_push_token) {
    return sendExpoPush(sub.expo_push_token, payload);
  } else if (sub.endpoint) {
    return sendWebPush(sub, payload);
  }
  return { success: false, message: 'Aucun token valide' };
}

async function sendWebPush(subscription, payload) {
  try {
    const pushSubscription = {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys_p256dh,
        auth: subscription.keys_auth,
      },
    };
    const stringPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await webpush.sendNotification(pushSubscription, stringPayload);
    return { success: true };
  } catch (err) {
    const status = err.statusCode || err.status;
    const body = err.body || err.message;
    console.error(`[WebPush] Error (${status}): ${body} (endpoint: ${subscription.endpoint?.slice(0, 50)}...)`);

    // Si la souscription est invalide, expirée ou créée avec une ancienne clé VAPID (401/403/404/410)
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      console.log(`[WebPush] Cleaning up invalid/stale subscription (${status})`);
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
      } catch (delErr) {
        console.error('[WebPush] Error deleting invalid subscription:', delErr);
      }
    }
    return { success: false, error: err.message, statusCode: status };
  }
}

async function sendPushToUser(userId, payload) {
  if (!userId) return { success: false, message: 'Identifiant utilisateur requis' };
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error(`[Push] Erreur DB pour user ${userId}:`, error.message);
      return { success: false, error: error.message };
    }

    if (!subs || subs.length === 0) {
      console.log(`[Push] ⚠️ Aucun abonnement push trouvé en base pour l'utilisateur ${userId}.`);
      return { success: true, sent: 0, message: 'Aucun abonnement push trouvé pour cet utilisateur' };
    }

    console.log(`[Push] 🚀 Envoi de la notification à ${subs.length} appareil(s) pour l'utilisateur ${userId}...`);
    const results = await Promise.allSettled(subs.map(sub => dispatchPush(sub, payload)));
    const sentCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    console.log(`[Push] ✅ Résultat envoi user ${userId}: ${sentCount}/${subs.length} délivré(s).`);
    return { success: true, sent: sentCount, total: subs.length };
  } catch (err) {
    console.error('[Push] sendPushToUser failed:', err);
    return { success: false, error: err.message };
  }
}

async function broadcastPush(payload) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*');

    if (error || !subs || subs.length === 0) {
      return { success: true, sent: 0, message: 'Aucun abonnement push actif trouvé' };
    }

    const results = await Promise.allSettled(subs.map(sub => dispatchPush(sub, payload)));
    const sentCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    return { success: true, sent: sentCount, total: subs.length };
  } catch (err) {
    console.error('[Push] broadcastPush failed:', err);
    return { success: false, error: err.message };
  }
}

// Validation config
function checkConfig() {
  console.log('Checking config...');
  if (!FUSION_API_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Config incomplete: FUSION_API_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required');
  }
}

// --- PRICING CONSTANTS (SYNC WITH src/lib/pricing.ts) ---
const PRICING = {
  DELIVERY_MIN: 500,
  DELIVERY_RATE_PER_KM: 85,
  DELIVERY_FREE_KM: 1.5,
  BUYER_FEE_RATE: 0.0, // Annulé côté acheteur pour supprimer les frais
  SELLER_FEE_RATE: 0.035,
  PRO_SELLER_FEE_RATE: 0.025,
  DRIVER_FEE_RATE: 0.10
};

// --- Distance Calculation (Haversine) ---
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateDeliveryFee(distanceKm) {
  const baseFee = PRICING.DELIVERY_MIN;
  let extraFee = 0;
  if (distanceKm > PRICING.DELIVERY_FREE_KM) {
    extraFee = Math.round((distanceKm - PRICING.DELIVERY_FREE_KM) * PRICING.DELIVERY_RATE_PER_KM);
  }
  return baseFee + extraFee;
}

// --- Helpers ---
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * Crée l'order + delivery_assignment UNIQUEMENT quand le paiement est confirmé.
 * Idempotent : si l'escrow a déjà un order_id, on ne recrée pas.
 * @returns {string} order_id
 */
async function createOrderFromEscrow(supabase, escrow, personalInfo) {
  // Idempotence : si l'order existe déjà, on retourne directement
  if (escrow.order_id) {
    return escrow.order_id;
  }

  const meta = escrow.order_metadata || {};

  // Créer l'order
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert({
      buyer_id: escrow.buyer_id,
      seller_id: escrow.seller_id,
      listing_id: meta.listing_id,
      variant_id: meta.variant_id || null,
      variant_label: meta.variant_label || null,
      unit_price: meta.unit_price || null,
      quantity: Math.max(1, Number(meta.quantity) || 1),
      product_amount: meta.product_amount || (escrow.total_amount - escrow.delivery_fee - escrow.platform_fee),
      delivery_fee: escrow.delivery_fee,
      platform_commission: escrow.platform_fee,
      total_amount: escrow.total_amount,
      delivery_address: meta.delivery_address || personalInfo?.delivery_address || 'Daloa',
      delivery_mode: meta.delivery_mode || personalInfo?.delivery_mode || 'delivery',
      status: 'paid'  // ← directement "paid" puisque le paiement est confirmé
    })
    .select('id')
    .single();

  if (orderErr || !order) {
    console.error('Order creation error:', orderErr);
    throw new Error('Erreur création order: ' + (orderErr?.message || 'unknown'));
  }

  // Lier l'escrow à l'order
  await supabase
    .from('escrow_transactions')
    .update({ order_id: order.id, status: 'funded', funded_at: new Date().toISOString() })
    .eq('id', escrow.id);

  // Créer delivery_assignment
  const pickupOTP = generateOTP();
  const deliveryOTP = generateOTP();
  const address = meta.delivery_address || personalInfo?.delivery_address || 'Daloa';
  const deliveryLat = meta.delivery_lat || personalInfo?.delivery_lat || null;
  const deliveryLng = meta.delivery_lng || personalInfo?.delivery_lng || null;
  const distanceKm = meta.distance_km || null;
  const isPickup = (meta.delivery_mode || personalInfo?.delivery_mode) === 'pickup_point' || (meta.delivery_mode || personalInfo?.delivery_mode) === 'pickup';

  await supabase.from('delivery_assignments').insert({
    order_id: order.id,
    delivery_person_id: null,
    status: 'pending_seller_confirmation',
    pickup_confirmed_by_seller: isPickup,
    pickup_otp: pickupOTP,
    delivery_otp: deliveryOTP,
    pickup_otp_attempts: 0,
    delivery_otp_attempts: 0,
    pickup_location: 'Boutique du vendeur',
    dropoff_location: address || 'Retrait en boutique',
    delivery_price: escrow.delivery_fee || 0,
    seller_id: escrow.seller_id,
    is_private: isPickup,
  });

  // Notification push au vendeur
  if (escrow.seller_id) {
    supabase.from('listings').select('title').eq('id', meta.listing_id).maybeSingle().then(({ data: l }) => {
      const itemTitle = l?.title || 'Votre article';
      sendPushToUser(escrow.seller_id, {
        title: '🎉 Nouvelle commande reçue !',
        body: `Vous avez vendu "${itemTitle}" pour ${Number(escrow.total_amount || 0).toLocaleString('fr-FR')} FCFA.`,
        url: `/mes-commandes`,
        tag: `order-${order.id}`,
      }).catch(e => console.error('[Push Order Error]:', e));
    });
  }

  return order.id;
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'DaloaMarket Payment API' });
});

// 0) Diagnostic : IP publique du serveur (accessible uniquement hors production ou avec secret admin)
app.get('/ip', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès non autorisé en production.' });
  }
  try {
    const [v4, v6] = await Promise.allSettled([
      fetch('https://api.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'injoignable (api.ipify.org)' })),
      fetch('https://api64.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'N/A' })),
    ]);
    res.json({
      ipv4: v4.status === 'fulfilled' ? v4.value.ip : 'erreur',
      ipv6: v6.status === 'fulfilled' ? v6.value.ip : 'N/A',
    });
  } catch { res.json({ error: 'Impossible de récupérer l\'IP' }); }
});

// 0b) Diagnostic : Désactivé en production pour des raisons de sécurité
app.get('/config', (req, res) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès au diagnostic désactivé en production.' });
  }
  res.json({
    status: 'ok',
    FUSION_API_URL_SET: !!FUSION_API_URL,
    SUPABASE_URL_SET: !!SUPABASE_URL,
    SUPABASE_KEY_SET: !!SUPABASE_SERVICE_ROLE_KEY,
    SITE_URL,
    PORT: process.env.PORT || 3000,
  });
});

// 0c) Healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// 0d) Vérifier le statut d'un paiement (appelé par PaymentReturnPage)
// Si la DB est encore en "pending", on interroge Money Fusion directement
app.get('/check-payment', checkPaymentLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // MoneyFusion renvoie parfois le token dans 'txid' au lieu de notre transactionId
    const transactionId = req.query.transactionId || req.query.txid || req.query.token;
    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transactionId requis' });
    }

    const statusMap = {
      pending: 'pending',
      funded: 'paid',
      released: 'paid',
      cancelled: 'failure',
      failed: 'failure',
      confirmed: 'paid',
    };

    // Chercher d'abord dans escrow_transactions par id Supabase
    let { data: escrow } = await supabase
      .from('escrow_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    // Fallback : MoneyFusion a renvoyé son propre token → chercher par payment_reference
    if (!escrow) {
      const { data: escrowByRef } = await supabase
        .from('escrow_transactions')
        .select('*')
        .eq('payment_reference', transactionId)
        .maybeSingle();
      escrow = escrowByRef;
    }

    if (escrow) {
      // Si déjà payé (funded/released), renvoyer directement
      if (escrow.status !== 'pending') {
        return res.json({
          success: true,
          status: statusMap[escrow.status] || 'unknown',
          transactionId: escrow.id,
          order_id: escrow.order_id || null,
          amount: escrow.total_amount,
          paymentMethod: escrow.payment_method,
          confirmedAt: escrow.funded_at,
        });
      }

      // Si pending, vérifier chez Money Fusion avec le payment_reference
      if (escrow.payment_reference) {
        try {
          const fusionUrl = `https://pay.moneyfusion.net/paiementNotif/${escrow.payment_reference}`;
          console.log('check-payment: verifying with MoneyFusion:', fusionUrl);
          const fusionRes = await fetch(fusionUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'DaloaMarket-Server/1.0'
            }
          });
          const fusionData = await fusionRes.json().catch(() => null);

          if (fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid') {
            // ✅ Paiement confirmé → MAINTENANT on crée l'order
            console.log('check-payment: payment confirmed, creating order...');
            const orderId = await createOrderFromEscrow(supabase, escrow, null);

            return res.json({
              success: true,
              status: 'paid',
              transactionId: escrow.id,
              order_id: orderId,
              amount: escrow.total_amount,
              paymentMethod: escrow.payment_method,
              confirmedAt: new Date().toISOString(),
            });
          }

          if (fusionData && fusionData.data?.statut === 'failure') {
            await supabase
              .from('escrow_transactions')
              .update({ status: 'cancelled' })
              .eq('id', escrow.id);
            return res.json({ success: true, status: 'failure', transactionId: escrow.id });
          }
        } catch (fusionErr) {
          console.log('check-payment: MoneyFusion check failed, will retry later:', fusionErr.message);
        }
      }

      return res.json({
        success: true,
        status: 'pending',
        transactionId: escrow.id,
        amount: escrow.total_amount,
        paymentMethod: escrow.payment_method,
      });
    }

    // Chercher dans monetization_transactions
    let { data: tx } = await supabase
      .from('monetization_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (!tx) {
      const { data: txByRef } = await supabase
        .from('monetization_transactions')
        .select('*')
        .eq('provider_token', transactionId)
        .maybeSingle();
      tx = txByRef;
    }

    if (tx) {
      if (tx.status !== 'pending') {
        return res.json({
          success: true,
          status: statusMap[tx.status] || 'unknown',
          transactionId: tx.id,
          amount: tx.amount,
          confirmedAt: tx.confirmed_at,
        });
      }

      // Si pending, vérifier chez Money Fusion
      if (tx.provider_token) {
        try {
          const fusionUrl = `https://pay.moneyfusion.net/paiementNotif/${tx.provider_token}`;
          console.log('check-payment: verifying monetization with MoneyFusion:', fusionUrl);
          const fusionRes = await fetch(fusionUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'DaloaMarket-Server/1.0'
            }
          });
          const fusionData = await fusionRes.json().catch(() => null);

          if (fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid') {
            const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
            if (rpcByType[tx.type]) {
              await supabase.rpc(rpcByType[tx.type], { p_transaction_id: tx.id });
            } else if (tx.type === 'listing_pack_10') {
              await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 10 });
            } else if (tx.type === 'credits_pack_5') {
              await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 5 });
            } else if (tx.type === 'credits_pack_12') {
              await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 12 });
            } else if (tx.type === 'credits_pack_30') {
              await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 30 });
            }
            await supabase
              .from('monetization_transactions')
              .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
              .eq('id', tx.id);

            return res.json({
              success: true,
              status: 'paid',
              transactionId: tx.id,
              amount: tx.amount,
              confirmedAt: new Date().toISOString(),
            });
          }

          if (fusionData && fusionData.data?.statut === 'failure') {
            await supabase
              .from('monetization_transactions')
              .update({ status: 'failed' })
              .eq('id', tx.id);
            return res.json({ success: true, status: 'failure', transactionId: tx.id });
          }
        } catch (fusionErr) {
          console.log('check-payment: MoneyFusion check failed, will retry later:', fusionErr.message);
        }
      }

      return res.json({
        success: true,
        status: tx.status,
        transactionId: tx.id,
        amount: tx.amount,
      });
    }

    return res.status(404).json({ success: false, message: 'Transaction introuvable', status: 'unknown' });
  } catch (e) {
    console.error('ERROR /check-payment:', e.message || e);
    return res.status(500).json({ success: false, message: e.message, status: 'unknown' });
  }
});

// 1) Créer un paiement
// Pour les commandes (type='order'), on NE CRÉE PAS l'order en DB.
// On crée uniquement l'escrow_transaction comme "intention de paiement".
// L'order ne sera créé que quand Money Fusion confirme le paiement.
app.post('/create-payment', createPaymentLimiter, async (req, res) => {
  console.log('POST /create-payment received', req.body);
  try {
    checkConfig();
    const { type, amount, customerName, customerPhone, userId, metadata, orderInput } = req.body;
    
    const allowedTypes = ['seller_badge', 'listing_pack_10', 'order', 'credits_pack_5', 'credits_pack_12', 'credits_pack_30'];
    if (!type || !allowedTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de paiement invalide.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: allSettings } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['payment_settings', 'phase_config']);

    const settingsMap = {};
    (allSettings || []).forEach(s => { settingsMap[s.key] = s.value; });

    const payConfig = settingsMap['payment_settings'] || {};
    const phaseConfig = settingsMap['phase_config'] || {};
    const isPhase0 = phaseConfig.phase === 0;

    if (payConfig.disable_online_payments || payConfig.status === 'down') {
      return res.status(503).json({
        success: false,
        message: payConfig.notice || 'Les paiements Mobile Money sont temporairement suspendus pour maintenance.'
      });
    }

    let transactionId = '';
    let finalAmount = amount;
    
    if (type === 'order') {
      // 1. Lire la db pour le prix de l'article + coordonnées vendeur
      let listing = null;
      let listingErr = null;

      const rawListingId = orderInput?.listing_id;
      if (rawListingId) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawListingId);
        if (isUUID) {
          const res = await supabase
            .from('listings')
            .select('id, price, user_id, stock, status, variants')
            .eq('id', rawListingId)
            .maybeSingle();
          listing = res.data;
          listingErr = res.error;
        }

        if (!listing) {
          // Fallback : recherche par short ID ou préfixe (ex: a1b2c3d4)
          const res = await supabase
            .from('listings')
            .select('id, price, user_id, stock, status, variants')
            .ilike('id', `${rawListingId}%`)
            .limit(1)
            .maybeSingle();
          if (res.data) {
            listing = res.data;
            listingErr = null;
          }
        }
      }

      if (listingErr || !listing) {
        console.error('Listing lookup error:', listingErr, 'listing_id provided:', rawListingId);
        return res.status(404).json({ success: false, message: 'Article introuvable' });
      }
      
      if (listing.status !== 'active') {
        return res.status(409).json({ success: false, message: 'Cette annonce n’est plus disponible.' });
      }

      const quantity = Math.max(1, Math.floor(Number(orderInput?.quantity) || 1));
      const variants = Array.isArray(listing.variants) ? listing.variants : [];
      const selectedVariant = orderInput?.variant_id
        ? variants.find((variant) => variant.id === orderInput.variant_id)
        : null;

      if (variants.length > 0 && (!selectedVariant || selectedVariant.active === false)) {
        return res.status(400).json({ success: false, message: 'Veuillez choisir une taille valide.' });
      }

      const availableStock = selectedVariant ? Number(selectedVariant.stock) || 0 : Number(listing.stock) || 0;
      if (availableStock < quantity) {
        return res.status(409).json({ success: false, message: 'La quantité demandée n’est plus disponible pour cette taille.' });
      }

      const unitPrice = selectedVariant?.price != null ? Number(selectedVariant.price) : Number(listing.price);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        return res.status(400).json({ success: false, message: 'Prix de l’article invalide.' });
      }
      const productAmount = unitPrice * quantity;

      // Récupérer le profil du vendeur (statut PRO + coordonnées boutique)
      const { data: sellerProfile } = await supabase
        .from('users')
        .select('pro_until, shop_latitude, shop_longitude')
        .eq('id', listing.user_id)
        .single();
        
      const isProSeller = sellerProfile?.pro_until ? new Date(sellerProfile.pro_until) > new Date() : false;
      // En Phase 0 : 0% de commission vendeur pour maximiser l'adoption
      const sellerFeeRate = isPhase0 ? 0.0 : (isProSeller ? PRICING.PRO_SELLER_FEE_RATE : PRICING.SELLER_FEE_RATE);
      
      // Calcul dynamique de la distance et des frais de livraison
      const deliveryLat = orderInput.delivery_lat || null;
      const deliveryLng = orderInput.delivery_lng || null;
      const sellerLat = sellerProfile?.shop_latitude || null;
      const sellerLng = sellerProfile?.shop_longitude || null;
      
      let distanceKm = 0;
      if (deliveryLat != null && deliveryLng != null && sellerLat != null && sellerLng != null) {
        distanceKm = haversineDistance(deliveryLat, deliveryLng, sellerLat, sellerLng);
      }
      
      const isPickupMode = orderInput?.delivery_mode === 'pickup' || orderInput?.delivery_mode === 'pickup_point';
      const deliveryFee = isPickupMode ? 0 : calculateDeliveryFee(distanceKm);
      const commission = Math.round(productAmount * PRICING.BUYER_FEE_RATE);
      const sellerCommission = Math.round(productAmount * sellerFeeRate);
      finalAmount = productAmount + deliveryFee + commission;
      
      console.log(`Order pricing: quantity=${quantity}, unitPrice=${unitPrice}F, distance=${distanceKm.toFixed(1)}km, deliveryFee=${deliveryFee}F, total=${finalAmount}F`);
      
      // 2. Créer UNIQUEMENT l'escrow_transaction (PAS d'order)
      // L'escrow stocke les métadonnées nécessaires pour créer l'order plus tard
      const { data: escrow, error: escrowErr } = await supabase
        .from('escrow_transactions')
        .insert({
          order_id: null,  // ← PAS d'order pour l'instant
          buyer_id: userId,
          seller_id: listing.user_id,
          total_amount: finalAmount,
          seller_amount: productAmount - sellerCommission,
          delivery_fee: deliveryFee,
          platform_fee: commission,
          status: 'pending',
          payment_method: 'mobile_money',
          order_metadata: {
            listing_id: listing.id,
            variant_id: selectedVariant?.id || null,
            variant_label: selectedVariant?.label || null,
            unit_price: unitPrice,
            quantity,
            product_amount: productAmount,
            delivery_address: orderInput.delivery_address || 'Daloa',
            delivery_mode: orderInput.delivery_mode || 'delivery',
            delivery_lat: deliveryLat,
            delivery_lng: deliveryLng,
            distance_km: Math.round(distanceKm * 10) / 10,
            delivery_fee_calculated: deliveryFee,
          }
        })
        .select('id')
        .single();
        
      if (escrowErr || !escrow) {
        console.error('Escrow creation error:', escrowErr);
        return res.status(500).json({ success: false, message: escrowErr?.message || 'Erreur création escrow' });
      }
      transactionId = escrow.id;

    } else {
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'Montant invalide.' });
      
      const { data: tx, error: txErr } = await supabase
        .from('monetization_transactions')
        .insert({ user_id: userId, type, amount: Math.round(amount), status: 'pending' })
        .select('id').single();
        
      if (txErr || !tx) return res.status(500).json({ success: false, message: txErr?.message || 'Erreur transaction.' });
      transactionId = tx.id;
    }

    const baseUrl = SITE_URL.replace(/\/$/, '');
    const returnUrl = `${baseUrl}/payment/success?transactionId=${transactionId}&type=${type}`;
    const webhookUrl = `${req.protocol}://${req.get('host')}/payment-webhook`;

    // Résolution et assainissement du nom et du numéro de téléphone client
    let resolvedName = (customerName || '').trim();
    let cleanPhone = (customerPhone || '').trim().replace(/\s+/g, '');
    if ((!cleanPhone || !resolvedName) && userId) {
      const { data: u } = await supabase.from('users').select('phone, full_name').eq('id', userId).maybeSingle();
      if (!cleanPhone && u?.phone) cleanPhone = u.phone.trim().replace(/\s+/g, '');
      if (!resolvedName && u?.full_name) resolvedName = u.full_name.trim();
    }

    if (cleanPhone.startsWith('+225')) {
      cleanPhone = cleanPhone.slice(4);
    } else if (cleanPhone.startsWith('225') && cleanPhone.length === 13) {
      cleanPhone = cleanPhone.slice(3);
    } else if (cleanPhone.startsWith('00225')) {
      cleanPhone = cleanPhone.slice(5);
    }

    if (!cleanPhone || cleanPhone === '0000000000') {
      cleanPhone = '0700000000';
    }

    const labelByType = { 
      seller_badge: 'Badge Vendeur Pro (30 jours)', 
      listing_pack_10: 'Pack 10 annonces (500 FCFA)', 
      order: 'Achat de produit sur DaloaMarket',
      credits_pack_5: 'Pack Bronze (5 crédits)',
      credits_pack_12: 'Pack Argent (12 crédits)',
      credits_pack_30: 'Pack Or (30 crédits)'
    };
    const fusionPayload = {
      totalPrice: Math.round(finalAmount),
      article: [{ [labelByType[type] || type]: Math.round(finalAmount) }],
      personal_Info: [{ userId, transactionId, type, ...(metadata || {}), ...(orderInput || {}) }],
      numeroSend: cleanPhone,
      nomclient: resolvedName || 'Client DaloaMarket',
      return_url: returnUrl,
      webhook_url: webhookUrl,
    };

    let fusionRes, fusionData;
    try {
      console.log('Calling FUSION_API_URL:', FUSION_API_URL);
      console.log('Payload:', JSON.stringify(fusionPayload).slice(0, 300));
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      fusionRes = await fetch(FUSION_API_URL, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'DaloaMarket-Server/1.0'
        },
        body: JSON.stringify(fusionPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const rawText = await fusionRes.text();
      console.log('Money Fusion response status:', fusionRes.status);
      console.log('Money Fusion response body:', rawText.slice(0, 500));
      fusionData = (() => { try { return JSON.parse(rawText); } catch { return null; } })();
    } catch (e) {
      console.error('Money Fusion fetch error:', e.message || e);
      return res.status(502).json({ success: false, message: 'Money Fusion injoignable: ' + (e.message || 'erreur reseau') });
    }
    
    if (!fusionRes.ok || !fusionData || fusionData.statut === false) {
      return res.status(502).json({ success: false, message: fusionData?.message || 'Erreur Money Fusion' });
    }

    // URL de paiement retournée par MoneyFusion
    let validPaymentUrl = fusionData.url;
    if (!validPaymentUrl && fusionData.token) {
      validPaymentUrl = `https://payin.moneyfusion.net/payment/${fusionData.token}/${Math.round(finalAmount)}/${encodeURIComponent(resolvedName || 'Client')}`;
    }

    // Sauvegarder le token
    if (type === 'order') {
      await supabase.from('escrow_transactions').update({ payment_reference: fusionData.token }).eq('id', transactionId);
      return res.json({ success: true, token: fusionData.token, payment_url: validPaymentUrl, transactionId });
    } else {
      await supabase.from('monetization_transactions').update({ provider_token: fusionData.token }).eq('id', transactionId);
      return res.json({ success: true, transactionId, token: fusionData.token, paymentUrl: validPaymentUrl });
    }
  } catch (e) {
    console.error('ERROR /create-payment:', e.message || e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 2) Webhook Money Fusion
app.post('/payment-webhook', async (req, res) => {
  try {
    checkConfig();
    const payload = req.body;
    const personal = Array.isArray(payload?.personal_Info) ? payload.personal_Info[0] : null;
    const transactionId = personal?.transactionId;
    const type = personal?.type;

    if (!transactionId || !type) return res.status(400).json({ ok: false, message: 'Données de requête invalides' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const isOrder = type === 'order';
    const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';
    
    const { data: tx, error } = await supabase.from(table).select('*').eq('id', transactionId).maybeSingle();
    if (error || !tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable' });

    // Verif statut DB (idempotence)
    if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
      return res.json({ ok: true, message: 'Déjà confirmée' });
    }

    const token = isOrder ? tx.payment_reference : tx.provider_token;
    if (!token) return res.status(400).json({ ok: false, message: 'Token absent' });

    const fusionRes = await fetch(`https://pay.moneyfusion.net/paiementNotif/${token}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'DaloaMarket-Server/1.0'
      }
    });
    const fusionData = await fusionRes.json().catch(() => null);

    if (!fusionData || fusionData.statut !== true || !fusionData.data) {
      return res.json({ ok: true, status: 'pending' });
    }

    const fusionStatus = fusionData.data.statut;

    if (fusionStatus === 'paid') {
      if (isOrder) {
        // ✅ Paiement confirmé → MAINTENANT on crée l'order
        console.log('webhook: payment confirmed, creating order...');
        await createOrderFromEscrow(supabase, tx, personal);
      } else {
        const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
        if (rpcByType[type]) {
          await supabase.rpc(rpcByType[type], { p_transaction_id: transactionId });
        } else if (type === 'listing_pack_10') {
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 10 });
        } else if (type === 'credits_pack_5') {
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 5 });
        } else if (type === 'credits_pack_12') {
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 12 });
        } else if (type === 'credits_pack_30') {
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 30 });
        }
        await supabase.from('monetization_transactions').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', transactionId);
      }
      return res.json({ ok: true, status: 'paid' });
    }

    if (fusionStatus === 'failure' || fusionStatus === 'no paid') {
      await supabase.from(table).update({ status: isOrder ? 'cancelled' : 'failed' }).eq('id', transactionId);
      return res.json({ ok: true, status: fusionStatus });
    }

    return res.json({ ok: true, status: 'pending' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Variable globale pour éviter les appels concurrents sur le même payout
const processingPayouts = new Set();

// 3) Webhook de traitement des Payouts (peut être appelé par un cron)
app.get('/process-payouts', payoutLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let query = supabase
      .from('payouts')
      .select('*')
      .eq('status', 'pending');

    if (req.query.force !== 'true') {
      query = query.lte('scheduled_for', new Date().toISOString());
    }

    const { data: payouts, error } = await query;

    if (error) throw error;
    if (!payouts || payouts.length === 0) {
      return res.json({ success: true, message: req.query.force === 'true' ? 'Aucun payout de statut pending' : 'Aucun payout en attente (délai d\'escrow non expiré)', processed: 0 });
    }

    const results = [];
    // On utilise la clé privée configurée en variable d'environnement
    const MONEYFUSION_PRIVATE_KEY = process.env.MONEYFUSION_PRIVATE_KEY;

    if (!MONEYFUSION_PRIVATE_KEY) {
      return res.status(500).json({ success: false, message: 'La clé privée MONEYFUSION_PRIVATE_KEY est manquante dans les variables d\'environnement du serveur.' });
    }

    for (const payout of payouts) {
      // Protection anti double-processing
      if (processingPayouts.has(payout.id)) {
        results.push({ id: payout.id, status: 'skipped', reason: 'already processing' });
        continue;
      }
      processingPayouts.add(payout.id);

      if (!payout.withdraw_mode) {
        results.push({ id: payout.id, status: 'skipped', reason: 'withdraw_mode manquant' });
        processingPayouts.delete(payout.id);
        continue;
      }

      try {
        const host = req.get('host');
        const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
        const payload = {
          countryCode: "ci",
          phone: payout.recipient_phone.replace(/\s/g, '').replace(/^\+225/, ''),
          amount: payout.amount,
          withdraw_mode: payout.withdraw_mode,
          webhook_url: `${protocol}://${host}/payout-webhook`
        };

        const response = await fetch('https://pay.moneyfusion.net/api/v1/withdraw', {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "moneyfusion-private-key": MONEYFUSION_PRIVATE_KEY,
          },
          body: JSON.stringify(payload),
        });

        const result = await response.json();

        if (result.statut === true) {
          const { error: updateErr } = await supabase.from('payouts').update({ status: 'processing', provider_token: result.tokenPay }).eq('id', payout.id);
          if (updateErr) throw new Error('Erreur DB update: ' + updateErr.message);
          results.push({ id: payout.id, status: 'processing', token: result.tokenPay });
        } else {
          const { error: updateErr } = await supabase.from('payouts').update({ status: 'failed', failure_reason: result.message || 'Erreur API MoneyFusion' }).eq('id', payout.id);
          if (updateErr) throw new Error('Erreur DB update failed: ' + updateErr.message);
          results.push({ id: payout.id, status: 'failed', reason: result.message });
        }
      } catch (err) {
        const { error: updateErr } = await supabase.from('payouts').update({ status: 'failed', failure_reason: err.message || 'Exception réseau' }).eq('id', payout.id);
        results.push({ id: payout.id, status: 'failed', reason: err.message });
      } finally {
        processingPayouts.delete(payout.id);
      }
    }

    return res.json({ success: true, processed: payouts.length, results });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// 4) Webhook pour le résultat des Payouts
app.post('/payout-webhook', async (req, res) => {
  console.log('[Webhook Payout Received] Payload:', JSON.stringify(req.body));
  try {
    checkConfig();
    const { event, tokenPay, message } = req.body;
    
    if (!tokenPay) {
      console.warn('[Webhook Payout Warning] Token is missing');
      return res.status(400).json({ ok: false, message: 'Token absent' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (event === "payout.session.completed") {
      console.log(`[Webhook Payout Success] Updating payout for token: ${tokenPay} to status 'paid'`);
      
      let updatedRows = null;
      let attempts = 0;
      
      while (attempts < 5) {
        const { data, error } = await supabase
          .from('payouts')
          .update({ status: 'paid', completed_at: new Date().toISOString() })
          .eq('provider_token', tokenPay)
          .select();
          
        if (error) {
          console.error('[Webhook Payout Error] Database update failed:', error);
          break;
        }
        
        if (data && data.length > 0) {
          updatedRows = data;
        }
        
        attempts++;
        console.log(`[Webhook Payout Success] Payout row not found/updated yet (attempt ${attempts}/5). Retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      if (updatedRows) {
        console.log('[Webhook Payout Success] Database updated successfully.');
      } else {
        console.warn('[Webhook Payout Warning] Payout row was NOT updated (not found after 5 attempts).');
      }
    } else if (event === "payout.session.cancelled") {
      console.log(`[Webhook Payout Cancelled] Updating payout for token: ${tokenPay} to status 'failed'`);
      
      let updatedRows = null;
      let attempts = 0;
      
      while (attempts < 5) {
        const { data, error } = await supabase
          .from('payouts')
          .update({ status: 'failed', failure_reason: message || 'Annulé par MoneyFusion' })
          .eq('provider_token', tokenPay)
          .select();
          
        if (error) {
          console.error('[Webhook Payout Error] Database update failed:', error);
          break;
        }
        
        if (data && data.length > 0) {
          updatedRows = data;
          break;
        }
        
        attempts++;
        console.log(`[Webhook Payout Cancelled] Payout row not found/updated yet (attempt ${attempts}/5). Retrying in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      if (updatedRows) {
        console.log('[Webhook Payout Cancelled] Database updated successfully.');
      } else {
        console.warn('[Webhook Payout Warning] Payout row was NOT updated (not found after 5 attempts).');
      }
    } else {
      console.warn('[Webhook Payout Warning] Unknown event type:', event);
    }
    
    return res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook Payout Exception]:', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ========================================
// 5) Web Push Notification Endpoints
// ========================================

// A. Broadcast vers tous les appareils abonnés (Admin / Annonces globales)
app.post('/push/broadcast', async (req, res) => {
  try {
    const { title, body, url, tag, image } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'admin-broadcast',
      image: image || null,
      icon: '/web-app-manifest-192x192.png',
    };

    // Insérer dans l'historique notifications Supabase
    try {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      await supabase.from('notifications').insert({
        title,
        body,
        url: url || null,
      });
    } catch (dbErr) {
      console.warn('[Push Broadcast] Supabase insert warning:', dbErr.message);
    }

    const result = await broadcastPush(payload);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Broadcast Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// B. Notification ciblée pour un utilisateur spécifique (Messages chat, commandes)
app.post('/push/notify-user', async (req, res) => {
  try {
    const { targetUserId, title, body, url, tag, image } = req.body || {};
    if (!targetUserId || !title || !body) {
      return res.status(400).json({ success: false, message: 'targetUserId, title et body requis' });
    }

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'user-notification',
      image: image || null,
      icon: '/web-app-manifest-192x192.png',
    };

    const result = await sendPushToUser(targetUserId, payload);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Push Notify User Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// C. Endpoint générique /push/send
app.post('/push/send', async (req, res) => {
  try {
    const { target, title, body, url, tag } = req.body || {};
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'Titre et corps requis' });
    }

    const payload = {
      title,
      body,
      url: url || '/',
      tag: tag || 'notification',
      icon: '/web-app-manifest-192x192.png',
    };

    if (target === 'all' || !target) {
      const result = await broadcastPush(payload);
      return res.json({ success: true, ...result });
    }

    if (Array.isArray(target)) {
      const results = await Promise.allSettled(target.map(uid => sendPushToUser(uid, payload)));
      const sentTotal = results.reduce((acc, r) => acc + (r.status === 'fulfilled' && r.value?.sent ? r.value.sent : 0), 0);
      return res.json({ success: true, sent: sentTotal, targets: target.length });
    }

    if (typeof target === 'string') {
      const result = await sendPushToUser(target, payload);
      return res.json({ success: true, ...result });
    }

    return res.status(400).json({ success: false, message: 'Cible invalide' });
  } catch (err) {
    console.error('[Push Send Exception]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// E. Register Push Subscription (Web Push ou Mobile Expo Push)
app.post('/push/register', async (req, res) => {
  try {
    const { user_id, expo_push_token, app_type, endpoint, keys_p256dh, keys_auth, user_agent } = req.body || {};

    if (!user_id || (!expo_push_token && (!endpoint || !keys_p256dh || !keys_auth))) {
      return res.status(400).json({ success: false, message: 'Champs requis manquants: user_id et (expo_push_token OU endpoint/keys)' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Cas 1 : Token Mobile Expo (Android / iOS)
    if (expo_push_token) {
      const { error } = await supabase.from('push_subscriptions').upsert(
        {
          user_id,
          expo_push_token,
          app_type: app_type || 'market',
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,expo_push_token' }
      );

      if (error && error.code !== '23505') {
        console.error('[Push Register Expo] ❌ Erreur insertion Supabase:', error.message);
        return res.status(500).json({ success: false, message: error.message });
      }

      console.log(`[Push Register Expo] ✅ Token Expo enregistré pour user ${user_id} (${app_type || 'market'})`);
      return res.json({ success: true, type: 'expo' });
    }

    // Cas 2 : Web Push
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_id,
        endpoint,
        keys_p256dh,
        keys_auth,
        user_agent: user_agent || null,
      },
      { onConflict: 'user_id,endpoint' }
    );

    if (error) {
      if (error.code === '23505') {
        return res.json({ success: true, duplicate: true });
      }
      console.error('[Push Register] ❌ Erreur insertion Supabase:', error.message);
      return res.status(500).json({ success: false, message: error.message });
    }

    console.log(`[Push Register] ✅ Token Web enregistré pour user ${user_id} (endpoint: ${endpoint.slice(0, 60)}...)`);
    return res.json({ success: true, type: 'web' });
  } catch (err) {
    console.error('[Push Register] Exception:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// D. Webhook Supabase Database Trigger (Notifications automatiques en arrière-plan)
app.post('/push/webhook', async (req, res) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(503).json({ ok: false, error: 'Push VAPID keys non configurées' });
  }

  const { type, table, record, old_record } = req.body || {};
  if (!record || !table) {
    return res.status(400).json({ ok: false, error: 'Payload webhook invalide' });
  }

  try {
    // 1. Messages du chat
    if (table === 'messages' && type === 'INSERT') {
      const targetUserId = record.receiver_id;
      if (!targetUserId) return res.json({ ok: true, skipped: 'no receiver_id' });

      const content = record.content || '';
      const payload = {
        title: '💬 Nouveau message DaloaMarket',
        body: content.length > 80 ? content.slice(0, 80) + '...' : (content || 'Vous avez reçu un nouveau message.'),
        url: `/messages/${record.listing_id || 'inbox'}/${record.sender_id}`,
        tag: `chat-${record.sender_id}`,
        icon: '/web-app-manifest-192x192.png',
      };

      const result = await sendPushToUser(targetUserId, payload);
      return res.json({ ok: true, ...result });
    }

    // 2. Statuts de commande (Acheteur + Vendeur)
    if (table === 'orders' && type === 'UPDATE') {
      const status = record.status;
      const oldStatus = old_record?.status;
      if (status === oldStatus) return res.json({ ok: true, skipped: 'status inchangé' });

      // Notifier l'acheteur
      if (record.buyer_id) {
        let buyerMsg = 'Votre commande a été mise à jour.';
        if (status === 'paid') buyerMsg = 'Paiement confirmé ! Votre commande est en préparation.';
        else if (status === 'picked_up') buyerMsg = 'Le livreur a récupéré votre colis et fait route vers vous. 🚚';
        else if (status === 'delivered') buyerMsg = 'Colis livré avec succès ! Merci de votre confiance. ✅';
        else if (status === 'disputed') buyerMsg = 'Litige ouvert sur votre commande. Notre support intervient.';

        await sendPushToUser(record.buyer_id, {
          title: '📦 Mise à jour de commande',
          body: buyerMsg,
          url: `/suivi/${record.id}`,
          tag: `order-${record.id}`,
          icon: '/web-app-manifest-192x192.png',
        });
      }

      // Notifier le vendeur
      if (record.seller_id) {
        let sellerMsg = null;
        if (status === 'paid') sellerMsg = 'Nouvelle vente confirmée ! Préparez le colis pour le livreur. 🛍️';
        else if (status === 'delivered') sellerMsg = 'Livraison validée ! Vos gains seront disponibles sous 24h. ✅';

        if (sellerMsg) {
          await sendPushToUser(record.seller_id, {
            title: '🛍️ Notification Vendeur',
            body: sellerMsg,
            url: '/mes-commandes',
            tag: `order-seller-${record.id}`,
            icon: '/web-app-manifest-192x192.png',
          });
        }
      }

      return res.json({ ok: true });
    }

    // 3. Courses et Livraisons
    if (table === 'delivery_assignments') {
      const status = record.status;
      const oldStatus = old_record?.status;
      const priceText = record.delivery_price ? `${Number(record.delivery_price).toLocaleString('fr-FR')} FCFA` : 'Rémunérée';
      const orderUrl = `/suivi/${record.order_id}`;

      // A. Nouvelle course créée (INSERT) ou mise à disposition (UPDATE vers awaiting_pickup)
      if (type === 'INSERT' || (type === 'UPDATE' && status === 'awaiting_pickup' && oldStatus !== 'awaiting_pickup')) {
        // Cas 1 : Livreur spécifique assigné (ex: livreur affilié)
        if (record.delivery_person_id) {
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          const { data: dp } = await supabase
            .from('delivery_persons')
            .select('user_id')
            .eq('id', record.delivery_person_id)
            .maybeSingle();

          if (dp?.user_id) {
            await sendPushToUser(dp.user_id, {
              title: '🛵 Nouvelle course assignée !',
              body: `Une livraison vous a été confiée à Daloa (${priceText}). Ouvrez l'application pour démarrer.`,
              url: orderUrl,
              tag: `delivery-assign-${record.id}`,
            });
          }
        } 
        // Cas 2 : Course publique ouverte à tous les livreurs de Daloa
        else if (!record.is_private) {
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { autoRefreshToken: false, persistSession: false },
          });
          const { data: drivers } = await supabase
            .from('delivery_persons')
            .select('user_id')
            .eq('is_available', true);

          if (drivers && drivers.length > 0) {
            console.log(`[Push Delivery] 🛵 Diffusion nouvelle course à ${drivers.length} livreur(s) disponible(s)...`);
            for (const driver of drivers) {
              if (driver.user_id) {
                sendPushToUser(driver.user_id, {
                  title: '🛵 Nouvelle course disponible !',
                  body: `Livraison à Daloa • Gain : ${priceText}. Premier arrivé, premier servi ! ⚡`,
                  url: orderUrl,
                  tag: `delivery-open-${record.id}`,
                }).catch((err) => console.warn('[Push Delivery Error]:', err));
              }
            }
          }
        }
      }

      // B. Prise en charge du colis par le livreur (picked_up)
      if (type === 'UPDATE' && status === 'picked_up' && oldStatus !== 'picked_up') {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: order } = await supabase
          .from('orders')
          .select('buyer_id')
          .eq('id', record.order_id)
          .maybeSingle();

        if (order?.buyer_id) {
          await sendPushToUser(order.buyer_id, {
            title: '🚚 Votre livreur est en route !',
            body: 'Le livreur a récupéré votre colis et fait route vers votre adresse.',
            url: orderUrl,
            tag: `order-transit-${record.order_id}`,
          });
        }
      }

      // C. Arrivée à destination (delivered)
      if (type === 'UPDATE' && status === 'delivered' && oldStatus !== 'delivered') {
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: order } = await supabase
          .from('orders')
          .select('buyer_id, seller_id')
          .eq('id', record.order_id)
          .maybeSingle();

        if (order?.buyer_id) {
          await sendPushToUser(order.buyer_id, {
            title: '📦 Colis arrivé !',
            body: 'Votre livreur est là. Communiquez votre code OTP pour valider la livraison.',
            url: orderUrl,
            tag: `order-delivered-${record.order_id}`,
          });
        }

        if (order?.seller_id) {
          await sendPushToUser(order.seller_id, {
            title: '✅ Livraison effectuée !',
            body: 'Le colis a été remis à l\'acheteur avec succès.',
            url: `/mes-commandes`,
            tag: `seller-delivered-${record.order_id}`,
          });
        }
      }

      return res.json({ ok: true });
    }

    return res.json({ ok: true, skipped: 'unhandled table/type' });
  } catch (err) {
    console.error('[Push Webhook Exception]:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- WhatsApp Channel Broadcast Endpoint (Levier A & Diffusion automatique) ---
app.post('/api/channel/broadcast-listing', async (req, res) => {
  try {
    const { title, price, district, id, shop_name } = req.body;
    if (!title || !price || !id) {
      return res.status(400).json({ error: 'Missing required listing details (title, price, id)' });
    }

    const listingUrl = `https://daloamarket.com/item/${id}`;
    const formattedPrice = Number(price).toLocaleString('fr-FR') + ' FCFA';
    
    const message = `🛍️ NOUVEL ARRIVAGE SUR DALOA MARKET !

📦 *${title}*
💰 Prix : *${formattedPrice}*
📍 Quartier : ${district || 'Daloa'}
${shop_name ? `👤 Vendeur : ${shop_name}\n` : ''}
👉 Voir l'article et commander en toute sécurité :
${listingUrl}

🛵 Livraison express partout à Daloa avec DaloaDelivery !`;

    console.log('[WhatsApp Channel Broadcast Generated]:\n', message);

    return res.json({
      success: true,
      channelUrl: 'https://whatsapp.com/channel/0029Vb94o2vJENy5kkADR42U',
      message,
      listingUrl
    });
  } catch (err) {
    console.error('[Broadcast Listing Exception]:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, message: err.message || 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 3000;
console.log('FUSION_API_URL from env:', JSON.stringify(process.env.FUSION_API_URL));
console.log('SUPABASE_URL from env:', JSON.stringify(process.env.SUPABASE_URL));
app.listen(PORT, () => console.log(`Payment & Push API running on port ${PORT}`));
