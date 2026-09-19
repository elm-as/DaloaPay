const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requêtes par 15 min par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes globales. Veuillez patienter.' },
});

const createPaymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // Max 10 créations de paiement par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop d\'intentions de paiement générées. Veuillez patienter 1 minute.' },
});

const checkPaymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Max 30 vérifications de paiement par minute par IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de vérifications de statut de paiement.' },
});

const payoutLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // Max 5 appels de payout par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Limite de traitement de payouts atteinte.' },
});

module.exports = {
  globalLimiter,
  createPaymentLimiter,
  checkPaymentLimiter,
  payoutLimiter,
};
