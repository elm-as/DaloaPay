// Serveur Express pour Railway - API Paiement DaloaMarket
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns');
require('dotenv').config({ override: true });

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
  PLATFORM_FEE_RATE: 0.06
};

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
      // Si déjà payé, renvoyer directement
      if (escrow.status !== 'pending') {
        return res.json({
          success: true,
          status: statusMap[escrow.status] || 'unknown',
          transactionId: escrow.id,
          amount: escrow.total_amount,
          paymentMethod: escrow.payment_method,
          confirmedAt: escrow.funded_at,
        });
      }

      // Si pending, vérifier chez Money Fusion avec le payment_reference
      if (escrow.payment_reference) {
        try {
          const fusionUrl = `https://www.pay.moneyfusion.net/paiementNotif/${escrow.payment_reference}`;
          console.log('check-payment: verifying with MoneyFusion:', fusionUrl);
          const fusionRes = await fetch(fusionUrl, {
            headers: {
              'Accept': 'application/json',
              'User-Agent': 'DaloaMarket-Server/1.0'
            }
          });
          const fusionData = await fusionRes.json().catch(() => null);

          if (fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid') {
            // Le paiement est bien fait → mettre à jour la DB
            await supabase
              .from('escrow_transactions')
              .update({ status: 'funded', funded_at: new Date().toISOString() })
              .eq('id', escrow.id);

            // Même logique que le webhook : créer delivery_assignments, etc.
            console.log('check-payment: payment confirmed, triggering delivery flow...');
            const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
            const pickupOTP = generateOTP();
            const deliveryOTP = generateOTP();

            await supabase.from('delivery_assignments').insert({
              order_id: escrow.order_id,
              delivery_person_id: null,
              status: 'awaiting_pickup',
              pickup_confirmed_by_seller: false,
              pickup_otp: pickupOTP,
              delivery_otp: deliveryOTP,
              pickup_otp_attempts: 0,
              delivery_otp_attempts: 0,
            });

            await supabase.from('orders').update({ status: 'paid' }).eq('id', escrow.order_id);

            return res.json({
              success: true,
              status: 'paid',
              transactionId: escrow.id,
              amount: escrow.total_amount,
              paymentMethod: escrow.payment_method,
              confirmedAt: escrow.funded_at,
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
          // Money Fusion injoignable → on laisse pending, le frontend pourra réessayer
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
          const fusionUrl = `https://www.pay.moneyfusion.net/paiementNotif/${tx.provider_token}`;
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
app.post('/create-payment', async (req, res) => {
  console.log('POST /create-payment received', req.body);
  try {
    checkConfig();
    const { type, amount, customerName, customerPhone, userId, metadata, orderInput } = req.body;
    
    if (!type || !['seller_badge', 'listing_pack_10', 'order'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de paiement invalide.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let transactionId = '';
    let finalAmount = amount;
    
    if (type === 'order') {
      // 1. Lire la db pour le prix de l'article
      const { data: listing, error: listingErr } = await supabase
        .from('listings')
        .select('price, user_id')
        .eq('id', orderInput.listing_id)
        .single();
      
      if (listingErr || !listing) {
        console.error('Listing lookup error:', listingErr);
        return res.status(404).json({ success: false, message: 'Article introuvable' });
      }
      
      const deliveryFee = PRICING.DELIVERY_MIN;
      const commission = Math.round(listing.price * PRICING.PLATFORM_FEE_RATE);
      finalAmount = listing.price + deliveryFee + commission;
      
      // 2. Créer l'escrow_transaction
      const { data: escrow, error: escrowErr } = await supabase
        .from('escrow_transactions')
        .insert({
          order_id: require('crypto').randomUUID(),
          buyer_id: userId,
          seller_id: listing.user_id,
          total_amount: finalAmount,
          seller_amount: listing.price - commission,
          delivery_fee: deliveryFee,
          platform_fee: commission,
          status: 'pending',
          payment_method: 'mobile_money'
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
    const returnUrl = `${baseUrl}/payment/success?transactionId=${transactionId}&type=${type}${type === 'order' ? '&order_id=' + transactionId : ''}`;
    const webhookUrl = `${req.protocol}://${req.get('host')}/payment-webhook`;

    const labelByType = { seller_badge: 'Badge Vendeur Pro (30 jours)', listing_pack_10: 'Pack 10 annonces (500 FCFA)', order: 'Achat de produit sur DaloaMarket' };
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
      return res.json({ success: true, order_id: transactionId, token: fusionData.token, payment_url: fusionData.url });
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

    // Verif statut DB
    if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
      return res.json({ ok: true, message: 'Déjà confirmée' });
    }

    const token = isOrder ? tx.payment_reference : tx.provider_token;
    if (!token) return res.status(400).json({ ok: false, message: 'Token absent' });

    const fusionRes = await fetch(`https://www.pay.moneyfusion.net/paiementNotif/${token}`, {
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
        // Validation commande : escrow = funded
        await supabase.from('escrow_transactions').update({ status: 'funded', funded_at: new Date().toISOString() }).eq('id', transactionId);

        // Générer deux OTP distincts (6 chiffres chacun)
        const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
        const pickupOTP = generateOTP();
        const deliveryOTP = generateOTP();

        // Créer l'assignation de livraison avec les deux OTP
        const address = personal.delivery_address || 'Daloa';
        const deliveryLat = personal.delivery_lat || null;
        const deliveryLng = personal.delivery_lng || null;

        await supabase.from('delivery_assignments').insert({
          order_id: tx.order_id,
          delivery_person_id: null,
          status: 'awaiting_pickup',
          pickup_confirmed_by_seller: false,
          pickup_confirmed_at: null,
          pickup_otp: pickupOTP,
          delivery_otp: deliveryOTP,
          pickup_otp_attempts: 0,
          delivery_otp_attempts: 0,
          accepted_at: null,
          delivery_address: address,
          delivery_lat: deliveryLat,
          delivery_lng: deliveryLng,
          pickup_gps: null,
          pickup_gps_distance_m: null,
          delivery_gps: null,
          delivery_gps_distance_m: null,
          pickup_photo_url: null,
          delivered_at: null,
          buyer_confirmed_at: null,
          auto_released_at: null
        });

        // Mettre à jour le statut de la commande
        await supabase.from('orders').update({ status: 'paid' }).eq('id', tx.order_id);
      } else {
        const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
        if (rpcByType[type]) {
          await supabase.rpc(rpcByType[type], { p_transaction_id: transactionId });
        } else if (type === 'listing_pack_10') {
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: 10 });
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

app.use((err, req, res, next) => {
  res.status(500).json({ success: false, message: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 3000;
console.log('FUSION_API_URL from env:', JSON.stringify(process.env.FUSION_API_URL));
console.log('SUPABASE_URL from env:', JSON.stringify(process.env.SUPABASE_URL));
app.listen(PORT, () => console.log(`Payment API running on port ${PORT}`));
