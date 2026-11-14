const { ENV, getSupabaseAdminClient, secretMatches } = require('../config/env');

function requireAdminSecret(req, res, next) {
  if (!ENV.ADMIN_SECRET) {
    return res.status(503).json({ success: false, message: 'Administration non configurée.' });
  }
  if (!secretMatches(req.get('x-admin-secret'), ENV.ADMIN_SECRET)) {
    return res.status(403).json({ success: false, message: 'Accès non autorisé.' });
  }
  next();
}

/**
 * Exige soit :
 * 1. Le secret machine valide (en-tête `x-admin-secret` ou paramètre d'URL `?secret=...` / `?key=...` / `?token=...`)
 * 2. Un utilisateur authentifié valide (jeton JWT Bearer)
 *
 * Refuse explicitement tout accès sans secret valide (403) ou non authentifié (401).
 */
function allowSecretOrAuthenticatedUser(req, res, next) {
  const secretCandidate = req.get('x-admin-secret') || req.query.secret || req.query.key || req.query.token;
  if (ENV.ADMIN_SECRET && secretMatches(secretCandidate, ENV.ADMIN_SECRET)) {
    return next();
  }

  const authorization = req.get('authorization') || '';
  if (authorization.startsWith('Bearer ')) {
    return requireAuthenticatedUser(req, res, next);
  }

  // Refus strict si tentative avec un mauvais secret
  if (secretCandidate) {
    return res.status(403).json({ success: false, message: 'Secret administrateur invalide.' });
  }

  // Refus strict de tout accès anonyme (R3)
  return res.status(401).json({
    success: false,
    message: 'Authentification requise : fournissez x-admin-secret ou un jeton Bearer valide.',
  });
}

async function requireAuthenticatedUser(req, res, next) {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentification requise.' });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return res.status(503).json({ success: false, message: 'Authentification indisponible.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ success: false, message: 'Session invalide ou expirée.' });
  }

  req.user = data.user;
  next();
}

/**
 * Exige un utilisateur authentifié ET administrateur, en lisant son rôle en
 * base. À utiliser pour les actions d'administration déclenchées depuis un
 * navigateur, qui ne peut pas détenir ADMIN_SECRET. Le secret reste accepté
 * pour les appels serveur-à-serveur et les scripts.
 */
async function requireAdminUser(req, res, next) {
  if (ENV.ADMIN_SECRET && secretMatches(req.get('x-admin-secret'), ENV.ADMIN_SECRET)) {
    return next();
  }
  return requireAuthenticatedUser(req, res, async () => {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return res.status(503).json({ success: false, message: 'Vérification indisponible.' });
    }
    const { data } = await supabase
      .from('users')
      .select('role')
      .eq('id', req.user.id)
      .maybeSingle();
    const role = String(data?.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'superadmin') {
      return res.status(403).json({ success: false, message: "Action réservée à l'administration." });
    }
    next();
  });
}

function requireWebhookSecret(secret, headerName) {
  return (req, res, next) => {
    if (!secret) {
      return res.status(503).json({ success: false, message: 'Webhook non configuré.' });
    }
    // L'en-tête est le canal privilégié ; req.query.secret reste accepté en
    // repli le temps que le prestataire soit reconfiguré (voir F16).
    const candidate = req.get(headerName) || req.query.secret;
    if (!secretMatches(candidate, secret)) {
      return res.status(403).json({ success: false, message: 'Signature webhook invalide.' });
    }
    next();
  };
}

module.exports = {
  requireAdminSecret,
  allowSecretOrAuthenticatedUser,
  requireAuthenticatedUser,
  requireAdminUser,
  requireWebhookSecret,
};
