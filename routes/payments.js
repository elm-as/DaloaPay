const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient } = require('../config/env');
const { createPaymentLimiter } = require('../config/rate-limiters');
const { requireAuthenticatedUser } = require('../middlewares/auth');
const { createPaymentSession } = require('../services/moneyfusion');
const { resolveMonetizationPrice } = require('../services/monetization');
const {
  QuoteError,
  buildOrderQuote,
  saveQuote,
  loadQuoteForPayment,
  markQuoteUsed,
} = require('../services/quote');

// 0) Devis de commande : calculé une fois ici, affiché tel quel par le client,
//    puis facturé tel quel (/create-payment avec quoteId, ou create_cod_order).
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
        // Distance affichée : la plus longue course du panier.
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

// 1) Créer un paiement (Order Escrow ou Monétisation)
router.post('/create-payment', requireAuthenticatedUser, createPaymentLimiter, async (req, res) => {
  console.log('POST /create-payment received', req.body);
  try {
    checkConfig();
    const { type, amount, plan, customerName, customerPhone, metadata, orderInput, orderInputs } = req.body;

    // L'acheteur est celui de la session, jamais celui du corps de la requête :
    // sinon on pouvait créer une commande ou activer un Pass Pro au nom d'autrui.
    const userId = req.user.id;
    if (req.body.userId && req.body.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Utilisateur non autorisé pour ce paiement.' });
    }

    // `listing_pack_10` (ancien pack de publication) n'est plus vendu : la
    // publication n'est plus limitée, les crédits servent au boost.
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

    let transactionId = '';
    let finalAmount = 0;
    let resolvedPlan = null;

    if (type === 'order') {
      // Avec un devis (applications à jour) : on facture exactement ce qui a été
      // affiché, après avoir vérifié que les articles se vendent au même prix.
      // Sans devis (anciennes applications) : calcul ici, et refus si le total
      // dépasse nettement celui que l'acheteur a vu.
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
              message: `Le prix de la livraison a été recalculé : le total est de ${finalAmount} FCFA et non ${displayedAmount} FCFA. Revenez à l'étape précédente pour actualiser, ou mettez l'application à jour.`,
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
      // Prix fixé par le serveur : le `amount` envoyé par l'appli est ignoré
      // (il ne sert qu'à reconnaître la formule Pro des anciennes APK).
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
    const webhookUrl = `${req.protocol}://${req.get('host')}/payment-webhook`;

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
      seller_badge: resolvedPlan === 'yearly' ? 'Pass Vendeur Pro (1 an)' : 'Pass Vendeur Pro (30 jours)',
      order: 'Achat de produit sur DaloaMarket',
      credits_pack_5: 'Pack Bronze (5 crédits de boost)',
      credits_pack_12: 'Pack Argent (12 crédits de boost)',
      credits_pack_30: 'Pack Or (30 crédits de boost)',
    };

    const fusionPayload = {
      totalPrice: Math.round(finalAmount),
      article: [{ [labelByType[type] || type]: Math.round(finalAmount) }],
      // Les identifiants passent en dernier : le webhook les relit, l'appli ne
      // doit pas pouvoir les écraser via `metadata` ou `orderInput`.
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

module.exports = router;
