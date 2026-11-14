const express = require('express');
const { getSupabaseAdminClient } = require('../config/env');
const { requireAdminUser } = require('../middlewares/auth');

const router = express.Router();

/**
 * GET /admin/orders
 * Retourne toutes les commandes, courses, acteurs et indicateurs KPI pour la
 * console d'administration en utilisant le client service_role (contourne
 * l'absence de politique SELECT admin sur public.orders).
 */
router.get('/admin/orders', requireAdminUser, async (_req, res) => {
  try {
    const supabase = getSupabaseAdminClient();
    if (!supabase) {
      return res.status(503).json({ success: false, message: 'Client Supabase indisponible.' });
    }

    const [assignmentsRes, ordersRes, payoutsRes, usersCountRes, listingsCountRes] = await Promise.all([
      supabase
        .from('delivery_assignments')
        .select('*, delivery_person:delivery_persons(*)')
        .order('created_at', { ascending: false }),
      supabase
        .from('orders')
        .select(
          'id, status, product_amount, delivery_fee, total_amount, delivery_mode, payment_method, delivery_address, buyer_id, seller_id, listing_id, created_at, listing:listings(id, title, photos)'
        )
        .order('created_at', { ascending: false })
        .limit(300),
      supabase.from('payouts').select('*').eq('type', 'delivery'),
      supabase.from('users').select('id', { count: 'exact', head: true }),
      supabase.from('listings').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    ]);

    if (assignmentsRes.error) throw assignmentsRes.error;
    if (ordersRes.error) throw ordersRes.error;

    const rawAssignments = assignmentsRes.data || [];
    const orders = ordersRes.data || [];
    const rawPayouts = payoutsRes.data || [];

    const orderMap = new Map(orders.map((o) => [o.id, o]));

    const driverUserIds = rawAssignments.map((a) => a.delivery_person?.user_id).filter(Boolean);
    const assignmentSellerIds = rawAssignments.map((a) => a.seller_id).filter(Boolean);
    const orderUserIds = orders.flatMap((o) => [o.buyer_id, o.seller_id]).filter(Boolean);
    const mediatorUserIds = rawAssignments.map((a) => a.resolved_by).filter(Boolean);
    const allUserIds = [...new Set([...orderUserIds, ...assignmentSellerIds, ...driverUserIds, ...mediatorUserIds])];

    let userMap = new Map();
    if (allUserIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, phone')
        .in('id', allUserIds);
      userMap = new Map((users || []).map((u) => [u.id, u]));
    }

    const payoutByAssignmentId = new Map();
    rawPayouts.forEach((p) => {
      if (p.delivery_assignment_id) {
        payoutByAssignmentId.set(p.delivery_assignment_id, p);
      }
    });

    const assignedOrderIds = new Set();
    const mergedFromAssignments = rawAssignments.map((a) => {
      if (a.order_id) assignedOrderIds.add(a.order_id);
      const order = orderMap.get(a.order_id) || null;
      const dp = a.delivery_person || null;
      const driverName = dp?.name || (dp?.user_id ? userMap.get(dp.user_id)?.full_name : null) || 'Inconnu';
      const driverPhone = dp?.phone || (dp?.user_id ? userMap.get(dp.user_id)?.phone : null) || null;

      return {
        ...a,
        delivery_person: dp ? { ...dp, name: driverName, phone: driverPhone } : null,
        mediator: a.resolved_by ? userMap.get(a.resolved_by) || null : null,
        driver_payout: payoutByAssignmentId.get(a.id) || null,
        order: order
          ? {
              ...order,
              buyer: userMap.get(order.buyer_id) || null,
              seller: userMap.get(order.seller_id) || (a.seller_id ? userMap.get(a.seller_id) : null) || null,
            }
          : null,
      };
    });

    const orderOnlyItems = orders
      .filter((o) => !assignedOrderIds.has(o.id))
      .map((o) => ({
        id: o.id,
        order_id: o.id,
        is_order_only: true,
        delivery_person_id: null,
        status: o.status,
        created_at: o.created_at,
        delivery_price: o.delivery_fee,
        dropoff_location: o.delivery_address,
        order: {
          ...o,
          buyer: userMap.get(o.buyer_id) || null,
          seller: userMap.get(o.seller_id) || null,
        },
      }));

    const combined = [...mergedFromAssignments, ...orderOnlyItems].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const photoUrls = {};
    for (const item of mergedFromAssignments) {
      if (item.delivery_photo_url) {
        try {
          const marker = '/storage/v1/object/public/delivery-photos/';
          const idx = item.delivery_photo_url.indexOf(marker);
          if (idx !== -1) {
            const path = item.delivery_photo_url.substring(idx + marker.length).split('#')[0].split('?')[0];
            const { data: signData } = await supabase.storage.from('delivery-photos').createSignedUrl(path, 3600);
            if (signData?.signedUrl) {
              photoUrls[item.id] = signData.signedUrl;
            }
          }
        } catch {
          // Photo absente ignorée
        }
      }
    }

    const activeStatuses = ['pending', 'paid', 'funded', 'confirmed', 'in_transit'];
    const validRevenueStatuses = ['paid', 'funded', 'confirmed', 'in_transit', 'delivered', 'completed'];

    const activeOrdersCount = orders.filter((o) => activeStatuses.includes(o.status)).length;
    const gmvTotal = orders
      .filter((o) => validRevenueStatuses.includes(o.status))
      .reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0);

    return res.json({
      success: true,
      deliveries: combined,
      photoUrls,
      kpis: {
        users: usersCountRes.count || 0,
        listings: listingsCountRes.count || 0,
        orders: orders.length,
        activeOrders: activeOrdersCount,
        gmvTotal,
        recentOrders: orders.slice(0, 6),
      },
    });
  } catch (err) {
    console.error('[GET /admin/orders Error]:', err);
    return res.status(500).json({ success: false, message: err.message || 'Erreur serveur' });
  }
});

/**
 * POST /admin/orders/cancel
 * Annule une commande et sa course associée avec les droits administrateur.
 */
router.post('/admin/orders/cancel', requireAdminUser, async (req, res) => {
  try {
    const supabase = getSupabaseAdminClient();
    const { orderId, assignmentId } = req.body || {};

    if (!orderId && !assignmentId) {
      return res.status(400).json({ success: false, message: 'Identifiant de commande requis.' });
    }

    if (orderId) {
      const { error: ordErr } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', orderId);
      if (ordErr) throw ordErr;
    }

    if (assignmentId && assignmentId !== orderId) {
      const { error: assErr } = await supabase
        .from('delivery_assignments')
        .update({ status: 'cancelled' })
        .eq('id', assignmentId);
      if (assErr) throw assErr;
    } else if (orderId) {
      await supabase
        .from('delivery_assignments')
        .update({ status: 'cancelled' })
        .eq('order_id', orderId);
    }

    return res.json({ success: true, message: 'Commande annulée avec succès.' });
  } catch (err) {
    console.error('[POST /admin/orders/cancel Error]:', err);
    return res.status(500).json({ success: false, message: err.message || 'Impossible d’annuler la commande.' });
  }
});

module.exports = router;
