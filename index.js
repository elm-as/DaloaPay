// Serveur Express pour Railway - API Paiement DaloaMarket
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
require('dotenv').config();

// Node 18+ fetch() préfère l'IPv6, ce qui fait planter les requêtes vers MoneyFusion sur Render
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(cors());
app.use(express.json());

// Variables d'environnement (à configurer dans Railway)
const FUSION_API_URL = process.env.FUSION_API_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || 'https://daloamarket.shop';

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
  DELIVERY_RATE_PER_KM: 200,
  BUYER_FEE_RATE: 0.03,
  SELLER_FEE_RATE: 0.035,
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
  if (distanceKm > 1) {
    extraFee = Math.round((distanceKm - 1) * PRICING.DELIVERY_RATE_PER_KM);
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

  await supabase.from('delivery_assignments').insert({
    order_id: order.id,
    delivery_person_id: null,
    status: 'pending_seller_confirmation',
    pickup_confirmed_by_seller: false,
    pickup_otp: pickupOTP,
    delivery_otp: deliveryOTP,
    pickup_otp_attempts: 0,
    delivery_otp_attempts: 0,
    delivery_address: address,
    delivery_lat: deliveryLat,
    delivery_lng: deliveryLng,
    delivery_price: escrow.delivery_fee,
  });

  return order.id;
}

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'DaloaMarket Payment API' });
});

// 0) Diagnostic : IP publique du serveur (pour whitelist Money Fusion)
app.get('/ip', async (req, res) => {
  try {
    const [v4, v6] = await Promise.allSettled([
      fetch('https://api.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'injoignable (api.ipify.org)' })),
      fetch('https://api64.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'N/A' })),
    ]);
    res.json({
      ipv4: v4.status === 'fulfilled' ? v4.value.ip : 'erreur',
      ipv6: v6.status === 'fulfilled' ? v6.value.ip : 'N/A',
      message: "Ajoute cette IPv4 dans ton dashboard Money Fusion (section 'API de paiement' → IP autorisees)",
    });
  } catch { res.json({ error: 'Impossible de récupérer l\'IP' }); }
});

// 0b) Diagnostic : config actuelle
app.get('/config', (req, res) => {
  res.json({
    FUSION_API_URL: FUSION_API_URL || 'NON DEFINI',
    SUPABASE_URL: SUPABASE_URL || 'NON DEFINI',
    SUPABASE_KEY_OK: !!SUPABASE_SERVICE_ROLE_KEY,
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
app.get('/check-payment', async (req, res) => {
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
app.post('/create-payment', async (req, res) => {
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

    let transactionId = '';
    let finalAmount = amount;
    
    if (type === 'order') {
      // 1. Lire la db pour le prix de l'article + coordonnées vendeur
      const { data: listing, error: listingErr } = await supabase
        .from('listings')
        .select('price, user_id')
        .eq('id', orderInput.listing_id)
        .single();
      
      if (listingErr || !listing) {
        console.error('Listing lookup error:', listingErr);
        return res.status(404).json({ success: false, message: 'Article introuvable' });
      }
      
      // Récupérer le profil du vendeur (statut PRO + coordonnées boutique)
      const { data: sellerProfile } = await supabase
        .from('users')
        .select('pro_until, shop_latitude, shop_longitude')
        .eq('id', listing.user_id)
        .single();
        
      const isProSeller = sellerProfile?.pro_until ? new Date(sellerProfile.pro_until) > new Date() : false;
      const sellerFeeRate = isProSeller ? 0.025 : PRICING.SELLER_FEE_RATE;
      
      // Calcul dynamique de la distance et des frais de livraison
      const deliveryLat = orderInput.delivery_lat || null;
      const deliveryLng = orderInput.delivery_lng || null;
      const sellerLat = sellerProfile?.shop_latitude || null;
      const sellerLng = sellerProfile?.shop_longitude || null;
      
      let distanceKm = 0;
      if (deliveryLat != null && deliveryLng != null && sellerLat != null && sellerLng != null) {
        distanceKm = haversineDistance(deliveryLat, deliveryLng, sellerLat, sellerLng);
      }
      
      const deliveryFee = calculateDeliveryFee(distanceKm);
      const commission = Math.round(listing.price * PRICING.BUYER_FEE_RATE);
      const sellerCommission = Math.round(listing.price * sellerFeeRate);
      finalAmount = listing.price + deliveryFee + commission;
      
      console.log(`Order pricing: distance=${distanceKm.toFixed(1)}km, deliveryFee=${deliveryFee}F, total=${finalAmount}F`);
      
      // 2. Créer UNIQUEMENT l'escrow_transaction (PAS d'order)
      // L'escrow stocke les métadonnées nécessaires pour créer l'order plus tard
      const { data: escrow, error: escrowErr } = await supabase
        .from('escrow_transactions')
        .insert({
          order_id: null,  // ← PAS d'order pour l'instant
          buyer_id: userId,
          seller_id: listing.user_id,
          total_amount: finalAmount,
          seller_amount: listing.price - sellerCommission,
          delivery_fee: deliveryFee,
          platform_fee: commission,
          status: 'pending',
          payment_method: 'mobile_money',
          order_metadata: {
            listing_id: orderInput.listing_id,
            product_amount: listing.price,
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
        return res.status(500).json({ success: false, message: 'Erreur création escrow' });
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
    // Pour les orders, on ne passe plus order_id dans l'URL (il n'existe pas encore)
    const returnUrl = `${baseUrl}/payment/success?transactionId=${transactionId}&type=${type}`;
    const webhookUrl = `${req.protocol}://${req.get('host')}/payment-webhook`;

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
      numeroSend: customerPhone || '0000000000',
      nomclient: customerName || 'Client DaloaMarket',
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

    // Sauvegarder le token
    if (type === 'order') {
      await supabase.from('escrow_transactions').update({ payment_reference: fusionData.token }).eq('id', transactionId);
      // On ne renvoie PAS d'order_id (il n'existe pas encore)
      return res.json({ success: true, token: fusionData.token, payment_url: fusionData.url, transactionId });
    } else {
      await supabase.from('monetization_transactions').update({ provider_token: fusionData.token }).eq('id', transactionId);
      return res.json({ success: true, transactionId, token: fusionData.token, paymentUrl: fusionData.url });
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

    if (!transactionId || !type) return res.status(400).json({ ok: false, message: 'Invalid payload' });

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
app.get('/process-payouts', async (req, res) => {
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
          break;
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

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, message: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 3000;
console.log('FUSION_API_URL from env:', JSON.stringify(process.env.FUSION_API_URL));
console.log('SUPABASE_URL from env:', JSON.stringify(process.env.SUPABASE_URL));
app.listen(PORT, () => console.log(`Payment API running on port ${PORT}`));
