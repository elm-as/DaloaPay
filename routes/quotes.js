const express = require('express');
const router = express.Router();
const { checkConfig, getSupabaseAdminClient } = require('../config/env');
const { requireAuthenticatedUser } = require('../middlewares/auth');
const { QuoteError, buildOrderQuote, saveQuote } = require('../services/quote');

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

module.exports = router;

