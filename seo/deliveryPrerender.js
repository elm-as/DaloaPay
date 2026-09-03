/**
 * Server-Side Prerender for DaloaDelivery (Driver Profiles & Directory)
 */

const { escapeHtml, getCachedHtml, setCachedHtml } = require('./botDetector');

/**
 * Builds HTML document for DaloaDelivery bot requests.
 */
function buildDeliveryHtml({ title, description, keywords, ogImage, canonical, bodyContent, jsonLd }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeKeywords = escapeHtml(keywords || 'DaloaDelivery, livreur Daloa, coursier moto Côte d\'Ivoire');
  const safeImage = escapeHtml(ogImage || 'https://daloa-delivery.shop/og-image.png');
  const safeCanonical = escapeHtml(canonical || 'https://daloa-delivery.shop');

  // JSON.stringify n'échappe ni `<` ni `/` : une valeur contenant `</script>`
  // sortirait du bloc et permettrait une injection. On neutralise `<`.
  const jsonLdScript = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} | DaloaDelivery</title>
  <meta name="description" content="${safeDesc}">
  <meta name="keywords" content="${safeKeywords}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${safeCanonical}">
  
  <meta property="og:type" content="website">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDesc}">
  <meta property="og:image" content="${safeImage}">
  <meta property="og:image:secure_url" content="${safeImage}">
  <meta property="og:url" content="${safeCanonical}">
  <meta property="og:site_name" content="DaloaDelivery">
  <meta property="og:locale" content="fr_CI">
  
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image" content="${safeImage}">
  ${jsonLdScript}
</head>
<body>
  <div id="root">
    <div id="seo-fallback" style="padding:20px; font-family:sans-serif;">
      ${bodyContent}
    </div>
  </div>
</body>
</html>`;
}

/**
 * Renders HTML for a driver profile (/livreur/:id).
 */
async function renderDriverProfile(supabase, driverId) {
  const cacheKey = `driver_${driverId}`;
  const cached = getCachedHtml(cacheKey);
  if (cached) return cached;

  const { data: driver } = await supabase
    .from('delivery_persons_directory')
    .select('*')
    .eq('id', driverId)
    .maybeSingle();

  if (!driver) {
    return buildDeliveryHtml({
      title: 'Livreur non trouvé',
      description: 'Ce profil de livreur n\'existe pas ou n\'est plus disponible.',
      canonical: `https://daloa-delivery.shop/livreur/${driverId}`,
      bodyContent: '<h1>Livreur non trouvé</h1><p>Le profil demandé n\'est pas disponible.</p>'
    });
  }

  const name = escapeHtml(driver.name || 'Livreur Daloa');
  const vehicle = escapeHtml(driver.vehicle_type || 'Moto');
  const desc = escapeHtml(driver.description || `Livreur professionnel (${vehicle}) disponible à Daloa.`);
  const rating = driver.rating ? driver.rating.toFixed(1) : '5.0';
  const avatar = driver.avatar_url || 'https://daloa-delivery.shop/og-image.png';

  const bodyContent = `
    <h1>${name} — Livreur ${vehicle} à Daloa</h1>
    <p><strong>Note :</strong> ⭐ ${rating} / 5 (${driver.total_reviews || 0} avis)</p>
    <p><strong>Véhicule :</strong> ${vehicle}</p>
    <p><strong>Zones couvertes :</strong> ${escapeHtml((driver.coverage_zones || []).join(', ') || 'Daloa')}</p>
    <p><strong>Description :</strong> ${desc}</p>
  `;

  const html = buildDeliveryHtml({
    title: `${driver.name || 'Livreur'} (${vehicle}) à Daloa`,
    description: `${driver.name} est livreur en ${vehicle} à Daloa. ⭐ Note: ${rating}/5. ${desc}`,
    keywords: `${driver.name}, livreur ${vehicle} Daloa, coursier Daloa, livraison Daloa`,
    ogImage: avatar,
    canonical: `https://daloa-delivery.shop/livreur/${driver.id}`,
    bodyContent,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: driver.name,
      description: desc,
      url: `https://daloa-delivery.shop/livreur/${driver.id}`,
      image: avatar,
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Daloa',
        addressRegion: 'Haut-Sassandra',
        addressCountry: 'CI'
      },
      aggregateRating: driver.rating ? {
        '@type': 'AggregateRating',
        ratingValue: driver.rating,
        reviewCount: driver.total_reviews || 1
      } : undefined
    }
  });

  setCachedHtml(cacheKey, html);
  return html;
}

module.exports = {
  renderDriverProfile,
};
