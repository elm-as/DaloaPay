const express = require('express');
const router = express.Router();
const { checkConfig, getSupabaseAdminClient } = require('../config/env');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { createOrderFromEscrow } = require('../services/escrow');
const { isUnderpaid, paidGrossAmount, confirmMonetizationOnce } = require('../services/monetization');

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

    // Contrôle du montant réellement encaissé (anti sous-paiement). Le montant
    // attendu est celui fixé par le serveur à la création du paiement.
    const expectedAmount = Number(tx.total_amount ?? tx.amount);
    if (fusionStatus === 'paid' && isUnderpaid(fusionData, expectedAmount)) {
      const paid = paidGrossAmount(fusionData);
      console.warn(`webhook: paiement insuffisant tx=${transactionId} brut=${paid} attendu=${expectedAmount}`);
      return res.json({ ok: true, status: 'underpaid', paid, expected: expectedAmount });
    }

    if (fusionStatus === 'paid') {
      if (isOrder) {
        console.log('webhook: payment confirmed, creating order...');
        await createOrderFromEscrow(supabase, tx, personal);
      } else {
        await confirmMonetizationOnce(supabase, tx);
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
