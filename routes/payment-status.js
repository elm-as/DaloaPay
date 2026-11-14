const express = require('express');
const router = express.Router();
const { checkConfig, getSupabaseAdminClient } = require('../config/env');
const { checkPaymentLimiter } = require('../config/rate-limiters');
const { checkPaymentNotification } = require('../services/moneyfusion');
const { getCheckoutSession } = require('../services/saspay');
const { createOrderFromEscrow } = require('../services/escrow');
const { isUnderpaid, confirmMonetizationOnce } = require('../services/monetization');

const STATUS_MAP = {
  pending: 'pending',
  funded: 'paid',
  released: 'paid',
  cancelled: 'failure',
  failed: 'failure',
  confirmed: 'paid',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findTransaction(supabase, { table, refColumn, transactionId }) {
  if (UUID_RE.test(transactionId)) {
    const { data: byId } = await supabase.from(table).select('*').eq('id', transactionId).maybeSingle();
    if (byId) return byId;
  }
  const { data: byRef } = await supabase.from(table).select('*').eq(refColumn, transactionId).maybeSingle();
  return byRef || null;
}

async function resolveProviderOutcome(token, expectedAmount) {
  const isSasPay = UUID_RE.test(token);
  if (isSasPay) {
    const session = await getCheckoutSession(token);
    const isPaid = Boolean(session && ['PAID', 'SUCCESS'].includes(session.status || session.transaction_status));
    const isFailure = Boolean(session && ['FAILED', 'CANCELLED', 'EXPIRED'].includes(session.status));
    return { provider: 'saspay', isPaid, isFailure };
  }

  const fusionData = await checkPaymentNotification(token);
  const isPaidRaw = Boolean(fusionData && fusionData.statut === true && fusionData.data?.statut === 'paid');
  if (isPaidRaw && isUnderpaid(fusionData, expectedAmount)) {
    return { provider: 'moneyfusion', isPaid: false, isFailure: false };
  }
  const isFailure = Boolean(fusionData && fusionData.data?.statut === 'failure');
  return { provider: 'moneyfusion', isPaid: isPaidRaw, isFailure };
}

async function buildEscrowStatusResponse(supabase, escrow) {
  if (escrow.status !== 'pending') {
    return {
      success: true,
      status: STATUS_MAP[escrow.status] || 'unknown',
      transactionId: escrow.id,
      order_id: escrow.order_id || null,
      amount: escrow.total_amount,
      paymentMethod: escrow.payment_method,
      confirmedAt: escrow.funded_at,
    };
  }

  if (!escrow.payment_reference) {
    return {
      success: true,
      status: 'pending',
      transactionId: escrow.id,
      amount: escrow.total_amount,
      paymentMethod: escrow.payment_method,
    };
  }

  try {
    const outcome = await resolveProviderOutcome(escrow.payment_reference, escrow.total_amount);
    if (outcome.isPaid) {
      const orderId = await createOrderFromEscrow(supabase, escrow, null);
      return {
        success: true,
        status: 'paid',
        transactionId: escrow.id,
        order_id: orderId,
        amount: escrow.total_amount,
        paymentMethod: outcome.provider === 'saspay' ? 'mobile_money' : escrow.payment_method,
        confirmedAt: new Date().toISOString(),
      };
    }
    if (outcome.isFailure) {
      await supabase.from('escrow_transactions').update({ status: 'cancelled' }).eq('id', escrow.id);
      return { success: true, status: 'failure', transactionId: escrow.id };
    }
  } catch (providerErr) {
    console.warn('[check-payment] Escrow verification warning:', providerErr.message);
  }

  return {
    success: true,
    status: 'pending',
    transactionId: escrow.id,
    amount: escrow.total_amount,
    paymentMethod: escrow.payment_method,
  };
}

async function buildMonetizationStatusResponse(supabase, tx) {
  if (tx.status !== 'pending') {
    return {
      success: true,
      status: STATUS_MAP[tx.status] || 'unknown',
      transactionId: tx.id,
      amount: tx.amount,
      confirmedAt: tx.confirmed_at,
    };
  }

  if (!tx.provider_token) {
    return { success: true, status: tx.status, transactionId: tx.id, amount: tx.amount };
  }

  try {
    const outcome = await resolveProviderOutcome(tx.provider_token, tx.amount);
    if (outcome.isPaid) {
      await confirmMonetizationOnce(supabase, tx);
      return {
        success: true,
        status: 'paid',
        transactionId: tx.id,
        amount: tx.amount,
        confirmedAt: new Date().toISOString(),
      };
    }
    if (outcome.isFailure) {
      await supabase.from('monetization_transactions').update({ status: 'failed' }).eq('id', tx.id);
      return { success: true, status: 'failure', transactionId: tx.id };
    }
  } catch (providerErr) {
    console.warn('[check-payment] Monetization verification warning:', providerErr.message);
  }

  return { success: true, status: tx.status, transactionId: tx.id, amount: tx.amount };
}

router.get('/check-payment', checkPaymentLimiter, async (req, res) => {
  try {
    checkConfig();
    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ success: false, message: 'DB indisponible' });

    const transactionId = req.query.transactionId || req.query.txid || req.query.token;
    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transactionId requis' });
    }

    const escrow = await findTransaction(supabase, {
      table: 'escrow_transactions',
      refColumn: 'payment_reference',
      transactionId,
    });
    if (escrow) {
      return res.json(await buildEscrowStatusResponse(supabase, escrow));
    }

    const tx = await findTransaction(supabase, {
      table: 'monetization_transactions',
      refColumn: 'provider_token',
      transactionId,
    });
    if (tx) {
      return res.json(await buildMonetizationStatusResponse(supabase, tx));
    }

    return res.status(404).json({ success: false, message: 'Transaction introuvable', status: 'unknown' });
  } catch (e) {
    console.error('ERROR /check-payment:', e.message || e);
    return res.status(500).json({ success: false, message: e.message, status: 'unknown' });
  }
});

module.exports = router;
