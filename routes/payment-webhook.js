const express = require('express');
const router = express.Router();
const { checkConfig, getSupabaseAdminClient } = require('../config/env');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { createOrderFromEscrow } = require('../services/escrow');

// 2) Webhook Money Fusion
router.post('/payment-webhook', async (req, res) => {
  try {
    checkConfig();
    const payload = req.body;
    const personal = Array.isArray(payload?.personal_Info) ? payload.personal_Info[0] : null;
    const transactionId = personal?.transactionId;
    const type = personal?.type;

    if (!transactionId || !type) return res.status(400).json({ ok: false, message: 'Données de requête invalides' });

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

    const isOrder = type === 'order';
    const table = isOrder ? 'escrow_transactions' : 'monetization_transactions';

    const { data: tx, error } = await supabase.from(table).select('*').eq('id', transactionId).maybeSingle();
    if (error || !tx) return res.status(404).json({ ok: false, message: 'Transaction introuvable' });

    if ((isOrder && tx.status !== 'pending') || (!isOrder && tx.status === 'confirmed')) {
      return res.json({ ok: true, message: 'Déjà confirmée' });
    }

    const token = isOrder ? tx.payment_reference : tx.provider_token;
    if (!token) return res.status(400).json({ ok: false, message: 'Token absent' });

    const fusionData = await checkPaymentNotification(token);
    if (!fusionData || fusionData.statut !== true || !fusionData.data) {
      return res.json({ ok: true, status: 'pending' });
    }

    const fusionStatus = fusionData.data.statut;

    // Contrôle du montant réellement encaissé (anti sous-paiement)
    const paidAmountRaw = fusionData.data.Montant ?? fusionData.data.montant;
    const paidAmount = Number(paidAmountRaw);
    const expectedAmount = Number(tx.total_amount ?? tx.amount);

    if (fusionStatus === 'paid' && Number.isFinite(paidAmount) && Number.isFinite(expectedAmount)
        && paidAmount > 0 && paidAmount < expectedAmount) {
      console.warn(
        `webhook: paiement insuffisant tx=${transactionId} encaisse=${paidAmount} attendu=${expectedAmount}`
      );
      return res.json({
        ok: true,
        status: 'underpaid',
        paid: paidAmount,
        expected: expectedAmount,
      });
    }

    if (fusionStatus === 'paid') {
      if (isOrder) {
        console.log('webhook: payment confirmed, creating order...');
        await createOrderFromEscrow(supabase, tx, personal);
      } else {
        const rpcByType = { seller_badge: 'confirm_seller_badge', boost: 'confirm_boost', bump: 'confirm_bump' };
        if (rpcByType[type]) {
          await supabase.rpc(rpcByType[type], { p_transaction_id: transactionId });
        } else if (type === 'listing_pack_10' || type === 'credits_pack_5' || type === 'credits_pack_12' || type === 'credits_pack_30') {
          const qty = type === 'listing_pack_10' ? 10 : Number(type.split('_')[2]) || 5;
          await supabase.rpc('add_listing_credits', { user_uuid: tx.user_id, quantity: qty });
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

module.exports = router;
