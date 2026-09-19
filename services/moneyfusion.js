const { ENV } = require('../config/env');

/**
 * Vérifie le statut d'un paiement auprès de MoneyFusion
 * @param {string} token - Token de paiement MoneyFusion
 */
async function checkPaymentNotification(token) {
  if (!token) return null;
  const fusionUrl = `https://pay.moneyfusion.net/paiementNotif/${token}`;
  const fusionRes = await fetch(fusionUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'DaloaMarket-Server/1.0',
    },
  });
  return await fusionRes.json().catch(() => null);
}

/**
 * Envoie une demande d'initialisation de paiement à MoneyFusion
 * @param {object} payload - Données du panier et client
 */
async function createPaymentSession(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const fusionRes = await fetch(ENV.FUSION_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DaloaMarket-Server/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const rawText = await fusionRes.text();
    const data = (() => {
      try {
        return JSON.parse(rawText);
      } catch {
        return null;
      }
    })();
    return { ok: fusionRes.ok, status: fusionRes.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Envoie une demande de virement (withdraw) à MoneyFusion
 * @param {object} payload - Coordonnées du bénéficiaire et montant
 * @param {string} privateKey - Clé privée MoneyFusion
 */
async function sendWithdraw(payload, privateKey) {
  const response = await fetch('https://pay.moneyfusion.net/api/v1/withdraw', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'moneyfusion-private-key': privateKey,
    },
    body: JSON.stringify(payload),
  });
  return await response.json();
}

module.exports = {
  checkPaymentNotification,
  createPaymentSession,
  sendWithdraw,
};
