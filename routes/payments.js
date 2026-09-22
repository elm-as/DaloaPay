const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient } = require('../config/env');
const { createPaymentLimiter } = require('../config/rate-limiters');
const { requireAuthenticatedUser } = require('../middlewares/auth');
const { createPaymentSession } = require('../services/moneyfusion');
const { PRICING, haversineDistance, calculateDeliveryFee } = require('../services/escrow');

// 1) Créer un paiement (Order Escrow ou Monétisation)
router.post('/create-payment', requireAuthenticatedUser, createPaymentLimiter, async (req, res) => {
  console.log('POST /create-payment received', req.body);
  try {
    checkConfig();
    const { type, amount, customerName, customerPhone, userId, metadata, orderInput, orderInputs } = req.body;

    const allowedTypes = ['seller_badge', 'listing_pack_10', 'order', 'credits_pack_5', 'credits_pack_12', 'credits_pack_30'];
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
    const isPhase0 = phaseConfig.phase === 0;

    if (payConfig.disable_online_payments || payConfig.status === 'down') {
      return res.status(503).json({
        success: false,
        message: payConfig.notice || 'Les paiements Mobile Money sont temporairement suspendus pour maintenance.',
      });
    }

    let transactionId = '';
    let finalAmount = amount;

    if (type === 'order') {
      const rawItems = Array.isArray(orderInputs) && orderInputs.length > 0
        ? orderInputs
        : (orderInput ? [orderInput] : []);

      if (rawItems.length === 0) {
        return res.status(400).json({ success: false, message: 'Aucun article à commander.' });
      }

      const metaItems = [];
      let grandTotal = 0;
      const sellersCharged = new Set();

      for (const oi of rawItems) {
        let listing = null;
        const rawListingId = oi?.listing_id;
        if (rawListingId) {
          const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawListingId);
          if (isUUID) {
            const r = await supabase
              .from('listings')
              .select('id, price, user_id, stock, status, variants')
              .eq('id', rawListingId)
              .maybeSingle();
            listing = r.data;
          }
          if (!listing) {
            const r = await supabase
              .from('listings')
              .select('id, price, user_id, stock, status, variants')
              .ilike('id', `${rawListingId}%`)
              .limit(1)
              .maybeSingle();
            if (r.data) listing = r.data;
          }
        }

        if (!listing) {
          return res.status(404).json({ success: false, message: `Article introuvable (${rawListingId || '?'})` });
        }
        if (listing.status !== 'active') {
          return res.status(409).json({ success: false, message: 'Un article du panier n’est plus disponible.' });
        }

        const quantity = Math.max(1, Math.floor(Number(oi?.quantity) || 1));
        const variants = Array.isArray(listing.variants) ? listing.variants : [];
        const selectedVariant = oi?.variant_id ? variants.find((v) => v.id === oi.variant_id) : null;

        if (variants.length > 0 && (!selectedVariant || selectedVariant.active === false)) {
          return res.status(400).json({ success: false, message: 'Veuillez choisir une taille valide.' });
        }

        const availableStock = selectedVariant ? Number(selectedVariant.stock) || 0 : Number(listing.stock) || 0;
        if (availableStock < quantity) {
          return res.status(409).json({ success: false, message: 'La quantité demandée n’est plus disponible.' });
        }

        const unitPrice = selectedVariant?.price != null ? Number(selectedVariant.price) : Number(listing.price);
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          return res.status(400).json({ success: false, message: 'Prix de l’article invalide.' });
        }
        const productAmount = unitPrice * quantity;

        const { data: sellerProfile } = await supabase
          .from('users')
          .select('pro_until, shop_latitude, shop_longitude, district')
          .eq('id', listing.user_id)
          .single();
        const isProSeller = sellerProfile?.pro_until ? new Date(sellerProfile.pro_until) > new Date() : false;
        const sellerFeeRate = isPhase0 ? 0.0 : (isProSeller ? PRICING.PRO_SELLER_FEE_RATE : PRICING.SELLER_FEE_RATE);

        const DALOA_CENTER_LAT = 6.8773;
        const DALOA_CENTER_LNG = -6.4502;

        let validSellerLat = sellerProfile?.shop_latitude ?? null;
        let validSellerLng = sellerProfile?.shop_longitude ?? null;
        if (validSellerLat != null && validSellerLng != null) {
          if (haversineDistance(validSellerLat, validSellerLng, DALOA_CENTER_LAT, DALOA_CENTER_LNG) > 25) {
            validSellerLat = DALOA_CENTER_LAT;
            validSellerLng = DALOA_CENTER_LNG;
          }
        } else {
          validSellerLat = DALOA_CENTER_LAT;
          validSellerLng = DALOA_CENTER_LNG;
        }

        let validDeliveryLat = oi.delivery_lat ?? null;
        let validDeliveryLng = oi.delivery_lng ?? null;
        if (validDeliveryLat != null && validDeliveryLng != null) {
          if (haversineDistance(validDeliveryLat, validDeliveryLng, DALOA_CENTER_LAT, DALOA_CENTER_LNG) > 25) {
            validDeliveryLat = DALOA_CENTER_LAT;
            validDeliveryLng = DALOA_CENTER_LNG;
          }
        } else {
          validDeliveryLat = DALOA_CENTER_LAT;
          validDeliveryLng = DALOA_CENTER_LNG;
        }

        let distanceKm = haversineDistance(validDeliveryLat, validDeliveryLng, validSellerLat, validSellerLng);
        // Borner à la distance intra-urbaine maximale de Daloa (15 km)
        distanceKm = Math.min(15.0, Math.max(0.5, Math.round(distanceKm * 10) / 10));

        const isPickupMode = oi?.delivery_mode === 'pickup' || oi?.delivery_mode === 'pickup_point';
        const alreadyCharged = sellersCharged.has(listing.user_id);
        const deliveryFee = (isPickupMode || alreadyCharged) ? 0 : calculateDeliveryFee(distanceKm);
        if (!isPickupMode) sellersCharged.add(listing.user_id);

        const commission = Math.round(productAmount * PRICING.BUYER_FEE_RATE);
        const sellerCommission = Math.round(productAmount * sellerFeeRate);
        const itemTotal = productAmount + deliveryFee + commission;
        grandTotal += itemTotal;

        metaItems.push({
          listing_id: listing.id,
          seller_id: listing.user_id,
          variant_id: selectedVariant?.id || null,
          variant_label: selectedVariant?.label || null,
          unit_price: unitPrice,
          quantity,
          product_amount: productAmount,
          delivery_fee: deliveryFee,
          platform_fee: commission,
          seller_amount: productAmount - sellerCommission,
          delivery_address: oi.delivery_address || 'Daloa',
          delivery_mode: oi.delivery_mode || 'delivery',
          delivery_lat: deliveryLat,
          delivery_lng: deliveryLng,
          distance_km: Math.round(distanceKm * 10) / 10,
        });
      }

      finalAmount = grandTotal;

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
      if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: 'Montant invalide.' });

      const { data: tx, error: txErr } = await supabase
        .from('monetization_transactions')
        .insert({ user_id: userId, type, amount: Math.round(amount), status: 'pending' })
        .select('id')
        .single();

      if (txErr || !tx) return res.status(500).json({ success: false, message: txErr?.message || 'Erreur transaction.' });
      transactionId = tx.id;
    }

    const baseUrl = ENV.SITE_URL.replace(/\/$/, '');
    const returnUrl = `${baseUrl}/payment/success?transactionId=${transactionId}&type=${type}`;
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
      seller_badge: 'Badge Vendeur Pro (30 jours)',
      listing_pack_10: 'Pack 10 annonces (500 FCFA)',
      order: 'Achat de produit sur DaloaMarket',
      credits_pack_5: 'Pack Bronze (5 crédits)',
      credits_pack_12: 'Pack Argent (12 crédits)',
      credits_pack_30: 'Pack Or (30 crédits)',
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
