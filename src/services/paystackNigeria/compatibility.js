'use strict';
const { fail } = require('./policy');
// Pure validator for a future authorized INFORMATION_SCHEMA readback. Synthetic
// test metadata is not evidence about an existing database. No connection occurs.
function reviewSchema(metadata) {
    const blockers = [], warnings = [];
    const m = metadata || {}, tables = m.tables || {}, columns = m.columns || {}, unique = m.uniqueKeys || {}, indexes = m.indexes || {};
    for (const table of ['users','subjects','subject_purchases']) if (tables[table]?.engine !== 'InnoDB') blockers.push('INNODB_REQUIRED:' + table);
    for (const name of ['users.id','subjects.id','subject_purchases.id','subject_purchases.buyer_user_id','subject_purchases.subject_id','subject_purchases.scholar_id']) {
        const c = columns[name];
        if (!c || c.type !== 'int' || c.unsigned !== false || c.nullable !== false) blockers.push('SIGNED_INT_REQUIRED:' + name);
    }
    const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    for (const table of ['users','subjects','subject_purchases']) if (!(unique[table] || []).some(k => same(k,['id']))) blockers.push('PARENT_ID_UNIQUE_REQUIRED:' + table);
    if (!(unique.subject_purchases || []).some(k => same(k,['buyer_user_id','subject_id','scholar_id']))) blockers.push('ENTITLEMENT_UNIQUE_REQUIRED');
    for (const name of ['access_expires_at','is_access_active','created_at','renewed_at','amount','currency','transaction_id']) {
        if (!columns['subject_purchases.' + name]) blockers.push('PURCHASE_COLUMN_REQUIRED:' + name);
    }
    const amount = columns['subject_purchases.amount'];
    if (!amount || amount.type !== 'decimal' || amount.scale !== 2 || amount.precision < 6) blockers.push('PURCHASE_DECIMAL_REQUIRED');
    const currency = columns['subject_purchases.currency'];
    if (!currency || !['char','varchar'].includes(currency.type) || currency.length < 3) blockers.push('PURCHASE_CURRENCY_REQUIRED');
    const reference = columns['subject_purchases.transaction_id'];
    if (!reference || !['char','varchar'].includes(reference.type) || reference.length < 100) blockers.push('PURCHASE_REFERENCE_CAPACITY_REQUIRED');
    if (!(indexes.subject_purchases || []).some(k => k[0] === 'subject_id' && k[1] === 'scholar_id')) warnings.push('LIFETIME_CENSUS_INDEX_UNQUALIFIED');
    // The optional counter is not selected by catching errors at runtime.
    // Its presence/absence must come from the same verified metadata readback.
    if (typeof m.stripeCounterPresent !== 'boolean') blockers.push('STRIPE_COUNTER_PRESENCE_REQUIRED');
    if (m.stripeCounterPresent) {
        if (tables.payment_sale_counters?.engine !== 'InnoDB') blockers.push('STRIPE_COUNTER_ENGINE_REQUIRED');
        if (!(unique.payment_sale_counters || []).some(k => same(k,['subject_id','scholar_id']))) blockers.push('STRIPE_COUNTER_UNIQUE_REQUIRED');
        for (const name of ['subject_id','scholar_id','legacy_baseline','successful_sales']) {
            const c = columns['payment_sale_counters.' + name];
            if (!c || c.type !== 'int' || c.unsigned !== false || c.nullable !== false) blockers.push('STRIPE_COUNTER_TYPE_REQUIRED:' + name);
        }
    }
    return { compatible: blockers.length === 0, blockers, warnings, stripeCounterPresent: m.stripeCounterPresent };
}
function requireSchema(metadata) {
    const result = reviewSchema(metadata);
    if (!result.compatible) fail('SCHEMA_VERIFICATION_REQUIRED');
    return result;
}
module.exports = { reviewSchema, requireSchema };
