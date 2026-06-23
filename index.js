// Serveur Express pour Railway - API Paiement DaloaMarket
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

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
  console.log('FUSION_API_URL:', FUSION_API_URL ? 'OK' : 'MISSING');
  console.log('SUPABASE_URL:', SUPABASE_URL ? 'OK' : 'MISSING');
  console.log('SUPABASE_SERVICE_ROLE_KEY:', SUPABASE_SERVICE_ROLE_KEY ? 'OK' : 'MISSING');
  
  if (!FUSION_API_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Config incomplete: FUSION_API_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required');
  }
  console.log('Config OK');
}

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'DaloaMarket Payment API' });
});

// Temp: get outbound IP
app.get('/ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({ ip: data.ip, source: 'Railway outbound' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1) Créer un paiement
app.post('/create-payment', async (req, res) => {
  console.log('POST /create-payment received');
  console.log('Body:', req.body);
  try {
    checkConfig();
    
    const { type, amount, customerName, customerPhone, userId, metadata } = req.body;
    
    if (!type || !['seller_badge'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de paiement invalide.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Montant invalide.' });
    }
    if (!customerName || !customerPhone || !userId) {
      return res.status(400).json({ success: false, message: 'Informations client requises.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Crée la transaction
    const { data: tx, error: txErr } = await supabase
      .from('monetization_transactions')
      .insert({
        user_id: userId,
        type,
        amount: Math.round(amount),
        status: 'pending',
      })
      .select('id')
      .single();

    if (txErr || !tx) {
      return res.status(500).json({ success: false, message: txErr?.message || 'Erreur transaction.' });
    }

    const transactionId = tx.id;
    const baseUrl = SITE_URL.replace(/\/$/, '');
    const returnUrl = `${baseUrl}/payment/succes?txid=${transactionId}`;
    const webhookUrl = `${req.protocol}://${req.get('host')}/payment-webhook`;

    // Appelle Money Fusion
    const labelByType = { seller_badge: 'Badge Vendeur Pro (30 jours)' };
    const fusionPayload = {
      totalPrice: Math.round(amount),
      article: [{ [labelByType[type] || type]: Math.round(amount) }],
      personal_Info: [{ userId, transactionId, type, ...(metadata || {}) }],
      numeroSend: customerPhone,
      nomclient: customerName,
      return_url: returnUrl,
      webhook_url: webhookUrl,
    };

    console.log('Calling Money Fusion API:', FUSION_API_URL);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    
    let fusionRes, fusionData;
    try {
      fusionRes = await fetch(FUSION_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fusionPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      fusionData = await fusionRes.json().catch(() => null);
      console.log('Money Fusion response:', fusionRes.status, fusionData);
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      console.error('Money Fusion fetch error:', fetchErr.message);
      await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', transactionId);
      return res.status(502).json({ success: false, message: 'Money Fusion injoignable: ' + fetchErr.message });
    }
    
    if (!fusionRes.ok || !fusionData || fusionData.statut === false) {
      await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', transactionId);
      return res.status(502).json({ success: false, message: fusionData?.message || 'Erreur Money Fusion' });
    }

    // Stocke le token
    await supabase
      .from('monetization_transactions')
      .update({ provider_token: fusionData.token })
      .eq('id', transactionId);

    return res.json({
      success: true,
      transactionId,
      token: fusionData.token,
      paymentUrl: fusionData.url,
      message: fusionData.message || 'Paiement en cours',
    });
    
  } catch (e) {
    console.error('Create payment error:', e);
    return res.status(500).json({ success: false, message: e.message || 'Erreur serveur' });
  }
});

// 2) Vérifier le statut
app.get('/check-payment', async (req, res) => {
  try {
    checkConfig();
    
    const { transactionId } = req.query;
    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transactionId requis' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: tx, error } = await supabase
      .from('monetization_transactions')
      .select('id, type, status, amount, provider_token, confirmed_at')
      .eq('id', transactionId)
      .maybeSingle();

    if (error || !tx) {
      return res.status(404).json({ success: false, message: 'Transaction introuvable' });
    }

    if (tx.status === 'confirmed') {
      return res.json({ success: true, status: 'paid', transactionId: tx.id, amount: tx.amount, confirmedAt: tx.confirmed_at });
    }
    if (tx.status === 'failed') {
      return res.json({ success: true, status: 'failure', transactionId: tx.id, amount: tx.amount });
    }

    // Vérifie Money Fusion
    if (!tx.provider_token) {
      return res.json({ success: true, status: 'pending', transactionId: tx.id, amount: tx.amount, message: 'Token absent' });
    }

    const fusionRes = await fetch(`https://www.pay.moneyfusion.net/paiementNotif/${tx.provider_token}`);
    const fusionData = await fusionRes.json().catch(() => null);

    if (!fusionData || fusionData.statut !== true || !fusionData.data) {
      return res.json({ success: true, status: 'pending', transactionId: tx.id, amount: tx.amount });
    }

    const fusionStatus = fusionData.data.statut;
    const paymentMethod = fusionData.data.moyen;

    if (fusionStatus === 'paid') {
      const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
      const rpc = rpcByType[tx.type];
      
      if (rpc) {
        const { error: rpcErr } = await supabase.rpc(rpc, { p_transaction_id: tx.id });
        if (rpcErr) {
          console.error(`RPC ${rpc} failed for tx ${tx.id}:`, rpcErr);
          return res.status(500).json({ success: false, message: `Activation échouée: ${rpcErr.message}` });
        }
      } else {
        await supabase.from('monetization_transactions').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', tx.id);
      }
      
      return res.json({ success: true, status: 'paid', transactionId: tx.id, amount: tx.amount, paymentMethod, confirmedAt: new Date().toISOString() });
    }

    if (fusionStatus === 'failure' || fusionStatus === 'no paid') {
      await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', tx.id);
      return res.json({ success: true, status: fusionStatus, transactionId: tx.id, amount: tx.amount });
    }

    return res.json({ success: true, status: 'pending', transactionId: tx.id, amount: tx.amount });
    
  } catch (e) {
    console.error('Check payment error:', e);
    return res.status(500).json({ success: false, message: e.message || 'Erreur serveur' });
  }
});

// 3) Webhook Money Fusion
app.post('/payment-webhook', async (req, res) => {
  try {
    checkConfig();
    
    const payload = req.body;
    const personal = Array.isArray(payload?.personal_Info) ? payload.personal_Info[0] : null;
    const transactionId = personal?.transactionId;

    if (!transactionId) {
      return res.status(400).json({ ok: false, message: 'Transaction ID manquant' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Récupère la transaction
    const { data: tx, error } = await supabase
      .from('monetization_transactions')
      .select('id, type, status, provider_token')
      .eq('id', transactionId)
      .maybeSingle();

    if (error || !tx) {
      return res.status(404).json({ ok: false, message: 'Transaction introuvable' });
    }

    // Déjà confirmée
    if (tx.status === 'confirmed') {
      return res.json({ ok: true, message: 'Déjà confirmée' });
    }

    // Vérifie le statut via Money Fusion
    if (!tx.provider_token) {
      return res.status(400).json({ ok: false, message: 'Token absent' });
    }

    const fusionRes = await fetch(`https://www.pay.moneyfusion.net/paiementNotif/${tx.provider_token}`);
    const fusionData = await fusionRes.json().catch(() => null);

    if (!fusionData || fusionData.statut !== true || !fusionData.data) {
      return res.json({ ok: true, message: 'Statut non confirmé', status: 'pending' });
    }

    const fusionStatus = fusionData.data.statut;

    if (fusionStatus === 'paid') {
      const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
      const rpc = rpcByType[tx.type];
      
      if (rpc) {
        const { error: rpcErr } = await supabase.rpc(rpc, { p_transaction_id: tx.id });
        if (rpcErr) {
          console.error(`Webhook RPC ${rpc} failed for tx ${tx.id}:`, rpcErr);
          return res.status(500).json({ ok: false, message: `Activation échouée: ${rpcErr.message}` });
        }
      } else {
        await supabase.from('monetization_transactions').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', tx.id);
      }
      
      return res.json({ ok: true, message: 'Confirmée', status: 'paid' });
    }

    if (fusionStatus === 'failure' || fusionStatus === 'no paid') {
      await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', tx.id);
      return res.json({ ok: true, message: 'Échec enregistré', status: fusionStatus });
    }

    return res.json({ ok: true, message: 'En attente', status: 'pending' });
    
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(500).json({ ok: false, message: e.message || 'Erreur serveur' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Payment API running on port ${PORT}`);
});
