/**
 * Contrôle du bannissement d'IP (api.daloamarket.com).
 *
 * Différence avec la version d'origine : l'IP n'est plus lue directement dans
 * `x-forwarded-for`. Cet en-tête est fourni par le client et n'importe qui
 * pouvait donc se présenter sous une IP arbitraire pour contourner un
 * bannissement. On s'appuie sur `req.ip`, que Express calcule correctement
 * grâce à `app.set('trust proxy', 1)`.
 */

function extractClientIp(req) {
  // req.ip tient compte de trust proxy : dernière IP de confiance de la chaîne.
  const ip = req.ip || req.socket?.remoteAddress || '';
  // Normalise les IPv4 encapsulées en IPv6 (::ffff:1.2.3.4)
  return String(ip).replace(/^::ffff:/, '').trim();
}

function createIpBanMiddleware(supabase) {
  // Cache mémoire borné (TTL 60 s) pour éviter un appel DB par requête.
  const bannedIpCache = new Map();
  const CACHE_TTL_MS = 60 * 1000;
  const CACHE_MAX_ENTRIES = 5000;

  function cacheSet(ip, banned) {
    // Éviction simple : au-delà du plafond, on vide les entrées expirées puis,
    // si besoin, la plus ancienne. Sans cela une boucle d'IP forgées ferait
    // croître la Map indéfiniment.
    if (bannedIpCache.size >= CACHE_MAX_ENTRIES) {
      const now = Date.now();
      for (const [key, value] of bannedIpCache) {
        if (now - value.timestamp >= CACHE_TTL_MS) bannedIpCache.delete(key);
      }
      if (bannedIpCache.size >= CACHE_MAX_ENTRIES) {
        const oldest = bannedIpCache.keys().next().value;
        if (oldest !== undefined) bannedIpCache.delete(oldest);
      }
    }
    bannedIpCache.set(ip, { banned, timestamp: Date.now() });
  }

  return async function ipBanMiddleware(req, res, next) {
    try {
      const clientIp = extractClientIp(req);
      if (!clientIp || !supabase) return next();

      const cached = bannedIpCache.get(clientIp);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        if (cached.banned) return res.status(403).json(BANNED_BODY);
        return next();
      }

      const { data, error } = await supabase.rpc('is_ip_banned', { p_ip: clientIp });
      const isBanned = !error && data === true;
      cacheSet(clientIp, isBanned);

      if (isBanned) return res.status(403).json(BANNED_BODY);
      next();
    } catch (e) {
      // Fail-open volontaire : une panne du contrôle ne doit pas couper le service.
      console.warn('[ipBanMiddleware] Warning:', e.message);
      next();
    }
  };
}

// L'IP n'est plus renvoyée au client : inutile pour lui, et c'est une donnée
// personnelle qu'on évite de réfléchir dans une réponse d'erreur.
const BANNED_BODY = {
  error: 'Accès refusé',
  message: 'Votre adresse IP a été suspendue de la plateforme DaloaMarket.',
};

module.exports = { createIpBanMiddleware, extractClientIp };
