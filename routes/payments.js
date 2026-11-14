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
  loadQuoteForPayment,
  markQuoteUsed,
} = require('../services/quote');

// Verrou en mémoire anti-clics concurrents (ex: double-tap rapide)
const inFlightRequests = new Map();

function withInFlightLock(key, fn) {
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      setTimeout(() => inFlightRequests.delete(key), 3000);
    }
  })();
  inFlightRequests.set(key, promise);
  return promise;
}

/**
 * Normalise un numéro de téléphone ivoirien pour les passerelles de paiement.
 */
function normalizeCustomerPhone(phone) {
  let clean = (phone || '').trim().replace(/\s+/g, '');
  if (clean.startsWith('+225')) clean = clean.slice(4);
  else if (clean.startsWith('225') && clean.length === 13) clean = clean.slice(3);
  else if (clean.startsWith('00225')) clean = clean.slice(5);
  return (!clean || clean === '0000000000') ? '0700000000' : clean;
}

/**
 * Associe le token et l'URL de paiement à la transaction Supabase.
 */
async function attachPaymentSession(supabase, { type, transactionId, token, paymentUrl }) {
  const isOrder = type === 'order';
  const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';
  const metaCol = isOrder ? 'order_metadata' : 'metadata';
  const tokenCol = isOrder ? 'payment_reference' : 'provider_token';

  const { data: cur } = await supabase.from(table).select(metaCol).eq('id', transactionId).maybeSingle();
  const updatedMeta = { ...(cur?.[metaCol] || {}), checkout_url: paymentUrl };
  await supabase.from(table).update({ [tokenCol]: token, [metaCol]: updatedMeta }).eq('id', transactionId);

  return { success: true, transactionId, token, paymentUrl, payment_url: paymentUrl };
}

// 1) Créer un paiement (Order Escrow ou Monétisation) — MoneyFusion ou SasPay
router.post('/create-payment', requireAuthenticatedUser, createPaymentLimiter, async (req, res) => {
  const userId = req.user.id;
  const lockKey = `${userId}:${req.body.type}:${req.body.quoteId || req.body.plan || req.body.amount || ''}`;

  if (inFlightRequests.has(lockKey)) {
    return res.status(409).json({
      success: false,
      message: 'Une création de paiement est déjà en cours de traitement pour cette commande. Veuillez patienter.',
    });
  }

  return withInFlightLock(lockKey, async () => {
    try {
      checkConfig();
      const { type, amount, plan, customerName, customerPhone, metadata, orderInput, orderInputs } = req.body;

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

      const activeProvider = payConfig.provider || ENV.PAYMENT_PROVIDER || 'moneyfusion';

      let transactionId = '';
      let finalAmount = 0;
      let resolvedPlan = null;

      if (type === 'order') {
        let metaItems;
        let quoteId = null;
        let appliedDaloaCash = 0;
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

          // Validation serveur de la réduction Daloa Cash (F10)
          const deliveryTotal = metaItems.reduce((s, i) => s + (i.delivery_fee || 0), 0);
          const explicitDiscount = Number(req.body.daloaCashDiscount ?? req.body.daloa_cash_discount ?? metadata?.daloaCashDiscount ?? 0) || 0;
          const implicitDiscount = quoteId && Number(amount) > 0 && Number(amount) < finalAmount
            ? finalAmount - Number(amount)
            : 0;
          const requestedDiscount = Math.max(explicitDiscount, implicitDiscount);

          if (requestedDiscount > 0 && deliveryTotal > 0) {
            const { data: buyerRow } = await supabase
              .from('users')
              .select('daloa_cash_balance')
              .eq('id', userId)
              .maybeSingle();
            const availableBalance = Math.max(0, Number(buyerRow?.daloa_cash_balance) || 0);
            appliedDaloaCash = Math.min(requestedDiscount, availableBalance, deliveryTotal);
            finalAmount = Math.max(0, finalAmount - appliedDaloaCash);
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
              daloa_cash_discount: appliedDaloaCash,
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
      const returnUrl = `${baseUrl}/payment/success?transactionId=${transactionId}&type=${type}${sourceParam}`;
      const host = req.get('host');
      const webhookUrl = ENV.PUBLIC_API_URL
        ? `${ENV.PUBLIC_API_URL}/payment-webhook`
        : `https://${host}/payment-webhook`;

      let resolvedName = (customerName || '').trim();
      let cleanPhone = normalizeCustomerPhone(customerPhone);
      let resolvedEmail = '';

      if (userId) {
        const { data: u } = await supabase.from('users').select('phone, full_name, email').eq('id', userId).maybeSingle();
        if ((!cleanPhone || cleanPhone === '0700000000') && u?.phone) cleanPhone = normalizeCustomerPhone(u.phone);
        if (!resolvedName && u?.full_name) resolvedName = u.full_name.trim();
        if (u?.email) resolvedEmail = u.email.trim();
      }

      const labelByType = {
        seller_badge: resolvedPlan === 'yearly' ? 'Pass Vendeur Pro (1 an)' : 'Pass Vendeur Pro (30 jours)',
        order: 'Achat de produit sur DaloaMarket',
        credits_pack_5: 'Pack Bronze (5 crédits de boost)',
        credits_pack_12: 'Pack Argent (12 crédits de boost)',
        credits_pack_30: 'Pack Or (30 crédits de boost)',
      };

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

        const attached = await attachPaymentSession(supabase, {
          type,
          transactionId,
          token: saspayRes.id,
          paymentUrl: saspayRes.checkout_url,
        });
        return res.json(attached);
      }

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

      const attached = await attachPaymentSession(supabase, {
        type,
        transactionId,
        token: fusionData.token,
        paymentUrl: validPaymentUrl,
      });
      return res.json(attached);
    } catch (e) {
      console.error('ERROR /create-payment:', e.message || e);
      return res.status(500).json({ success: false, message: e.message });
    }
  });
});

module.exports = router;
