const express = require('express');
const router = express.Router();
const { ENV } = require('../config/env');
const { requireAdminSecret } = require('../middlewares/auth');

router.get('/', (req, res) => {
  res.json({ ok: true, message: 'DaloaMarket Payment API' });
});

router.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

router.get('/ip', requireAdminSecret, async (req, res) => {
  if (ENV.NODE_ENV === 'production' && req.headers['x-admin-secret'] !== ENV.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès non autorisé en production.' });
  }
  try {
    const [v4, v6] = await Promise.allSettled([
      fetch('https://api.ipify.org?format=json').then((r) => r.json()).catch(() => ({ ip: 'injoignable (api.ipify.org)' })),
      fetch('https://api64.ipify.org?format=json').then((r) => r.json()).catch(() => ({ ip: 'N/A' })),
    ]);
    res.json({
      ipv4: v4.status === 'fulfilled' ? v4.value.ip : 'erreur',
      ipv6: v6.status === 'fulfilled' ? v6.value.ip : 'N/A',
    });
  } catch {
    res.json({ error: 'Impossible de récupérer l\'IP' });
  }
});

router.get('/config', requireAdminSecret, (req, res) => {
  if (ENV.NODE_ENV === 'production' && req.headers['x-admin-secret'] !== ENV.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Accès au diagnostic désactivé en production.' });
  }
  res.json({
    status: 'ok',
    FUSION_API_URL_SET: !!ENV.FUSION_API_URL,
    SUPABASE_URL_SET: !!ENV.SUPABASE_URL,
    SUPABASE_KEY_SET: !!ENV.SUPABASE_SERVICE_ROLE_KEY,
    SITE_URL: ENV.SITE_URL,
    PORT: ENV.PORT,
  });
});

router.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.daloamarket.app',
        sha256_cert_fingerprints: [
          'FD:F6:D6:35:F0:07:A7:23:CA:B3:B7:99:06:89:B5:D4:BD:EC:27:A4:D6:91:09:EE:0F:E3:47:4A:C4:9F:99:6E',
          '14:6D:E9:7D:0F:52:AB:E0:43:2D:A5:72:42:C6:8B:6C:54:3B:5A:61:94:E1:67:B2:7D:63:F6:4F:9C:20:C6:F0',
        ],
      },
    },
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.daloamarket.delivery',
        sha256_cert_fingerprints: [
          'D6:2E:BD:1F:D6:80:8C:DC:7B:7E:29:CF:82:67:D5:9B:B2:A5:CF:A4:05:8E:BD:D8:68:D8:FD:EF:C3:AF:3C:81',
          '14:6D:E9:7D:0F:52:AB:E0:43:2D:A5:72:42:C6:8B:6C:54:3B:5A:61:94:E1:67:B2:7D:63:F6:4F:9C:20:C6:F0',
        ],
      },
    },
  ]);
});

module.exports = router;
