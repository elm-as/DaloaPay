const VALIDATED_REVENUE_STATUSES = new Set([
  'paid',
  'funded',
  'confirmed',
  'in_transit',
  'delivered',
  'completed',
]);

const COMPLETED_ORDER_STATUSES = new Set(['delivered', 'completed']);

const PAYMENT_METHOD_LABELS = {
  online: 'Mobile Money en ligne',
  mobile_money: 'Mobile Money en ligne',
  cod: 'Paiement à la livraison (COD)',
  cash: 'Paiement à la livraison (COD)',
  cash_at_shop: 'Retrait en boutique (Espèces)',
};

const ORDER_STATUS_LABELS = {
  pending: 'En attente',
  paid: 'Payée',
  funded: 'Financée',
  confirmed: 'Confirmée',
  in_transit: 'En livraison',
  delivered: 'Livrée',
  completed: 'Terminée',
  cancelled: 'Annulée',
  disputed: 'Litige',
};

/**
 * Normalise la fenêtre temporelle d'analyse demandée (7, 14, 30 ou 90 jours).
 * @param {unknown} rawDays Paramètre brut de requête
 * @returns {number} Nombre de jours autorisé
 */
function normalizeAnalyticsDays(rawDays) {
  const num = Number(rawDays);
  if (num === 7 || num === 14 || num === 30 || num === 90) return num;
  return 30;
}

function toIsoDayKey(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function formatDayShortLabel(isoDay) {
  const [, month, day] = isoDay.split('-');
  return `${day}/${month}`;
}

function computeDeltaPercent(current, previous) {
  if (!previous && !current) return 0;
  if (!previous) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

function createEmptyDayBuckets(days, nowMs) {
  const map = new Map();
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayDate = new Date(nowMs - offset * 86_400_000);
    const key = dayDate.toISOString().slice(0, 10);
    const bucket = {
      date: key,
      label: formatDayShortLabel(key),
      gmv: 0,
      commissions: 0,
      ordersCount: 0,
      newUsers: 0,
      newListings: 0,
    };
    map.set(key, bucket);
    list.push(bucket);
  }
  return { map, list };
}

function countByKey(items, resolveKey) {
  const counts = new Map();
  for (const item of items) {
    const key = resolveKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => b.count - a.count);
}

function buildPaymentBreakdown(orders) {
  const buckets = new Map();
  for (const order of orders) {
    const raw = String(order.payment_method || 'online').toLowerCase();
    const key =
      raw === 'cash_at_shop'
        ? 'cash_at_shop'
        : raw === 'cod' || raw === 'cash'
          ? 'cod'
          : 'online';
    const cur = buckets.get(key) || {
      key,
      label: PAYMENT_METHOD_LABELS[key],
      count: 0,
      amount: 0,
    };
    cur.count += 1;
    if (VALIDATED_REVENUE_STATUSES.has(order.status)) {
      cur.amount += Number(order.total_amount) || 0;
    }
    buckets.set(key, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

function buildDeliveryModeBreakdown(orders) {
  const counts = { delivery: 0, pickup_point: 0 };
  for (const order of orders) {
    const isPickup = order.delivery_mode === 'pickup' || order.delivery_mode === 'pickup_point';
    if (isPickup) counts.pickup_point += 1;
    else counts.delivery += 1;
  }
  return [
    { key: 'delivery', label: 'Livraison à domicile', count: counts.delivery },
    { key: 'pickup_point', label: 'Retrait en boutique', count: counts.pickup_point },
  ];
}

function buildOrderStatusBreakdown(orders) {
  return countByKey(orders, (o) => o.status).map((row) => ({
    key: row.key,
    label: ORDER_STATUS_LABELS[row.key] || row.key,
    count: row.count,
  }));
}

/**
 * Calcule les indicateurs analytiques complets sur la période demandée à partir
 * des enregistrements bruts Supabase (fonction pure).
 * @param {object} rawData Collections extraites en base
 * @param {number} days Fenêtre temporelle (`7 | 14 | 30 | 90`)
 * @param {number} [nowMs] Horodatage courant en ms
 * @returns {object} Instantané analytique prêt pour l'UI admin
 */
function buildAdminAnalyticsSnapshot(rawData, days, nowMs = Date.now()) {
  const currentStartMs = nowMs - days * 86_400_000;
  const { map: dayMap, list: dailySeries } = createEmptyDayBuckets(days, nowMs);

  const currentOrders = [];
  const previousOrders = [];
  for (const order of rawData.orders || []) {
    const ts = new Date(order.created_at).getTime();
    if (ts >= currentStartMs) {
      currentOrders.push(order);
      const dayKey = toIsoDayKey(order.created_at);
      const bucket = dayKey && dayMap.get(dayKey);
      if (bucket) {
        bucket.ordersCount += 1;
        if (VALIDATED_REVENUE_STATUSES.has(order.status)) {
          bucket.gmv += Number(order.total_amount) || 0;
          bucket.commissions += Number(order.platform_commission) || 0;
        }
      }
    } else {
      previousOrders.push(order);
    }
  }

  let newUsersCurrent = 0;
  let newUsersPrevious = 0;
  for (const user of rawData.users || []) {
    const ts = new Date(user.created_at).getTime();
    if (ts >= currentStartMs) {
      newUsersCurrent += 1;
      const bucket = dayMap.get(toIsoDayKey(user.created_at));
      if (bucket) bucket.newUsers += 1;
    } else {
      newUsersPrevious += 1;
    }
  }
  const activeProUsers = rawData.activeProUsersCount || 0;

  let newListingsCurrent = 0;
  let newListingsPrevious = 0;
  const activeListings = [];
  for (const listing of rawData.listings || []) {
    if (listing.status === 'active') activeListings.push(listing);
    const ts = new Date(listing.created_at).getTime();
    if (ts >= currentStartMs) {
      newListingsCurrent += 1;
      const bucket = dayMap.get(toIsoDayKey(listing.created_at));
      if (bucket) bucket.newListings += 1;
    } else {
      newListingsPrevious += 1;
    }
  }

  const validCurrent = currentOrders.filter((o) => VALIDATED_REVENUE_STATUSES.has(o.status));
  const validPrevious = previousOrders.filter((o) => VALIDATED_REVENUE_STATUSES.has(o.status));
  const gmvCurrent = validCurrent.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
  const gmvPrevious = validPrevious.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);
  const commissionsCurrent = validCurrent.reduce((sum, o) => sum + (Number(o.platform_commission) || 0), 0);

  const completedCount = currentOrders.filter((o) => COMPLETED_ORDER_STATUSES.has(o.status)).length;
  const cancelledCount = currentOrders.filter((o) => o.status === 'cancelled').length;

  const monetizationRevenue = (rawData.monetization || [])
    .filter((m) => m.status === 'confirmed' && new Date(m.created_at).getTime() >= currentStartMs)
    .reduce((sum, m) => sum + (Number(m.amount) || 0), 0);

  const pendingPayouts = (rawData.payouts || []).filter((p) => p.status === 'pending' || p.status === 'processing');
  const paidPayouts = (rawData.payouts || []).filter((p) => p.status === 'paid' || p.status === 'completed');

  return {
    periodDays: days,
    summary: {
      gmv: gmvCurrent,
      gmvDeltaPct: computeDeltaPercent(gmvCurrent, gmvPrevious),
      ordersCount: currentOrders.length,
      ordersDeltaPct: computeDeltaPercent(currentOrders.length, previousOrders.length),
      avgOrderValue: validCurrent.length > 0 ? Math.round(gmvCurrent / validCurrent.length) : 0,
      completionRatePct: currentOrders.length > 0 ? Math.round((completedCount / currentOrders.length) * 100) : 0,
      cancellationRatePct: currentOrders.length > 0 ? Math.round((cancelledCount / currentOrders.length) * 100) : 0,
      newUsersCount: newUsersCurrent,
      newUsersDeltaPct: computeDeltaPercent(newUsersCurrent, newUsersPrevious),
      totalUsersCount: rawData.totalUsersCount || 0,
      activeProUsers,
      newListingsCount: newListingsCurrent,
      newListingsDeltaPct: computeDeltaPercent(newListingsCurrent, newListingsPrevious),
      activeListingsCount: rawData.activeListingsCount || activeListings.length,
      verifiedDriversCount: (rawData.drivers || []).filter((d) => d.is_verified).length,
      onlineDriversCount: (rawData.drivers || []).filter((d) => d.is_verified && d.is_available).length,
    },
    financials: {
      commissions: commissionsCurrent,
      monetizationRevenue,
      totalPlatformRevenue: commissionsCurrent + monetizationRevenue,
      pendingPayoutsAmount: pendingPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
      pendingPayoutsCount: pendingPayouts.length,
      paidPayoutsAmount: paidPayouts.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
    },
    dailySeries,
    breakdowns: {
      paymentMethods: buildPaymentBreakdown(currentOrders),
      deliveryModes: buildDeliveryModeBreakdown(currentOrders),
      orderStatuses: buildOrderStatusBreakdown(currentOrders),
      topCategories: countByKey(activeListings, (l) => String(l.category || '').trim()).slice(0, 6),
      topDistricts: countByKey(rawData.allUserDistricts || [], (u) => String(u.district || '').trim()).slice(0, 6),
    },
  };
}

/**
 * Charge les collections Supabase nécessaires et retourne l'instantané analytique admin.
 * @param {object} supabase Client Supabase service_role
 * @param {number} days Fenêtre temporelle (`7 | 14 | 30 | 90`)
 * @returns {Promise<object>} Données analytiques consolidées
 */
async function fetchAdminAnalytics(supabase, days) {
  const nowMs = Date.now();
  const compareSinceIso = new Date(nowMs - days * 2 * 86_400_000).toISOString();

  const [
    ordersRes,
    recentUsersRes,
    proAndDistrictUsersRes,
    totalUsersRes,
    recentListingsRes,
    activeListingsCountRes,
    monetizationRes,
    payoutsRes,
    driversRes,
  ] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total_amount, platform_commission, status, delivery_mode, payment_method, created_at')
      .gte('created_at', compareSinceIso)
      .order('created_at', { ascending: false })
      .limit(5000),
    supabase
      .from('users')
      .select('id, created_at, pro_until')
      .gte('created_at', compareSinceIso)
      .is('deleted_at', null)
      .limit(5000),
    supabase
      .from('users')
      .select('district, pro_until')
      .is('deleted_at', null)
      .limit(5000),
    supabase.from('users').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase
      .from('listings')
      .select('id, category, status, created_at')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(4000),
    supabase.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase
      .from('monetization_transactions')
      .select('amount, status, created_at')
      .gte('created_at', compareSinceIso)
      .limit(2000),
    supabase.from('payouts').select('amount, status').limit(3000),
    supabase.from('delivery_persons').select('is_verified, is_available').limit(500),
  ]);

  if (ordersRes.error) throw ordersRes.error;
  for (const res of [recentUsersRes, proAndDistrictUsersRes, recentListingsRes, monetizationRes, payoutsRes, driversRes]) {
    if (res.error) console.warn('[admin-analytics] Erreur partielle:', res.error.message);
  }

  const allUserProfiles = proAndDistrictUsersRes.data || [];
  const activeProUsersCount = allUserProfiles.filter(
    (u) => u.pro_until && new Date(u.pro_until).getTime() > nowMs
  ).length;

  return buildAdminAnalyticsSnapshot(
    {
      orders: ordersRes.data || [],
      users: recentUsersRes.data || [],
      totalUsersCount: totalUsersRes.count || 0,
      activeProUsersCount,
      allUserDistricts: allUserProfiles,
      listings: recentListingsRes.data || [],
      activeListingsCount: activeListingsCountRes.count || 0,
      monetization: monetizationRes.data || [],
      payouts: payoutsRes.data || [],
      drivers: driversRes.data || [],
    },
    days,
    nowMs
  );
}

module.exports = {
  normalizeAnalyticsDays,
  buildAdminAnalyticsSnapshot,
  fetchAdminAnalytics,
};
