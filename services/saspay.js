const { ENV } = require('../config/env');

const NETWORK_MAP = {
  'wave-ci': 'wave_ci',
  'orange-money-ci': 'orange_ci',
  'mtn-ci': 'mtn_ci',
  'moov-ci': 'moov_ci',
  'wave_ci': 'wave_ci',
  'orange_ci': 'orange_ci',
  'mtn_ci': 'mtn_ci',
  'moov_ci': 'moov_ci',
};

function getHeaders(idempotencyKey = null) {
  const headers = {
    'Authorization': `Bearer ${ENV.SASPAY_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'DaloaMarket-Server/1.0',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = String(idempotencyKey);
  }
  return headers;
}

/**
 * Crée une session de paiement hébergée SasPay
 */
async function createCheckoutSession(params) {
  const { amount, description, customerEmail, customerName, customerPhone, returnUrl, metadata } = params;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  const payload = {
    amount: Number(amount).toFixed(2),
    currency: 'XOF',
    country: 'CI',
    description: description || 'Paiement DaloaMarket',
    customer_email: customerEmail || 'client@daloamarket.com',
    customer_name: customerName || 'Client DaloaMarket',
    customer_phone: customerPhone || '',
    return_url: returnUrl,
    metadata: metadata || {},
  };

  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/checkout-sessions/`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const rawText = await res.text();
    let json = null;
    try {
      json = JSON.parse(rawText);
    } catch {
      json = null;
    }

    const data = json?.data || json;
    const checkoutUrl = data?.checkout_url || '';
    const id = data?.id || '';

    return {
      ok: res.ok,
      status: res.status,
      id,
      checkout_url: checkoutUrl,
      data,
      raw: json,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Récupère le détail d'une session de checkout SasPay
 */
async function getCheckoutSession(sessionId) {
  if (!sessionId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/checkout-sessions/${sessionId}/`, {
      headers: getHeaders(),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    const data = json?.data || json;
    return {
      ok: res.ok,
      status: data?.status || 'PENDING',
      transaction_id: data?.transaction?.id || data?.transaction_id || null,
      transaction_status: data?.transaction?.status || data?.transaction_status || null,
      data,
    };
  } catch (err) {
    console.error(`[SasPay] Erreur lecture session ${sessionId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vérifie le statut d'une session (avec fallback sur le détail de session)
 */
async function getCheckoutSessionStatus(sessionId) {
  if (!sessionId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/checkout-sessions/${sessionId}/status/`, {
      headers: getHeaders(),
      signal: controller.signal,
    });

    if (!res.ok) {
      return await getCheckoutSession(sessionId);
    }

    const json = await res.json().catch(() => null);
    const data = json?.data || json;
    return {
      ok: res.ok,
      status: data?.status || 'PENDING',
      transaction_id: data?.transaction_id || null,
      transaction_status: data?.transaction_status || null,
      data,
    };
  } catch {
    return await getCheckoutSession(sessionId);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vérifie une transaction directement auprès du gateway
 */
async function verifyTransaction(transactionId) {
  if (!transactionId) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/payments/${transactionId}/verify/`, {
      headers: getHeaders(),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    const data = json?.data || json;
    return {
      ok: res.ok,
      status: data?.status || 'PENDING',
      requested_amount: data?.requested_amount,
      debited_amount: data?.debited_amount,
      net_amount: data?.net_amount,
      data,
    };
  } catch (err) {
    console.error(`[SasPay] Erreur verifyTransaction ${transactionId}:`, err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Initialise un virement mobile money vers un vendeur / livreur (Payout)
 */
async function sendSasPayPayout(params) {
  const { amount, phone, withdrawMode, description, idempotencyKey } = params;
  const method = NETWORK_MAP[withdrawMode] || withdrawMode;
  const cleanPhone = String(phone || '').replace(/\s+/g, '').replace(/^\+225/, '');

  const payload = {
    amount: Number(amount).toFixed(2),
    currency: 'XOF',
    country: 'CI',
    customer: {
      phone: `+225${cleanPhone}`,
    },
    method: method,
    recipient: {
      msisdn: cleanPhone,
    },
    description: description || 'Virement DaloaMarket',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/payouts/initialize/`, {
      method: 'POST',
      headers: getHeaders(idempotencyKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => null);
    const data = json?.data || json;

    return {
      ok: res.ok,
      status: res.status,
      id: data?.id || null,
      message: data?.message || json?.message || json?.error?.message || json?.detail,
      data,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Récupère l'état d'activité des réseaux télécoms (Wave, Orange, MTN, Moov, Djamo)
 * Utile pour l'affichage admin et pour prévenir les utilisateurs en cas de panne opérateur.
 */
async function getNetworksStatus(countryCode = 'CI') {
  try {
    const res = await fetch(`${ENV.SASPAY_API_URL}/networks/?page_size=100`, {
      headers: getHeaders(),
    });
    if (!res.ok) return { ok: false, networks: [] };
    const json = await res.json().catch(() => null);
    const all = json?.data?.results || [];
    const suffix = `_${countryCode.toLowerCase()}`;
    const networks = all
      .filter((n) => n.code && n.code.endsWith(suffix))
      .map((n) => ({
        code: n.code,
        name: n.name,
        isActive: Boolean(n.is_active),
      }));
    return { ok: true, networks };
  } catch (err) {
    return { ok: false, error: err.message, networks: [] };
  }
}

module.exports = {
  createCheckoutSession,
  getCheckoutSession,
  getCheckoutSessionStatus,
  verifyTransaction,
  sendSasPayPayout,
  getNetworksStatus,
};

