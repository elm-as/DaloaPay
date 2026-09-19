const express = require('express');
const router = express.Router();
const { requireAdminSecret } = require('../middlewares/auth');

// WhatsApp Channel Broadcast Endpoint (Levier A & Diffusion automatique)
router.post('/api/channel/broadcast-listing', requireAdminSecret, async (req, res) => {
  try {
    const { title, price, district, id, shop_name } = req.body;
    if (!title || !price || !id) {
      return res.status(400).json({ error: 'Missing required listing details (title, price, id)' });
    }

    const listingUrl = `https://daloamarket.com/item/${id}`;
    const formattedPrice = Number(price).toLocaleString('fr-FR') + ' FCFA';

    const message = `🛍️ NOUVEL ARRIVAGE SUR DALOA MARKET !

📦 *${title}*
💰 Prix : *${formattedPrice}*
📍 Quartier : ${district || 'Daloa'}
${shop_name ? `👤 Vendeur : ${shop_name}\n` : ''}
👉 Voir l'article et commander en toute sécurité :
${listingUrl}

🛵 Livraison express partout à Daloa avec DaloaDelivery !`;

    console.log('[WhatsApp Channel Broadcast Generated]:\n', message);

    return res.json({
      success: true,
      channelUrl: 'https://whatsapp.com/channel/0029Vb94o2vJENy5kkADR42U',
      message,
      listingUrl,
    });
  } catch (err) {
    console.error('[Broadcast Listing Exception]:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
