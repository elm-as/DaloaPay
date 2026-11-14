const express = require('express');
const router = express.Router();
const { ENV, checkConfig, getSupabaseAdminClient } = require('../config/env');
const { requireWebhookSecret } = require('../middlewares/auth');
const { sendPushToUser } = require('../services/push');

// Webhook pour le résultat des Payouts (MoneyFusion & SasPay)
router.post('/payout-webhook', requireWebhookSecret(ENV.PAYOUT_WEBHOOK_SECRET, 'x-payout-webhook-secret'), async (req, res) => {
  console.log('[Webhook Payout Received] Payload:', JSON.stringify(req.body));
  try {
    checkConfig();
    const { event, tokenPay, message, id } = req.body;
    const refToken = tokenPay || id;

    if (!refToken) {
      return res.status(400).json({ ok: false, message: 'Token absent' });
    }

    const supabase = getSupabaseAdminClient();
    if (!supabase) return res.status(503).json({ ok: false, message: 'DB indisponible' });

    const isSuccess = event === 'payout.session.completed' || event === 'payout.success';
    const isCancelled = event === 'payout.session.cancelled' || event === 'payout.failed';

    if (isSuccess) {
      const { data: updated } = await supabase
        .from('payouts')
        .update({ status: 'paid', completed_at: new Date().toISOString() })
        .eq('provider_token', refToken)
        .select('id, recipient_id, recipient_type, net_amount')
        .maybeSingle();
      if (updated?.recipient_id) {
        const isDriver = updated.recipient_type === 'delivery';
        const amt = Number(updated.net_amount || 0).toLocaleString('fr-FR');
        sendPushToUser(updated.recipient_id, {
          title: '💸 Versement Mobile Money envoyé !',
          body: `Votre virement de ${amt} FCFA a été crédité sur votre compte Mobile Money.`,
          url: isDriver ? '/earnings' : '/mes-paiements',
          tag: `payout-${updated.id}`,
        }, { appType: isDriver ? 'delivery' : 'market' }).catch((err) => {
          console.warn('[Push Notification Warning]:', err?.message);
        });
      }
    } else if (isCancelled) {
      const { data: updated } = await supabase
        .from('payouts')
        .update({ status: 'failed', failure_reason: message || 'Annulé par passerelle de paiement' })
        .eq('provider_token', refToken)
        .select('id, recipient_id, recipient_type, net_amount')
        .maybeSingle();
      if (updated?.recipient_id) {
        const isDriver = updated.recipient_type === 'delivery';
        const amt = Number(updated.net_amount || 0).toLocaleString('fr-FR');
        sendPushToUser(updated.recipient_id, {
          title: '⚠️ Échec du versement Mobile Money',
          body: `Le virement de ${amt} FCFA n'a pas abouti. Vérifiez votre numéro de retrait.`,
          url: isDriver ? '/payout-setup' : '/settings/payout',
          tag: `payout-${updated.id}`,
        }, { appType: isDriver ? 'delivery' : 'market' }).catch((err) => {
          console.warn('[Push Notification Warning]:', err?.message);
        });
      }
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[Webhook Payout Exception]:', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
