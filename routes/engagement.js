const express = require('express');
const router = express.Router();
const { requireAuthenticatedUser, requireAdminUser, allowSecretOrAuthenticatedUser } = require('../middlewares/auth');
const {
  fetchListingEngagementSignals,
  fetchMarketplaceProofStats,
  fetchSellerWeeklyProgress,
} = require('../services/engagement-signals');
const { executeBehavioralNudges } = require('../services/engagement-nudges');

router.get('/api/engagement/listing/:id', async (req, res) => {
  try {
    const signals = await fetchListingEngagementSignals(req.params.id);
    return res.json({ success: true, ...signals });
  } catch (err) {
    console.warn('[Engagement Listing Signals]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/engagement/marketplace-stats', async (req, res) => {
  try {
    const stats = await fetchMarketplaceProofStats();
    return res.json({ success: true, ...stats });
  } catch (err) {
    console.warn('[Engagement Marketplace Stats]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/api/engagement/seller-progress', requireAuthenticatedUser, async (req, res) => {
  try {
    const progress = await fetchSellerWeeklyProgress(req.user.id);
    return res.json({ success: true, ...progress });
  } catch (err) {
    console.warn('[Engagement Seller Progress]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/api/engagement/run-nudges', requireAdminUser, async (req, res) => {
  try {
    const dryRun = Boolean(req.body?.dryRun ?? req.query.dryRun === 'true');
    const result = await executeBehavioralNudges({ dryRun });
    return res.json(result);
  } catch (err) {
    console.error('[Engagement Run Nudges]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/jobs/engagement-nudges', allowSecretOrAuthenticatedUser, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const result = await executeBehavioralNudges({ dryRun });
    return res.json(result);
  } catch (err) {
    console.error('[Engagement Cron Job]:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

