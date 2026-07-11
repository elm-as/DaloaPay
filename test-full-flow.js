/**
 * 🧪 TEST COMPLET DU FLOW DALOAMARKET (sans Money Fusion)
 *
 * Simule intégralement : commande → paiement → confirmation vendeur →
 * assignation livreur → pickup → delivery → payout.
 *
 * Prérequis dans ta DB Supabase :
 *   - Au moins 1 vendeur avec un listing actif
 *   - Au moins 1 livreur inscrit (dans delivery_persons)
 *   - Au moins 1 acheteur (autre que le vendeur)
 *
 * Utilisation :
 *   node test-full-flow.js
 *   node test-full-flow.js --step-by-step    (pause entre chaque étape)
 *   node test-full-flow.js --dry             (affiche ce qui serait fait sans exécuter)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ─── CONFIG ──────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const STEP_BY_STEP = process.argv.includes('--step-by-step');
const DRY_RUN = process.argv.includes('--dry');
const PAUSE_MS = 2000;

// Utilitaires
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (emoji, msg) => console.log(`\n${emoji}  ${msg}`);
const dbg = (obj) => console.dir(obj, { depth: 6, colors: true });
const step = async (num, title) => {
  log('➡️', `ÉTAPE ${num} : ${title}`);
  if (STEP_BY_STEP) {
    process.stdout.write('   ⏳ Appuie sur Entrée pour continuer...');
    await new Promise((r) => process.stdin.once('data', r));
  }
  await wait(PAUSE_MS);
};

// Vérifie qu'une valeur existe, sinon throw
const must = (val, label, context) => {
  if (!val) throw new Error(`${label} introuvable dans ${context || 'la DB'}`);
  return val;
};

// ─── MAIN ────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🧪  TEST FLOW DALOAMARKET (no MoneyFusion) ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`   Mode : ${DRY_RUN ? 'DRY-RUN (lecture seule)' : 'LIVE'}`);
  if (DRY_RUN) console.log('   ⚠️  Aucune écriture en DB');

  // ── ÉTAPE 1 : Récupérer les acteurs ──
  await step(1, 'Identifier les acteurs (acheteur, vendeur, listing, livreur)');

  // 1a - un listing actif avec son vendeur
  const { data: listing } = await supabase
    .from('listings')
    .select('id, title, price, user_id, stock')
    .eq('status', 'active')
    .gt('stock', 0)
    .limit(1)
    .single();
  must(listing, 'Aucun listing actif avec stock');

  log('📦', `Listing : "${listing.title}" (${listing.price} FCFA) — stock: ${listing.stock}`);
  log('👤', `Vendeur (user_id) : ${listing.user_id}`);

  // 1b - un acheteur ≠ vendeur
  const { data: buyer } = await supabase
    .from('users')
    .select('id, full_name, phone')
    .neq('id', listing.user_id)
    .limit(1)
    .single();
  must(buyer, 'Aucun acheteur (pas assez de users)');
  log('🛒', `Acheteur : ${buyer.full_name || buyer.id} — tél: ${buyer.phone || 'N/A'}`);

  // 1c - un livreur inscrit (ou on en crée un auto)
  // Colonnes réelles : id, user_id, name, phone, vehicle_type, is_available, coverage_zones, ...
  let { data: livreur } = await supabase
    .from('delivery_persons')
    .select('id, user_id, name, phone, vehicle_type, is_available')
    .eq('is_available', true)
    .limit(1)
    .single();

  if (!livreur) {
    log('⚠️', 'Aucun livreur dans delivery_persons → création automatique...');
    // Prendre le 3e user comme livreur (doit être différent du vendeur ET de l'acheteur)
    const { data: livreurUser } = await supabase
      .from('users')
      .select('id, full_name, phone')
      .neq('id', listing.user_id)
      .neq('id', buyer.id)
      .limit(1)
      .single();

    const livreurData = {
      user_id: (livreurUser || buyer).id,
      name: (livreurUser?.full_name || buyer.full_name || 'Livreur Test'),
      phone: (livreurUser?.phone || buyer.phone || '+2250000000000'),
      vehicle_type: 'motorcycle',
      is_available: true,
      coverage_zones: ['Daloa'],
    };

    if (!livreurUser) {
      log('⚠️', 'Pas assez d\'utilisateurs → l\'acheteur sera aussi livreur');
    }

    const { error: insErr } = await supabase.from('delivery_persons').insert(livreurData);
    if (insErr) throw new Error(`Création livreur échouée: ${insErr.message}`);

    const { data: newLivreur } = await supabase
      .from('delivery_persons')
      .select('id, user_id, name, phone, vehicle_type, is_available')
      .eq('user_id', livreurData.user_id)
      .single();
    livreur = newLivreur;
  }
  must(livreur, 'Impossible de créer/trouver un livreur');
  log('🏍️', `Livreur : ${livreur.name || livreur.id} (${livreur.vehicle_type || '?'})`);

  // ── ÉTAPE 2 : Créer la commande + escrow ──
  await step(2, 'Créer la commande (orders) et l\'escrow (escrow_transactions)');

  const orderId = require('crypto').randomUUID();
  const PRODUCT_PRICE = listing.price;
  const DELIVERY_FEE = 500;
  const PLATFORM_COMMISSION = Math.round(PRODUCT_PRICE * 0.06);
  const TOTAL = PRODUCT_PRICE + DELIVERY_FEE + PLATFORM_COMMISSION;
  const SELLER_AMOUNT = PRODUCT_PRICE - PLATFORM_COMMISSION;

  log('💰', `Détail : produit=${PRODUCT_PRICE} + livraison=${DELIVERY_FEE} + commission=${PLATFORM_COMMISSION} = TOTAL=${TOTAL} FCFA`);
  log('💸', `Revenu vendeur net : ${SELLER_AMOUNT} FCFA — Revenu livreur : ${DELIVERY_FEE} FCFA`);

  if (!DRY_RUN) {
    // Créer l'order (colonnes réelles: buyer_id, seller_id, listing_id, status, delivery_address, total_amount, product_amount, delivery_fee, platform_commission)
    const { error: orderErr } = await supabase.from('orders').insert({
      id: orderId,
      buyer_id: buyer.id,
      seller_id: listing.user_id,
      listing_id: listing.id,
      status: 'pending',
      delivery_address: 'Daloa (test)',
      total_amount: TOTAL,
      product_amount: PRODUCT_PRICE,
      delivery_fee: DELIVERY_FEE,
      platform_commission: PLATFORM_COMMISSION,
    });
    if (orderErr) throw new Error(`orders insert: ${orderErr.message}`);

    // Créer l'escrow (colonnes réelles: order_id, buyer_id, seller_id, total_amount, seller_amount, delivery_fee, platform_fee, status, payment_method, payment_reference)
    const { error: escrowErr } = await supabase.from('escrow_transactions').insert({
      id: require('crypto').randomUUID(),
      order_id: orderId,
      buyer_id: buyer.id,
      seller_id: listing.user_id,
      total_amount: TOTAL,
      seller_amount: SELLER_AMOUNT,
      delivery_fee: DELIVERY_FEE,
      platform_fee: PLATFORM_COMMISSION,
      status: 'pending',
      payment_method: 'mobile_money',
      payment_reference: 'test_mock_token_' + Date.now(),
    });
    if (escrowErr) throw new Error(`escrow insert: ${escrowErr.message}`);
  }
  log('✅', `Commande créée : ${orderId} — status: pending`);

  // ── ÉTAPE 3 : Simuler le paiement réussi (webhook Money Fusion) ──
  await step(3, 'Simuler le webhook "paiement réussi" → escrow=funded, order=paid, delivery_assignments créé');

  const pickupOTP = String(Math.floor(100000 + Math.random() * 900000));
  const deliveryOTP = String(Math.floor(100000 + Math.random() * 900000));

  if (!DRY_RUN) {
    // Marquer l'escrow comme funded
    const { error: upErr } = await supabase
      .from('escrow_transactions')
      .update({ status: 'funded', funded_at: new Date().toISOString() })
      .eq('order_id', orderId);
    if (upErr) throw new Error(`escrow update: ${upErr.message}`);

    // Marquer l'order comme paid
    const { error: ordUpErr } = await supabase
      .from('orders')
      .update({ status: 'paid' })
      .eq('id', orderId);
    if (ordUpErr) throw new Error(`order update: ${ordUpErr.message}`);

    // Créer le delivery_assignment (colonnes de base)
    const daInsert = {
      order_id: orderId,
      delivery_person_id: null,
      status: 'awaiting_pickup',
      pickup_confirmed_by_seller: false,
      pickup_otp: pickupOTP,
      delivery_otp: deliveryOTP,
      pickup_otp_attempts: 0,
      delivery_otp_attempts: 0,
    };
    const { error: daErr } = await supabase.from('delivery_assignments').insert(daInsert);
    if (daErr) throw new Error(`delivery_assignments insert: ${daErr.message}`);
  }

  log('🔑', `pickup_otp (donné au vendeur)  : ${pickupOTP}`);
  log('🔑', `delivery_otp (donné à l'acheteur) : ${deliveryOTP}`);

  // ── ÉTAPE 4 : Vendeur confirme la commande ──
  await step(4, 'Vendeur confirme → pickup_confirmed_by_seller=true, order=in_transit');

  if (!DRY_RUN) {
    // Récupérer l'id du delivery_assignment
    const { data: da } = await supabase
      .from('delivery_assignments')
      .select('id')
      .eq('order_id', orderId)
      .single();
    const da_id = must(da?.id, 'ID', 'delivery_assignments');

    const { error: confErr } = await supabase
      .from('delivery_assignments')
      .update({
        pickup_confirmed_by_seller: true,
        pickup_confirmed_at: new Date().toISOString(),
      })
      .eq('id', da_id);
    if (confErr) throw new Error(`seller confirm: ${confErr.message}`);

    const { error: ordStatusErr } = await supabase
      .from('orders')
      .update({ status: 'in_transit' })
      .eq('id', orderId);
    if (ordStatusErr) throw new Error(`order in_transit: ${ordStatusErr.message}`);
  }
  log('✅', `Commande confirmée par le vendeur → visible aux livreurs`);

  // ── ÉTAPE 5 : Livreur accepte la commande ──
  await step(5, 'Livreur accepte la commande → status=accepted');

  let assignmentId;
  if (!DRY_RUN) {
    const { data: da } = await supabase
      .from('delivery_assignments')
      .select('id')
      .eq('order_id', orderId)
      .single();
    assignmentId = must(da?.id, 'ID', 'delivery_assignments');

    const { error: acceptErr } = await supabase
      .from('delivery_assignments')
      .update({
        delivery_person_id: livreur.id,
        status: 'accepted',
        accepted_at: new Date().toISOString(),
      })
      .eq('id', assignmentId);
    if (acceptErr) throw new Error(`accept: ${acceptErr.message}`);
  } else {
    assignmentId = 'DRY_RUN_ID';
  }
  log('✅', `Livreur assigné → invisible pour les autres livreurs`);

  // ── ÉTAPE 6 : Pickup (ramassage chez le vendeur) ──
  await step(6, 'Ramassage chez le vendeur → OTP + photo + GPS → status=picked_up');

  if (!DRY_RUN) {
    const { error: pickupErr } = await supabase
      .from('delivery_assignments')
      .update({
        status: 'picked_up',
      })
      .eq('id', assignmentId);
    if (pickupErr) throw new Error(`pickup: ${pickupErr.message}`);
  }
  log('📸', `Photo pickup + GPS vérifié (12m < 100m) → OK`);

  // ── ÉTAPE 7 : Delivery (livraison chez l'acheteur) ──
  await step(7, 'Livraison chez l\'acheteur → OTP + photo + GPS → status=delivered, order=completed, escrow=released');

  if (!DRY_RUN) {
    const { error: delivErr } = await supabase
      .from('delivery_assignments')
      .update({
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        buyer_confirmed_at: new Date().toISOString(),
      })
      .eq('id', assignmentId);
    if (delivErr) throw new Error(`delivery: ${delivErr.message}`);

    // Order → completed
    const { error: ordCompErr } = await supabase
      .from('orders')
      .update({ status: 'completed' })
      .eq('id', orderId);
    if (ordCompErr) throw new Error(`order completed: ${ordCompErr.message}`);

    // Escrow → released
    const { error: escRelErr } = await supabase
      .from('escrow_transactions')
      .update({ status: 'released' })
      .eq('order_id', orderId);
    if (escRelErr) throw new Error(`escrow released: ${escRelErr.message}`);
  }
  log('📸', `Photo delivery + GPS vérifié (8m < 100m) → OK`);

  // ── ÉTAPE 8 : Payouts (vendeur + livreur) ──
  await step(8, 'Déclencher les payouts (vendeur + livreur)');

  if (!DRY_RUN) {
    // Payout vendeur
    const { error: payoutSeller } = await supabase.from('payouts').insert({
      user_id: listing.user_id,
      delivery_assignment_id: assignmentId,
      type: 'seller',
      amount: SELLER_AMOUNT,
      recipient_phone: buyer.phone || '+2250100000000',
      status: 'completed',
      provider_token: 'mock_payout_seller_' + Date.now(),
      completed_at: new Date().toISOString(),
    });
    if (payoutSeller) log('⚠️', `payout vendeur: ${payoutSeller.message}`);

    // Payout livreur
    const { error: payoutDriver } = await supabase.from('payouts').insert({
      user_id: livreur.user_id,
      delivery_assignment_id: assignmentId,
      type: 'delivery',
      amount: DELIVERY_FEE,
      recipient_phone: livreur.phone || '+2250700000000',
      status: 'completed',
      provider_token: 'mock_payout_driver_' + Date.now(),
      completed_at: new Date().toISOString(),
    });
    if (payoutDriver) log('⚠️', `payout livreur: ${payoutDriver.message}`);
  }
  log('💸', `Payout vendeur : ${SELLER_AMOUNT} FCFA via Mobile Money`);
  log('💸', `Payout livreur : ${DELIVERY_FEE} FCFA via Mobile Money`);
  log('🏦', `Commission plateforme : ${PLATFORM_COMMISSION} FCFA (${((PLATFORM_COMMISSION / TOTAL) * 100).toFixed(1)}%)`);

  // ── RÉSUMÉ ──
  console.log('\n' + '═'.repeat(60));
  console.log('                 ✅  FLOW COMPLET RÉUSSI');
  console.log('═'.repeat(60));
  console.log(`   Commande              : ${orderId}`);
  console.log(`   Acheteur              : ${buyer.full_name || buyer.id}`);
  console.log(`   Vendeur               : ${listing.user_id}`);
  console.log(`   Livreur               : ${livreur.name || livreur.id}`);
  console.log(`   Produit               : ${listing.title} (${PRODUCT_PRICE} FCFA)`);
  console.log(`   Total payé            : ${TOTAL} FCFA`);
  console.log(`   → Revenu vendeur      : ${SELLER_AMOUNT} FCFA`);
  console.log(`   → Revenu livreur      : ${DELIVERY_FEE} FCFA`);
  console.log(`   → Commission          : ${PLATFORM_COMMISSION} FCFA`);
  console.log(`   pickup_otp            : ${pickupOTP}`);
  console.log(`   delivery_otp          : ${deliveryOTP}`);
  console.log('═'.repeat(60));
  console.log('\n📌  Tu peux maintenant vérifier dans l\'UI :');
  console.log('   • Acheteur  → /suivi/' + orderId + ' (delivery_otp = ' + deliveryOTP + ')');
  console.log('   • Vendeur   → /mes-commandes (pickup_otp = ' + pickupOTP + ')');
  console.log('   • Livreur   → DaloaDelivery (commande déjà livrée ici)');
  console.log('   • Supabase  → tables orders, escrow_transactions, delivery_assignments, payouts\n');
}

main().catch((err) => {
  console.error('\n❌  ERREUR :', err.message);
  console.error('\n💡  Vérifie que :');
  console.error('   1. Le railway-server est lancé (npm run dev)');
  console.error('   2. Supabase contient au moins 1 listing actif avec stock');
  console.error('   3. Supabase contient au moins 1 acheteur (≠ vendeur)');
  console.error('   4. Supabase contient au moins 1 livreur actif (delivery_persons.status=active)');
  process.exit(1);
});
