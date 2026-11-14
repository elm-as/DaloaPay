const express = require('express');
const { getSupabaseAdminClient } = require('../config/env');
const { requireAdminUser } = require('../middlewares/auth');
const { fetchAdminAnalytics, normalizeAnalyticsDays } = require('../services/admin-analytics');

const router = express.Router();

/**
 * GET /admin/analytics?days=7|14|30|90
 * Retourne les séries journalières, variations et répartitions métier pour le tableau de bord admin.
 */
router.get('/admin/analytics', requireAdminUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return res.status(503).json({ success: false, message: 'Client Supabase indisponible.' });
    }

    const days = normalizeAnalyticsDays(req.query.days);
    const analytics = await fetchAdminAnalytics(supabase, days);

    return res.json({ success: true, analytics });
  } catch (err) {
    console.error('[GET /admin/analytics Error]:', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Impossible de calculer les statistiques admin.',
    });
  }
});

module.exports = router;
