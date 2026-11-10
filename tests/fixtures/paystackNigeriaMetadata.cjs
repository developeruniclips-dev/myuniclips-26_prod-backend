'use strict';
// Handwritten synthetic metadata, NOT a production/staging schema readback.
function metadata(stripeCounterPresent = true) {
    const tables = {}, columns = {}, uniqueKeys = {}, indexes = {};
    for (const table of ['users','subjects','subject_purchases','payment_sale_counters']) {
        tables[table] = { engine: 'InnoDB' }; uniqueKeys[table] = [['id']];
    }
    const integer = () => ({ type: 'int',unsigned: false,nullable: false });
    for (const name of ['users.id','subjects.id','subject_purchases.id','subject_purchases.buyer_user_id','subject_purchases.subject_id','subject_purchases.scholar_id',
        'payment_sale_counters.subject_id','payment_sale_counters.scholar_id','payment_sale_counters.legacy_baseline','payment_sale_counters.successful_sales']) columns[name] = integer();
    for (const name of ['created_at','access_expires_at','renewed_at']) columns['subject_purchases.' + name] = { type: 'datetime' };
    columns['subject_purchases.is_access_active'] = { type: 'tinyint' };
    columns['subject_purchases.amount'] = { type: 'decimal',precision: 10,scale: 2 };
    columns['subject_purchases.currency'] = { type: 'varchar',length: 3 };
    columns['subject_purchases.transaction_id'] = { type: 'varchar',length: 255 };
    uniqueKeys.subject_purchases.push(['buyer_user_id','subject_id','scholar_id']);
    uniqueKeys.payment_sale_counters = [['subject_id','scholar_id']];
    indexes.subject_purchases = [['subject_id','scholar_id','id']];
    return { tables,columns,uniqueKeys,indexes,stripeCounterPresent };
}
module.exports = { metadata };
