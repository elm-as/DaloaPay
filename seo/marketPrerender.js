/**
 * Server-Side Prerender for DaloaMarket (Categories, Listings & Seller Shops)
 */

const { escapeHtml, getCachedHtml, setCachedHtml } = require('./botDetector');

const CATEGORY_MAP = {
  'electronique': { id: 'electronics', label: 'Électronique & High-tech', desc: 'Achetez et vendez des téléphones, ordinateurs, téléviseurs et accessoires high-tech à Daloa.' },
  'electronics': { id: 'electronics', label: 'Électronique & High-tech', desc: 'Achetez et vendez des téléphones, ordinateurs, téléviseurs et accessoires high-tech à Daloa.' },
  'vehicules': { id: 'vehicles', label: 'Auto & Moto', desc: 'Voitures, motos, pièces détachées et accessoires auto/moto à vendre à Daloa.' },
  'vehicles': { id: 'vehicles', label: 'Auto & Moto', desc: 'Voitures, motos, pièces détachées et accessoires auto/moto à vendre à Daloa.' },
  'mode': { id: 'fashion', label: 'Mode & Accessoires', desc: 'Vêtements, chaussures, sacs, bijoux et accessoires de mode à Daloa.' },
  'fashion': { id: 'fashion', label: 'Mode & Accessoires', desc: 'Vêtements, chaussures, sacs, bijoux et accessoires de mode à Daloa.' },
  'maison-deco': { id: 'home', label: 'Maison & Jardin', desc: 'Meubles, électroménager, décoration et articles de maison à Daloa.' },
  'home': { id: 'home', label: 'Maison & Jardin', desc: 'Meubles, électroménager, décoration et articles de maison à Daloa.' },
  'sports-loisirs': { id: 'sports', label: 'Sports & Loisirs', desc: 'Équipements sportifs, vélos, jeux et articles de loisirs à Daloa.' },
  'sports': { id: 'sports', label: 'Sports & Loisirs', desc: 'Équipements sportifs, vélos, jeux et articles de loisirs à Daloa.' },
  'livres': { id: 'books', label: 'Livres & Culture', desc: 'Livres scolaires, romans, fournitures et matériel culturel à Daloa.' },
  'books': { id: 'books', label: 'Livres & Culture', desc: 'Livres scolaires, romans, fournitures et matériel culturel à Daloa.' },
  'alimentaire': { id: 'food', label: 'Alimentaire & Produits locaux', desc: 'Produits vivriers, épicerie et spécialités locales à Daloa.' },
  'food': { id: 'food', label: 'Alimentaire & Produits locaux', desc: 'Produits vivriers, épicerie et spécialités locales à Daloa.' },
};

/**
 * Builds HTML document with dynamic meta tags & static content fallback.
 */
function buildHtml({ title, description, keywords, ogImage, canonical, bodyContent, jsonLd }) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeKeywords = escapeHtml(keywords || 'DaloaMarket, annonces Daloa, Côte d\'Ivoire');
  const safeImage = escapeHtml(ogImage || 'https://daloamarket.shop/og-image.png');
  const safeCanonical = escapeHtml(canonical || 'https://daloamarket.shop');

  // JSON.stringify n'échappe ni `<` ni `/` : une valeur contenant `</script>`
  // sortirait du bloc et permettrait une injection. On neutralise `<`.
  const jsonLdScript = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle} | DaloaMarket</title>
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
  <meta property="og:site_name" content="DaloaMarket">
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
 * Renders HTML for category pages.
 */
async function renderCategoryPage(supabase, slug) {
  const cacheKey = `cat_${slug}`;
  const cached = getCachedHtml(cacheKey);
  if (cached) return cached;

  const config = CATEGORY_MAP[slug.toLowerCase()] || {
    id: slug,
    label: slug.charAt(0).toUpperCase() + slug.slice(1),
    desc: `Découvrez les annonces de ${slug} à Daloa sur DaloaMarket.`
  };

  const { data: listings } = await supabase
    .from('listings')
    .select('id, title, price, photos, district, created_at')
    .eq('status', 'active')
    .eq('category', config.id)
    .order('created_at', { ascending: false })
    .limit(12);

  const safeLabel = escapeHtml(config.label);
  const items = listings || [];
  
  let listHtml = `<h1>Annonces ${safeLabel} à Daloa</h1><p>${escapeHtml(config.desc)}</p><ul>`;
  items.forEach(item => {
    const photo = item.photos?.[0] ? `<img src="${escapeHtml(item.photos[0])}" alt="${escapeHtml(item.title)}" width="150" />` : '';
    listHtml += `<li><h3>${escapeHtml(item.title)}</h3><p>Prix: ${item.price} FCFA — ${escapeHtml(item.district || 'Daloa')}</p>${photo}</li>`;
  });
  listHtml += '</ul>';

  const html = buildHtml({
    title: `${config.label} à Daloa`,
    description: config.desc,
    keywords: `${config.label}, annonces Daloa, acheter ${config.label} Côte d'Ivoire`,
    ogImage: items[0]?.photos?.[0] || 'https://daloamarket.shop/og-image.png',
    canonical: `https://daloamarket.shop/c/${slug}`,
    bodyContent: listHtml,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${config.label} à Daloa | DaloaMarket`,
      description: config.desc,
      url: `https://daloamarket.shop/c/${slug}`
    }
  });

  setCachedHtml(cacheKey, html);
  return html;
}

module.exports = {
  renderCategoryPage,
};
