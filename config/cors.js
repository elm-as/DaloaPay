const cors = require('cors');

const DEFAULT_ALLOWED = [
  'https://daloamarket.com',
  'https://www.daloamarket.com',
  'https://delivery.daloamarket.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://localhost:8081',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

const customOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOriginsList = [...new Set([...DEFAULT_ALLOWED, ...customOrigins])];

const isOriginAllowed = (origin) => {
  // Pas d'origine = webhooks MoneyFusion / appels serveur-à-serveur
  if (!origin) return true;
  if (allowedOriginsList.includes(origin)) return true;
  // Déploiements preview Netlify
  if (/^https:\/\/([a-z0-9-]+--)?daloamarket.*\.netlify\.app$/i.test(origin)) return true;
  // Localhost sur tout port de développement
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
};

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS] Origine bloquée : ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret', 'X-Requested-With', 'Accept'],
  optionsSuccessStatus: 204,
};

module.exports = {
  corsMiddleware: cors(corsOptions),
  corsOptions,
};
