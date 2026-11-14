/**
 * Exécution asynchrone par lots à concurrence bornée.
 * Évite les rafales non contrôlées sur les passerelles Expo / WebPush et Supabase.
 */

const DEFAULT_PUSH_CONCURRENCY = 8;

/**
 * Exécute une tâche asynchrone sur chaque élément avec un plafond de concurrence strict.
 * @param {Array} items Éléments à traiter
 * @param {Function} worker Fonction asynchrone appliquée à chaque élément
 * @param {number} [concurrencyLimit] Nombre maximum de tâches simultanées
 * @returns {Promise<Array<{status: 'fulfilled'|'rejected', value?: any, reason?: any}>>}
 */
async function runWithConcurrency(items, worker, concurrencyLimit = DEFAULT_PUSH_CONCURRENCY) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrencyLimit, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const currentIndex = cursor;
      cursor += 1;
      try {
        const value = await worker(items[currentIndex], currentIndex);
        results[currentIndex] = { status: 'fulfilled', value };
      } catch (reason) {
        results[currentIndex] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: limit }, () => runWorker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  DEFAULT_PUSH_CONCURRENCY,
  runWithConcurrency,
};
