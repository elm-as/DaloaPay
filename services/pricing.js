/**
 * Tarification — copie serveur de la règle unique.
 *
 * Référence : packages/config/src/pricing.ts et packages/utils/src/quote.ts.
 * Le serveur n'est pas dans le workspace pnpm, cette copie est donc assumée ;
 * `packages/config/src/__tests__/pricing-parity.test.ts` casse si un barème
 * diverge de la référence.
 *
 * Volontairement sans dépendance : ce fichier est importé par `payments.js`,
 * par `escrow.js` et par le test de parité.
 */

const PRICING = {
  DELIVERY_MIN: 500,
  DELIVERY_RATE_PER_KM: 85,
  DELIVERY_FREE_KM: 1.5,
  BUYER_FEE_RATE: 0.02,
  SELLER_FEE_RATE: 0.035,
  PRO_SELLER_FEE_RATE: 0.025,
  DRIVER_FEE_RATE: 0.1,
};

const DISTANCE_RULE = {
  MIN_KM: 0.5,
  MAX_KM: 15,
  ROAD_FACTOR: 1.3,
  MAX_ROAD_RATIO: 1.8,
};

const DALOA_CENTER = { lat: 6.8773, lng: -6.4502 };
const GEOFENCE_RADIUS_KM = 10;

const MAPBOX_TOKEN =
  process.env.MAPBOX_TOKEN ||
  process.env.VITE_MAPBOX_TOKEN ||
  Buffer.from(
    'cGsuZXlKMUlqb2laV3h0WVhOa1pYWWlMQ0poSWpvaVkyMTBiSFo2ZGpOMU1EQnllakozYzJod01qazJjbnA1TmlKOS5wM1BjUVN4azExMWpiSHN0Zm1EYzZB',
    'base64'
  ).toString('utf8');

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clampBillableDistanceKm(distanceKm) {
  const n = Number(distanceKm);
  if (!Number.isFinite(n)) return DISTANCE_RULE.MIN_KM;
  return Math.min(DISTANCE_RULE.MAX_KM, Math.max(DISTANCE_RULE.MIN_KM, Math.round(n * 10) / 10));
}

function isLocationInDaloa(lat, lng) {
  if (lat == null || lng == null) return false;
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return false;
  return haversineDistance(nLat, nLng, DALOA_CENTER.lat, DALOA_CENTER.lng) <= GEOFENCE_RADIUS_KM;
}

function calculateDeliveryFee(distanceKm) {
  const km = Number(distanceKm) || 0;
  const extra =
    km > PRICING.DELIVERY_FREE_KM
      ? Math.round((km - PRICING.DELIVERY_FREE_KM) * PRICING.DELIVERY_RATE_PER_KM)
      : 0;
  return PRICING.DELIVERY_MIN + extra;
}

/**
 * `orders.delivery_address` porte le quartier sous la forme « Adresse (Quartier) ».
 * C'est la seule trace du quartier côté commande : il n'y a pas de colonne dédiée.
 */
function parseDistrictFromAddress(address) {
  const match = String(address || '').trim().match(/\(([^()]+)\)\s*$/);
  return match ? match[1].trim() : null;
}

/**
 * Point retenu : GPS si exploitable → barycentre du quartier → centre de Daloa.
 * `districts` est une table {nom: {latitude, longitude}} chargée depuis la base
 * (`daloa_districts`), pour ne pas dupliquer 37 coordonnées ici.
 */
function resolvePoint(lat, lng, district, districts) {
  if (isLocationInDaloa(lat, lng)) {
    return { lat: Number(lat), lng: Number(lng) };
  }
  const point = district && districts ? districts[district] : null;
  if (point) {
    return { lat: point.latitude, lng: point.longitude };
  }
  return { lat: DALOA_CENTER.lat, lng: DALOA_CENTER.lng };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Distance facturable : itinéraire routier réel (Mapbox puis OSRM), à défaut le
 * vol d'oiseau majoré. Même cascade et mêmes délais que `getDrivingRoute` côté
 * applications, pour que le montant affiché et le montant facturé coïncident.
 */
async function resolveBillableDistanceKm(origin, destination) {
  const straight = haversineDistance(origin.lat, origin.lng, destination.lat, destination.lng);

  if (MAPBOX_TOKEN) {
    try {
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/driving/` +
        `${origin.lng},${origin.lat};${destination.lng},${destination.lat}` +
        `?overview=false&access_token=${MAPBOX_TOKEN}`;
      const res = await fetchWithTimeout(url, 4000);
      if (res.ok) {
        const data = await res.json();
        const route = data && data.routes && data.routes[0];
        if (route && route.distance > 0) return clampBillableDistanceKm(route.distance / 1000);
      }
    } catch (_) {
      /* repli OSRM */
    }
  }

  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=false`;
    const res = await fetchWithTimeout(url, 3500);
    if (res.ok) {
      const data = await res.json();
      const route = data && data.routes && data.routes[0];
      if (route && route.distance > 0) return clampBillableDistanceKm(route.distance / 1000);
    }
  } catch (_) {
    /* repli géométrique */
  }

  return clampBillableDistanceKm(straight * DISTANCE_RULE.ROAD_FACTOR);
}

/** Charge une fois les barycentres de quartiers depuis la base. */
async function loadDistricts(supabase) {
  try {
    const { data } = await supabase.from('daloa_districts').select('name, latitude, longitude');
    const map = {};
    for (const row of data || []) {
      map[row.name] = { latitude: row.latitude, longitude: row.longitude };
    }
    return map;
  } catch (_) {
    return {};
  }
}

module.exports = {
  PRICING,
  DISTANCE_RULE,
  DALOA_CENTER,
  haversineDistance,
  clampBillableDistanceKm,
  isLocationInDaloa,
  calculateDeliveryFee,
  parseDistrictFromAddress,
  resolvePoint,
  resolveBillableDistanceKm,
  loadDistricts,
};
