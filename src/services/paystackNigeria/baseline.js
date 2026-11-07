'use strict';
const { id, fail } = require('./policy');
// All inputs must be read under the shared subject/counter transaction locks.
// Historical verification is deliberately explicit: a transaction_id or a
// currency alone is NOT proof of payment. Unknown history blocks fulfillment.
function lifetimeBaseline({ purchases, historicalProofs, ownAllocations, counter, stripeCounter }) {
    if (![purchases,historicalProofs,ownAllocations].every(Array.isArray) || purchases.length > 10000) fail('BASELINE_REVIEW_REQUIRED');
    const purchaseMap = new Map();
    for (const row of purchases) {
        id(row.id);
        if (purchaseMap.has(row.id)) fail('BASELINE_DUPLICATE_PURCHASE');
        purchaseMap.set(row.id, row);
    }
    const counted = new Set();
    let lastOwnOrdinal = 0;
    const ordinals = new Set();
    for (const row of ownAllocations) {
        id(row.purchaseId); id(row.ordinal);
        const purchase = purchaseMap.get(row.purchaseId);
        if (!purchase || purchase.currency !== 'NGN' || purchase.amountMinor !== 150000 ||
            purchase.transactionId !== row.reference || counted.has(row.purchaseId) || ordinals.has(row.ordinal)) fail('BASELINE_NG_LEDGER_MISMATCH');
        counted.add(row.purchaseId);
        ordinals.add(row.ordinal);
        lastOwnOrdinal = Math.max(lastOwnOrdinal, row.ordinal);
    }
    for (const proof of historicalProofs) {
        const purchase = purchaseMap.get(proof.purchaseId);
        if (!purchase || proof.verified !== true || typeof proof.provenance !== 'string' || !proof.provenance.trim() ||
            typeof proof.provider !== 'string' || !proof.provider.trim() || proof.reference !== purchase.transactionId ||
            proof.currency !== purchase.currency || proof.amountMinor !== purchase.amountMinor ||
            !Number.isSafeInteger(proof.amountMinor) || proof.amountMinor <= 0 || counted.has(proof.purchaseId)) {
            fail('BASELINE_VERIFICATION_REQUIRED');
        }
        // Counts alone cannot detect a Stripe/legacy ordinal reused elsewhere.
        // Pre-ledger rows require an audited ordinal, never an invented reset.
        if (!Number.isSafeInteger(proof.ordinal) || proof.ordinal < 1) fail('BASELINE_ORDINAL_REQUIRED');
        if (ordinals.has(proof.ordinal)) fail('BASELINE_ORDINAL_CONFLICT');
        ordinals.add(proof.ordinal);
        counted.add(proof.purchaseId);
    }
    if (counted.size !== purchases.length) fail('BASELINE_VERIFICATION_REQUIRED');
    const total = counted.size, ng = ownAllocations.length, historical = total - ng;
    if (lastOwnOrdinal > total || [...ordinals].some(n => n > total)) fail('BASELINE_REGRESSION');
    if (counter && (![counter.successfulSales,counter.ngSales,counter.historicalSales].every(n => Number.isSafeInteger(n) && n >= 0) ||
        counter.successfulSales !== counter.ngSales + counter.historicalSales ||
        counter.successfulSales > total || counter.ngSales !== ng || counter.historicalSales > historical)) fail('BASELINE_REGRESSION');
    // Existing Stripe phase2a counts must never be lowered or silently reset.
    if (stripeCounter !== null && (!Number.isSafeInteger(stripeCounter) || stripeCounter < 0 || stripeCounter > total)) fail('BASELINE_REGRESSION');
    return { successfulSales: total, ngSales: ng, historicalSales: historical };
}
module.exports = { lifetimeBaseline };
