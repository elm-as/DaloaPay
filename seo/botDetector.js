/**
 * SEO Bot Detector & Cache Manager
 * DaloaMarket & DaloaDelivery
 */

const BOT_USER_AGENTS = [
  'googlebot',
  'bingbot',
  'yandexbot',
  'duckduckbot',
  'slurp',
  'baiduspider',
  'facebookexternalhit',
  'twitterbot',
  'whatsapp',
  'slackbot',
  'linkedinbot',
  'telegrambot',
  'discordbot',
  'applebot',
  'perplexitybot',
  'gptbot',
  'claudebot',
  'anthropic-ai',
];

// In-memory cache with 5-minute TTL (300,000 ms)
const htmlCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Checks if the request comes from a search engine crawler or social media bot.
 * @param {string} userAgent 
 * @returns {boolean}
 */
function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some(bot => ua.includes(bot));
}

/**
 * Basic HTML escaping to prevent XSS injection in generated meta tags or fallback HTML.
 * @param {string} str 
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Gets cached HTML response if available and not expired.
 * @param {string} key 
 * @returns {string|null}
 */
function getCachedHtml(key) {
  const cached = htmlCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    htmlCache.delete(key);
    return null;
  }

  return cached.html;
}

/**
 * Saves HTML response into in-memory TTL cache.
 * @param {string} key 
 * @param {string} html 
 */
function setCachedHtml(key, html) {
  // Simple eviction if cache exceeds 500 entries
  if (htmlCache.size > 500) {
    const oldestKey = htmlCache.keys().next().value;
    htmlCache.delete(oldestKey);
  }

  htmlCache.set(key, {
    html,
    timestamp: Date.now(),
  });
}

module.exports = {
  isBot,
  escapeHtml,
  getCachedHtml,
  setCachedHtml,
};
