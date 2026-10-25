const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient } = require('../config/env');
const { createPaymentLimiter } = require('../config/rate-limiters');
const { requireAuthenticatedUser } = require('../middlewares/auth');
const { createPaymentSession } = require('../services/moneyfusion');
const { createCheckoutSession } = require('../services/saspay');
const { resolveMonetizationPrice } = require('../services/monetization');
const {
  QuoteError,
  buildOrderQuote,
  saveQuote,
  loadQuoteForPayment,
  markQuoteUsed,
} = require('../services/quote');

// 0) Devis de commande : calculé une fois ici, affiché tel quel par le client
router.post('/quote', requireAuthenticatedUser, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const { data: phaseRow } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'phase_config')
      .maybeSingle();
    const phaseConfig = phaseRow?.value || {};

    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const quote = await buildOrderQuote(supabase, { rawItems, phaseConfig });
    const saved = await saveQuote(supabase, req.user.id, quote, rawItems[0]?.delivery_address);

    return res.json({
      success: true,
      quote: {
        id: saved.id,
        expiresAt: saved.expires_at,
        deliveryMode: saved.delivery_mode,
        sellers: saved.sellers,
        productTotal: saved.product_total,
        deliveryTotal: saved.delivery_total,
        buyerFeeTotal: saved.buyer_fee_total,
        totalAmount: saved.total_amount,
        distanceKm: Math.max(0, ...saved.sellers.map((x) => Number(x.distance_km) || 0)),
      },
    });
  } catch (err) {
    if (err instanceof QuoteError) {
      return res.status(err.status).json({ success: false, reason: err.reason, message: err.message });
    }
    console.error('POST /quote error:', err);
    return res.status(500).json({ success: false, message: 'Devis indisponible, réessayez.' });
  }
});

// 1) Créer un paiement (Order Escrow ou Monétisation) — MoneyFusion ou SasPay
router.post('/create-payment', requireAuthenticatedUser, createPaymentLimiter, async (req, res) => {
  console.log('POST /create-payment received', req.body);
  try {
    checkConfig();
    const { type, amount, plan, customerName, customerPhone, metadata, orderInput, orderInputs } = req.body;

    const userId = req.user.id;
    if (req.body.userId && req.body.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Utilisateur non autorisé pour ce paiement.' });
    }

    const allowedTypes = ['seller_badge', 'order', 'credits_pack_5', 'credits_pack_12', 'credits_pack_30'];
    if (!type || !allowedTypes.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de paiement invalide.' });
    }

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const { data: allSettings } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', ['payment_settings', 'phase_config']);

    const settingsMap = {};
    (allSettings || []).forEach((s) => { settingsMap[s.key] = s.value; });

    const payConfig = settingsMap['payment_settings'] || {};
    const phaseConfig = settingsMap['phase_config'] || {};

    if (payConfig.disable_online_payments || payConfig.status === 'down') {
      return res.status(503).json({
        success: false,
        message: payConfig.notice || 'Les paiements Mobile Money sont temporairement suspendus pour maintenance.',
      });
    }

    if (type === 'seller_badge' && phaseConfig.enable_seller_badge === false) {
      return res.status(403).json({
        success: false,
        message: 'Le Pass Vendeur Pro est actuellement désactivé par l’administration.',
      });
    }

    if (type.startsWith('credits_pack_') && phaseConfig.enable_boost === false) {
      return res.status(403).json({
        success: false,
        message: 'Les options de boost et packs de crédits sont actuellement désactivées.',
      });
    }

    // Sélection du prestataire : priorité à la config DB (à chaud), sinon env var
    const activeProvider = payConfig.provider || ENV.PAYMENT_PROVIDER || 'moneyfusion';

    let transactionId = '';
    let finalAmount = 0;
    let resolvedPlan = null;

    if (type === 'order') {
      let metaItems;
      let quoteId = null;
      try {
        if (req.body.quoteId) {
          const quote = await loadQuoteForPayment(supabase, req.body.quoteId, userId);
          metaItems = quote.items;
          finalAmount = quote.total_amount;
          quoteId = quote.id;
        } else {
          const rawItems = Array.isArray(orderInputs) && orderInputs.length > 0
            ? orderInputs
            : (orderInput ? [orderInput] : []);
          const computed = await buildOrderQuote(supabase, { rawItems, phaseConfig });
          metaItems = computed.items;
          finalAmount = computed.totals.total_amount;

          const displayedAmount = Number(amount) || 0;
          if (displayedAmount > 0 && finalAmount > displayedAmount + 100) {
            return res.status(409).json({
              success: false,
              reason: 'amount_mismatch',
              serverAmount: finalAmount,
              message: `Le prix de la livraison a été recalculé : le total est de ${finalAmount} FCFA et non ${displayedAmount} FCFA. Revenez à l'étape précédente pour actualiser.`,
            });
          }
        }
        if (quoteId) await markQuoteUsed(supabase, quoteId, 'online');
      } catch (err) {
        if (err instanceof QuoteError) {
          return res.status(err.status).json({ success: false, reason: err.reason, message: err.message });
        }
        throw err;
      }

      const { data: escrow, error: escrowErr } = await supabase
        .from('escrow_transactions')
        .insert({
          order_id: null,
          buyer_id: userId,
          seller_id: metaItems[0].seller_id,
          total_amount: finalAmount,
          seller_amount: metaItems.reduce((s, i) => s + i.seller_amount, 0),
          delivery_fee: metaItems.reduce((s, i) => s + i.delivery_fee, 0),
          platform_fee: metaItems.reduce((s, i) => s + i.platform_fee, 0),
          status: 'pending',
          payment_method: 'mobile_money',
          order_metadata: {
            items: metaItems,
            delivery_address: metaItems[0].delivery_address,
            delivery_mode: metaItems[0].delivery_mode,
            quote_id: quoteId,
          },
        })
        .select('id')
        .single();

      if (escrowErr || !escrow) {
        console.error('Escrow creation error:', escrowErr);
        return res.status(500).json({ success: false, message: escrowErr?.message || 'Erreur création escrow' });
      }
      transactionId = escrow.id;

    } else {
      const price = resolveMonetizationPrice(type, plan, amount);
      if (!price) return res.status(400).json({ success: false, message: 'Type de paiement invalide.' });
      finalAmount = price.amount;
      resolvedPlan = price.plan;

      const { data: tx, error: txErr } = await supabase
        .from('monetization_transactions')
        .insert({ user_id: userId, type, amount: finalAmount, status: 'pending' })
        .select('id')
        .single();

      if (txErr || !tx) return res.status(500).json({ success: false, message: txErr?.message || 'Erreur transaction.' });
      transactionId = tx.id;
    }

    const baseUrl = ENV.SITE_URL.replace(/\/$/, '');
    const isApp = req.body.source === 'app' || req.body.platform === 'app';
    const sourceParam = isApp ? '&source=app' : '';
    const host = req.get('host');
    const webhookUrl = ENV.PUBLIC_API_URL
      ? `${ENV.PUBLIC_API_URL}/payment-webhook`
      : `https://${host}/payment-webhook`;

    let resolvedName = (customerName || '').trim();
    let cleanPhone = (customerPhone || '').trim().replace(/\s+/g, '');
    let resolvedEmail = '';

    if (userId) {
      const { data: u } = await supabase.from('users').select('phone, full_name, email').eq('id', userId).maybeSingle();
      if (!cleanPhone && u?.phone) cleanPhone = u.phone.trim().replace(/\s+/g, '');
      if (!resolvedName && u?.full_name) resolvedName = u.full_name.trim();
      if (u?.email) resolvedEmail = u.email.trim();
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
      seller_badge: resolvedPlan === 'yearly' ? 'Pass Vendeur Pro (1 an)' : 'Pass Vendeur Pro (30 jours)',
      order: 'Achat de produit sur DaloaMarket',
      credits_pack_5: 'Pack Bronze (5 crédits de boost)',
      credits_pack_12: 'Pack Argent (12 crédits de boost)',
      credits_pack_30: 'Pack Or (30 crédits de boost)',
    };

    // BRANCH 1 : Prestataire SasPay
    if (activeProvider === 'saspay') {
      if (!resolvedEmail) resolvedEmail = `client_${userId.slice(0, 8)}@daloamarket.com`;
      const saspayRes = await createCheckoutSession({
        amount: Math.round(finalAmount),
        description: labelByType[type] || 'Commande DaloaMarket',
        customerEmail: resolvedEmail,
        customerName: resolvedName || 'Client DaloaMarket',
        customerPhone: cleanPhone ? `+225${cleanPhone}` : '',
        returnUrl,
        metadata: { userId, transactionId, type, ...(metadata || {}), ...(orderInput || {}) },
      });

      if (!saspayRes.ok || !saspayRes.checkout_url) {
        console.error('[SasPay Init Error]:', saspayRes.data);
        return res.status(502).json({ success: false, message: saspayRes.data?.message || 'Erreur passerelle SasPay' });
      }

      const token = saspayRes.id;
      const paymentUrl = saspayRes.checkout_url;

      if (type === 'order') {
        const { data: cur } = await supabase.from('escrow_transactions').select('order_metadata').eq('id', transactionId).maybeSingle();
        const updatedMeta = { ...(cur?.order_metadata || {}), checkout_url: paymentUrl };
        await supabase.from('escrow_transactions').update({ payment_reference: token, order_metadata: updatedMeta }).eq('id', transactionId);
        return res.json({ success: true, token, payment_url: paymentUrl, paymentUrl, transactionId });
      } else {
        const { data: curTx } = await supabase.from('monetization_transactions').select('metadata').eq('id', transactionId).maybeSingle();
        const updatedMeta = { ...(curTx?.metadata || {}), checkout_url: paymentUrl };
        await supabase.from('monetization_transactions').update({ provider_token: token, metadata: updatedMeta }).eq('id', transactionId);
        return res.json({ success: true, transactionId, token, paymentUrl, payment_url: paymentUrl });
      }
    }

    // BRANCH 2 : Prestataire MoneyFusion (par défaut)
    const fusionPayload = {
      totalPrice: Math.round(finalAmount),
      article: [{ [labelByType[type] || type]: Math.round(finalAmount) }],
      personal_Info: [{ ...(metadata || {}), ...(orderInput || {}), userId, transactionId, type }],
      numeroSend: cleanPhone,
      nomclient: resolvedName || 'Client DaloaMarket',
      return_url: returnUrl,
      webhook_url: webhookUrl,
    };

    const { ok, data: fusionData } = await createPaymentSession(fusionPayload);
    if (!ok || !fusionData || fusionData.statut === false) {
      return res.status(502).json({ success: false, message: fusionData?.message || 'Erreur Money Fusion' });
    }

    let validPaymentUrl = fusionData.url;
    if (!validPaymentUrl && fusionData.token) {
      validPaymentUrl = `https://payin.moneyfusion.net/payment/${fusionData.token}/${Math.round(finalAmount)}/${encodeURIComponent(resolvedName || 'Client')}`;
    }

    if (type === 'order') {
      const { data: cur } = await supabase.from('escrow_transactions').select('order_metadata').eq('id', transactionId).maybeSingle();
      const updatedMeta = { ...(cur?.order_metadata || {}), checkout_url: validPaymentUrl };
      await supabase.from('escrow_transactions').update({ payment_reference: fusionData.token, order_metadata: updatedMeta }).eq('id', transactionId);
      return res.json({ success: true, token: fusionData.token, payment_url: validPaymentUrl, paymentUrl: validPaymentUrl, transactionId });
    } else {
      const { data: curTx } = await supabase.from('monetization_transactions').select('metadata').eq('id', transactionId).maybeSingle();
      const updatedMeta = { ...(curTx?.metadata || {}), checkout_url: validPaymentUrl };
      await supabase.from('monetization_transactions').update({ provider_token: fusionData.token, metadata: updatedMeta }).eq('id', transactionId);
      return res.json({ success: true, transactionId, token: fusionData.token, paymentUrl: validPaymentUrl, payment_url: validPaymentUrl });
    }
  } catch (e) {
    console.error('ERROR /create-payment:', e.message || e);
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
