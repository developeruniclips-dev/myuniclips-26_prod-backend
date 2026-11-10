'use strict';
// Offline regression only. No MySQL, provider, Docker or application imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewSchema } = require('../src/services/paystackNigeria/compatibility');
const { lifetimeBaseline } = require('../src/services/paystackNigeria/baseline');
const { createMysqlStore } = require('../src/services/paystackNigeria/store');
const { createServices } = require('../src/services/paystackNigeria/services');
const { createPolicy } = require('../src/services/paystackNigeria/policy');
const { statements } = require('../src/services/paystackNigeria/schema');
const { metadata } = require('./fixtures/paystackNigeriaMetadata.cjs');
const { createMemoryStore,historical } = require('./fixtures/paystackNigeriaMemory.cjs');
test('metadata preflight refuses unknown schema, unsigned FKs, MyISAM, missing columns and absent entitlement uniqueness', () => {
    assert.equal(reviewSchema().compatible,false);
    assert.equal(reviewSchema(metadata()).compatible,true);
    assert.equal(reviewSchema(metadata(false)).compatible,true);
    for (const mutate of [
        m => { m.columns['users.id'].unsigned=true; },
        m => { m.columns['subjects.id'].type='bigint'; },
        m => { m.tables.subject_purchases.engine='MyISAM'; },
        m => { delete m.columns['subject_purchases.renewed_at']; },
        m => { m.columns['subject_purchases.transaction_id'].length=40; },
        m => { m.columns['subject_purchases.amount'].scale=0; },
        m => { m.uniqueKeys.subject_purchases=[['id']]; },
        m => { m.uniqueKeys.users=[]; },
        m => { m.uniqueKeys.payment_sale_counters=[]; },
        m => { delete m.stripeCounterPresent; },
    ]) { const m=metadata(); mutate(m); assert.equal(reviewSchema(m).compatible,false); }
    let acquired=false;
    assert.throws(() => createMysqlStore({ pool: { getConnection() { acquired=true; } },resolveHistoricalSales: async () => [] }), { code: 'SCHEMA_VERIFICATION_REQUIRED' });
    assert.equal(acquired,false);
});
test('missing pair index is reported as an unqualified scan, never silently added to existing tables', () => {
    const m=metadata(); m.indexes.subject_purchases=[];
    assert.deepEqual(reviewSchema(m).warnings,['LIFETIME_CENSUS_INDEX_UNQUALIFIED']);
    assert(statements.every(sql => sql.startsWith('CREATE TABLE paystack_ng_')));
});
test('historical verified counts still refuse missing, duplicate or gapped global ordinals', () => {
    const { purchases,proofs }=historical(3);
    const base={ purchases,ownAllocations: [],counter: undefined,stripeCounter: 3 };
    assert.equal(lifetimeBaseline({ ...base,historicalProofs: proofs }).successfulSales,3);
    for (const mutation of [p => { delete p[0].ordinal; },p => { p[1].ordinal=1; },p => { p[2].ordinal=4; }]) {
        const bad=structuredClone(proofs); mutation(bad);
        assert.throws(() => lifetimeBaseline({ ...base,historicalProofs: bad }));
    }
    const own={ ...purchases[2],currency: 'NGN',amountMinor: 150000,transactionId: 'own-ng' };
    assert.throws(() => lifetimeBaseline({ ...base,purchases: [purchases[0],purchases[1],own],
        ownAllocations: [{ purchaseId: 3,ordinal: 2,reference: 'own-ng' }],historicalProofs: proofs.slice(0,2) }), { code: 'BASELINE_ORDINAL_CONFLICT' });
});
test('fulfillment acquires shared counters before subject/NG order; completed replay writes no counter', async () => {
    const store=createMemoryStore(historical(99)), events=[];
    const original=store.transaction.bind(store);
    store.transaction=work => original(tx => work(new Proxy(tx,{ get(target,key) {
        const method=target[key];
        if (['lockLifetime','lockSubject','order','sales'].includes(key)) return async (...args) => { events.push(key); return method(...args); };
        return method;
    } })));
    const policy=createPolicy({ enabled: true,merchantAccount: 'synthetic-merchant' });
    const now=Date.UTC(2026,10,6);
    const provider={ kind: 'offline-double',async verify(reference) {
        const o=store.state().orders.find(o => o.reference===reference);
        return { verified: true,status: 'success',refundedMinor: 0,disputed: false,orderId: o.id,buyerId: 1,subjectId: 10,scholarId: 20,
            merchantAccount: policy.merchantAccount,environment: 'test',reference,transactionId: 'synthetic-transaction',
            currency: 'NGN',amountMinor: 150000,totalChargedMinor: 150000,feesMinor: null,paidAt: now/1000,evidenceDigest: 'b'.repeat(64) };
    } };
    const service=createServices({ store,policy,provider,now: () => now,writerPolicy:require('./fixtures/courseWriterPolicy.cjs')() });
    const o=await service.createOrder({ buyerId: 1,subjectId: 10,scholarId: 20,idempotencyKey: 'synthetic-request-key' });
    events.length=0;
    assert.equal((await service.fulfill({ orderId: o.id,buyerId: 1 })).ordinal,100);
    assert.deepEqual(events,['lockSubject','lockLifetime','order','sales']);
    events.length=0;
    assert.equal((await service.fulfill({ orderId: o.id,buyerId: 1 })).replay,true);
    assert.deepEqual(events,['lockSubject','order']);
});
function sqlStore(overrides = {}, handler = async () => [[]]) {
    const events=[];
    const db={
        async query(sql,args) { events.push(sql); if (sql.includes('@@session.time_zone')) return [[{ zone: '+00:00' }]]; return handler(sql,args); },
        async beginTransaction() { events.push('begin'); },async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },release() { events.push('release'); },destroy() { events.push('destroy'); },...overrides,
    };
    return { events,store: createMysqlStore({ pool: { getConnection: async () => db },schemaMetadata: metadata(),resolveHistoricalSales: async () => [] }) };
}
test('isolation affects next NG transaction only; pending setup or failed rollback destroys rather than contaminates pooled connection', async () => {
    const good=sqlStore(); await good.store.transaction(async () => {});
    assert(good.events.indexOf('SET TRANSACTION ISOLATION LEVEL READ COMMITTED') < good.events.indexOf('begin'));
    assert(!good.events.some(s => /SET\s+(GLOBAL|SESSION)/.test(s)));
    assert.equal(good.events.at(-1),'release');
    const pending=sqlStore({ async beginTransaction() { throw Error('synthetic begin failure'); } });
    await assert.rejects(pending.store.transaction(async () => {}));
    assert.equal(pending.events.at(-1),'destroy'); assert(!pending.events.includes('release'));
    const broken=sqlStore({ async rollback() { throw Error('synthetic rollback failure'); } });
    await assert.rejects(broken.store.transaction(async () => { throw Error('synthetic work failure'); }),{ code: 'PAYSTACK_NG_TRANSACTION_UNCERTAIN' });
    assert.equal(broken.events.at(-1),'destroy'); assert(!broken.events.includes('release'));
});
test('corrupt NG allocation/order/evidence chains are rejected rather than treated as verified historical grants', async () => {
    for (const validated of [0,null,undefined]) {
        const f=sqlStore({},async () => [[{ purchase_id: 1,sale_ordinal: 1,reference: 'synthetic-ng',validated }]]);
        await assert.rejects(f.store.transaction(tx => tx.allocations(10,20)),{ code: 'BASELINE_NG_LEDGER_MISMATCH' });
    }
    const good=sqlStore({},async () => [[{ purchase_id: 1,sale_ordinal: 1,reference: 'synthetic-ng',validated: 1 }]]);
    assert.deepEqual(await good.store.transaction(tx => tx.allocations(10,20)),[{ purchaseId: 1,ordinal: 1,reference: 'synthetic-ng' }]);
    const query=good.events.find(s => s.includes('FROM paystack_ng_allocations'));
    assert.match(query,/LEFT JOIN paystack_ng_transactions/); assert.match(query,/o\.purchase_id=a\.purchase_id/);
});
test('schema pins collations, exact receipt linkage and fulfilled-purchase state without cascading financial history', () => {
    assert(statements.every(sql => sql.includes('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')));
    assert.match(statements[2],/FOREIGN KEY \(order_id,merchant_account,environment,reference\)/);
    assert.match(statements[1],/state='fulfilled' AND purchase_id IS NOT NULL AND fulfilled_at IS NOT NULL/);
    assert(!statements.some(sql => /ON DELETE CASCADE|ON UPDATE CASCADE/.test(sql)));
});
