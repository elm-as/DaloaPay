const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const ENV = {
  FUSION_API_URL: process.env.FUSION_API_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SITE_URL: process.env.SITE_URL || 'https://daloamarket.com',
  PUBLIC_API_URL: (process.env.PUBLIC_API_URL || 'https://api.daloamarket.com').replace(/\/$/, ''),
  ADMIN_SECRET: process.env.ADMIN_SECRET || '',
  PUSH_WEBHOOK_SECRET: process.env.PUSH_WEBHOOK_SECRET || '',
  PAYOUT_WEBHOOK_SECRET: process.env.PAYOUT_WEBHOOK_SECRET || '',
  MONEYFUSION_PRIVATE_KEY: process.env.MONEYFUSION_PRIVATE_KEY || '',
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:contact@daloamarket.com',
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
};

function getSupabaseAdminClient() {
  if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function checkConfig() {
  if (!ENV.FUSION_API_URL || !ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Config incomplete: FUSION_API_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required');
  }
}

/** Comparaison en temps constant, pour ne pas fuir le secret par timing. */
function secretMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  ENV,
  getSupabaseAdminClient,
  checkConfig,
  secretMatches,
};
