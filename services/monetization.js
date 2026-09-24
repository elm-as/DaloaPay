/**
 * Achats hors commande : Pass Pro et packs de crédits.
 *
 * Le prix était jusqu'ici celui envoyé par l'appli dans `amount`, et le
 * contrôle anti sous-paiement le comparait à cette même valeur. Un appel direct
 * à l'API avec `amount: 100` obtenait donc un Pass Pro à 100 FCFA. Le prix est
 * désormais décidé ici, et nulle part ailleurs côté serveur.
 *
 * Doit rester aligné avec `PRICING_CONFIG` (packages/config/src/pricing.ts) et
 * `DaloaMarket-v2/src/lib/featureFlags.ts`.
 */

const SELLER_BADGE_PRICES = { monthly: 2500, yearly: 25000 };

/** Packs de crédits de boost. */
const PACK_PRICES = {
  credits_pack_5: 500,
  credits_pack_12: 1000,
  credits_pack_30: 2000,
};

// `listing_pack_10` n'est plus vendu ; il reste ici pour confirmer une
// éventuelle transaction ancienne encore en attente.
const PACK_CREDITS = {
  listing_pack_10: 10,
  credits_pack_5: 5,
  credits_pack_12: 12,
  credits_pack_30: 30,
};

const CONFIRM_RPC_BY_TYPE = {
  seller_badge: 'confirm_seller_badge',
  boost: 'confirm_boost',
  bump: 'confirm_bump',
};

/**
 * Formule du Pass Pro. Les APK déjà installées n'envoient pas `plan` : on la
 * déduit alors du montant qu'elles envoyaient, qui ne sert plus qu'à ça.
 */
function resolveSellerBadgePlan(plan, legacyAmount) {
  if (plan === 'yearly' || plan === 'annual') return 'yearly';
  if (plan === 'monthly') return 'monthly';
  return Number(legacyAmount) === SELLER_BADGE_PRICES.yearly ? 'yearly' : 'monthly';
}

/** Prix serveur d'un achat hors commande, ou `null` si le type est inconnu. */
function resolveMonetizationPrice(type, plan, legacyAmount) {
  if (type === 'seller_badge') {
    const resolvedPlan = resolveSellerBadgePlan(plan, legacyAmount);
    return { amount: SELLER_BADGE_PRICES[resolvedPlan], plan: resolvedPlan };
  }
  if (PACK_PRICES[type] != null) return { amount: PACK_PRICES[type], plan: null };
  return null;
}

/**
 * Montant brut réellement encaissé par MoneyFusion : `Montant` (net) + `frais`
 * (commission opérateur), puisque le client a payé les deux.
 */
function paidGrossAmount(fusionData) {
  const paidNet = Number(fusionData?.data?.Montant ?? fusionData?.data?.montant) || 0;
  const paidFees = Number(fusionData?.data?.frais ?? fusionData?.data?.Frais ?? 0) || 0;
  return paidNet + paidFees;
}

/** Tolérance de 1 FCFA pour les arrondis. */
function isUnderpaid(fusionData, expectedAmount) {
  const paidGross = paidGrossAmount(fusionData);
  const expected = Number(expectedAmount);
  return Number.isFinite(paidGross) && Number.isFinite(expected)
    && paidGross > 0 && paidGross < expected - 1;
}

/**
 * Active un achat payé, une seule fois.
 *
 * Le webhook MoneyFusion et le polling `check-payment` peuvent arriver en même
 * temps. Ils lisaient tous deux `status = 'pending'` puis activaient l'achat :
 * un Pass Pro pouvait être prolongé deux fois, des crédits ajoutés deux fois.
 * La transaction est maintenant réservée par un UPDATE conditionnel ; seul
 * l'appel qui l'obtient active l'achat. En cas d'échec de l'activation, la
 * réservation est rendue pour que la tentative suivante réessaie.
 *
 * @returns {Promise<boolean>} true si cet appel a activé l'achat.
 */
async function confirmMonetizationOnce(supabase, tx) {
  const { data: claimed, error: claimErr } = await supabase
    .from('monetization_transactions')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', tx.id)
    // `failed` reste rattrapable : MoneyFusion peut confirmer après un échec.
    .neq('status', 'confirmed')
    .select('id')
    .maybeSingle();

  if (claimErr) throw claimErr;
  // Déjà activé par un autre appel (webhook ou polling).
  if (!claimed) return false;

  try {
    const rpc = CONFIRM_RPC_BY_TYPE[tx.type];
    if (rpc) {
      const { error } = await supabase.rpc(rpc, { p_transaction_id: tx.id });
      if (error) throw error;
    } else if (PACK_CREDITS[tx.type] != null) {
      const { error } = await supabase.rpc('add_listing_credits', {
        user_uuid: tx.user_id,
        quantity: PACK_CREDITS[tx.type],
      });
      if (error) throw error;
    }
  } catch (err) {
    await supabase
      .from('monetization_transactions')
      .update({ status: tx.status === 'failed' ? 'failed' : 'pending', confirmed_at: null })
      .eq('id', tx.id);
    throw err;
  }

  return true;
}

module.exports = {
  SELLER_BADGE_PRICES,
  PACK_PRICES,
  resolveMonetizationPrice,
  paidGrossAmount,
  isUnderpaid,
  confirmMonetizationOnce,
};
