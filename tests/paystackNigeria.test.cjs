'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RULE,createPolicy,share } = require('../src/services/paystackNigeria/policy');
const { lifetimeBaseline } = require('../src/services/paystackNigeria/baseline');
const { createServices,fiveMonths } = require('../src/services/paystackNigeria/services');
const { createMemoryStore,historical } = require('./fixtures/paystackNigeriaMemory.cjs');
const time = Date.UTC(2026,10,6,12), merchant = 'synthetic-merchant';
const enabled = () => createPolicy({ enabled: true, merchantAccount: merchant });
const request = (buyerId = 1, key = crypto.randomUUID()) => ({ buyerId,subjectId: 10,scholarId: 20,idempotencyKey: key });
function setup(initial = {}) {
    const store = createMemoryStore(initial);
    const provider = { kind: 'offline-double', calls: 0, patch: {}, async verify(reference) {
        this.calls++;
        const o = store.state().orders.find(o => o.reference === reference);
        return { verified: true,status: 'success',orderId: o.id,buyerId: o.buyerId,subjectId: o.subjectId,scholarId: o.scholarId,
            reference,transactionId: 'transaction_' + o.buyerId,merchantAccount: merchant,environment: 'test',currency: 'NGN',
            amountMinor: 150000,totalChargedMinor: 150000,feesMinor: 3000,refundedMinor: 0,disputed: false,paidAt: time/1000,evidenceDigest: 'a'.repeat(64),...this.patch };
    } };
    return { store,provider,service: createServices({ writerPolicy:require('./fixtures/courseWriterPolicy.cjs')(), store,provider,policy: enabled(),now: () => time }) };
}
test('disabled by default; live context refused before DB/provider work', async () => {
    let calls = 0;
    const store = { async transaction() { calls++; } };
    await assert.rejects(createServices({ store }).createOrder(request()), { code: 'PAYSTACK_NG_DISABLED' });
    const service = createServices({ store,policy: createPolicy({ enabled: true,environment: 'live',merchantAccount: merchant }) });
    await assert.rejects(service.createOrder(request()), { code: 'PAYSTACK_NG_LIVE_NOT_SUPPORTED' });
    assert.equal(calls,0);
});
test('inclusive price, gross commission, fee absorption and exact tier boundaries', () => {
    for (const n of [1,99,100]) assert.equal(share(n,3000).scholarMinor,105000);
    for (const n of [101,102,10000]) assert.equal(share(n,3000).scholarMinor,75000);
    assert.equal(share(100,50000).platformNetMinor,-5000);
    assert.equal(share(100,null).platformNetMinor,null);
    assert.equal(share(101,3000).platformNetMinor,72000);
    for (const n of [0,-1,1.5,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => share(n));
    for (const n of [-1,1.5,'30',Infinity]) assert.throws(() => share(1,n));
    assert.equal(RULE.automaticPayouts,false);
});
test('invalid totals/currencies/IDs rejected; creating an order does not contact provider', async () => {
    const { service,store,provider } = setup();
    for (const totalMinor of [149999,150001,'150000',150000.1,NaN,-1]) await assert.rejects(service.createOrder({ ...request(),totalMinor }));
    for (const currency of ['EUR','ngn','USD','']) await assert.rejects(service.createOrder({ ...request(),currency }));
    await assert.rejects(service.createOrder(request('1')));
    await assert.rejects(service.createOrder(request(20)), { code: 'SELF_PURCHASE_BLOCKED' });
    await assert.rejects(service.createOrder(request(9999)), { code: 'BUYER_NOT_FOUND' });
    const o = await service.createOrder(request());
    assert.equal(o.totalMinor,150000); assert.equal(o.currency,'NGN'); assert.equal(provider.calls,0);
    assert.equal(store.state().purchases.length,0);
});
test('idempotent order reuse, duplicate pending orders and cross-course key reuse', async () => {
    const { service,store } = setup(), r = request();
    const o = await service.createOrder(r);
    assert.equal((await service.createOrder(r)).id,o.id);
    await assert.rejects(service.createOrder(request()), { code: 'ORDER_ALREADY_EXISTS' });
    await assert.rejects(service.createOrder({ ...r,subjectId: 11 }), { code: 'IDEMPOTENCY_CONTEXT_MISMATCH' });
    assert.equal(store.state().orders.length,1);
});
test('existing active AND expired purchases block checkout without renewal', async () => {
    for (const active of [true,false]) {
        const { service,store } = setup({ purchases: [{ id: 1,buyerId: 1,subjectId: 10,scholarId: 20,active,expiresAt: time-1 }] });
        await assert.rejects(service.createOrder(request()), { code: 'REPURCHASE_BLOCKED' });
        assert.equal(store.state().orders.length,0);
    }
});
test('five calendar months clamp month-end and retain UTC time across leap years', () => {
    for (const [a,b] of [['2026-01-31T14:15:16Z','2026-06-30T14:15:16Z'],['2023-09-30T00:00:00Z','2024-02-29T00:00:00Z'],['2024-09-30T00:00:00Z','2025-02-28T00:00:00Z']]) {
        assert.equal(fiveMonths(Date.parse(a)/1000),Date.parse(b));
    }
});
test('fulfillment verifies buyer/context and rejects wrong or incomplete evidence before writes', async () => {
    const { service,store,provider } = setup(), o = await service.createOrder(request());
    await assert.rejects(service.fulfill({ orderId: o.id,buyerId: 2 }), { code: 'ORDER_NOT_FOUND' });
    assert.equal(provider.calls,0);
    for (const patch of [{ verified: false },{ status: 'pending' },{ status: 'reversed' },{ refundedMinor: 1 },{ refundedMinor: undefined },{ disputed: true },{ disputed: undefined },{ amountMinor: 150001 },{ currency: 'EUR' },{ totalChargedMinor: 153000 },
        { reference: 'other' },{ orderId: crypto.randomUUID() },{ buyerId: 2 },{ subjectId: 11 },{ scholarId: 21 },
        { merchantAccount: 'other' },{ environment: 'live' },{ feesMinor: -1 },{ paidAt: time/1000+1 },{ paidAt: time/1000-1 },{ evidenceDigest: 'invalid' }]) {
        provider.patch = patch; await assert.rejects(service.fulfill({ orderId: o.id,buyerId: 1 }));
        assert.equal(store.state().purchases.length,0);
    }
    provider.verify = async () => { throw Error('synthetic private provider detail'); };
    await assert.rejects(service.fulfill({ orderId: o.id,buyerId: 1 }), { message: 'PAYMENT_EVIDENCE_UNAVAILABLE' });
});
test('global per-course/Scholar baseline includes currencies/providers once; incoming Stripe sales preserve tier', async () => {
    const { store,provider,service } = setup({ ...historical(99),stripeCounters: { '10:20': 99 } });
    const a = await service.createOrder(request(1));
    const first = await service.fulfill({ orderId: a.id,buyerId: 1 });
    assert.equal(first.ordinal,100); assert.equal(first.scholarMinor,105000);
    assert.equal(store.state().stripeCounters['10:20'],100);
    // Another verified provider sale arrives after NG sale 100.
    store.edit(s => {
        const p = { id: 101,buyerId: 3000,subjectId: 10,scholarId: 20,currency: 'EUR',amountMinor: 600,transactionId: 'stripe_after_ng' };
        s.purchases.push(p); s.proofs.push({ purchaseId: p.id,ordinal: 101,verified: true,provider: 'stripe',provenance: 'synthetic-allocation',reference: p.transactionId,currency: p.currency,amountMinor: p.amountMinor });
        s.stripeCounters['10:20'] = 101;
    });
    const b = await service.createOrder(request(2));
    const second = await service.fulfill({ orderId: b.id,buyerId: 2 });
    assert.equal(second.ordinal,102); assert.equal(second.scholarMinor,75000);
    assert.deepEqual(store.state().counters['10:20'],{ historicalSales: 100,ngSales: 2,successfulSales: 102 });
    assert.equal(store.state().stripeCounters['10:20'],102);
    assert.equal(provider.calls,2);
    assert.deepEqual(await service.earnings(20),{ currency: 'NGN',sales: 2,grossMinor: 300000,scholarMinor: 180000,platformGrossMinor: 120000,payoutState: 'held' });
});
test('unknown historical verification and regressed baselines fail closed; no currency-filtered reset', async () => {
    for (const mutate of [s => { s.proofs.pop(); },s => { s.stripeCounters['10:20']=101; },s => { s.proofs.push(s.proofs[0]); },s => { s.proofs[0].amountMinor++; }]) {
        const { service,store } = setup({ ...historical(99),stripeCounters: { '10:20': 99 } });
        store.edit(mutate);
        const o = await service.createOrder(request()), before = store.state();
        await assert.rejects(service.fulfill({ orderId: o.id,buyerId: 1 }));
        assert.deepEqual(store.state(),before);
    }
    assert.throws(() => lifetimeBaseline({ purchases: new Array(10001),historicalProofs: [],ownAllocations: [],stripeCounter: null }), { code: 'BASELINE_REVIEW_REQUIRED' });
});
test('threshold is independent per course AND Scholar, never a Scholar-wide sales bucket', async () => {
    for (const [subjectId,scholarId] of [[11,20],[10,21]]) {
        const { service }=setup(historical(150));
        const o=await service.createOrder({ ...request(),subjectId,scholarId });
        const result=await service.fulfill({ orderId: o.id,buyerId: 1 });
        assert.equal(result.ordinal,1); assert.equal(result.scholarMinor,105000);
    }
});
test('missing own grants, duplicate own ordinals and invalid persisted counters cannot reset tiers', () => {
    const p={ id: 1,currency: 'NGN',amountMinor: 150000,transactionId: 'own-sale' };
    const a={ purchaseId: 1,ordinal: 1,reference: 'own-sale' };
    for (const input of [
        { purchases: [],ownAllocations: [a],counter: undefined },
        { purchases: [p],ownAllocations: [a],counter: { historicalSales: 0,ngSales: 0,successfulSales: 1 } },
        { purchases: [p],ownAllocations: [a],counter: { historicalSales: 0,ngSales: 1,successfulSales: 2 } },
        { purchases: [p,{ ...p,id: 2 }],ownAllocations: [a,{ ...a,purchaseId: 2 }],counter: undefined },
    ]) assert.throws(() => lifetimeBaseline({ ...input,historicalProofs: [],stripeCounter: null }));
});
test('slow provider double holds no database transaction; no value is granted before it settles', async () => {
    const { service,store,provider }=setup(), o=await service.createOrder(request(1));
    const original=provider.verify.bind(provider);
    let entered,release;
    const started=new Promise(r => { entered=r; });
    provider.verify=async reference => { entered(); await new Promise(r => { release=r; }); return original(reference); };
    const operation=service.fulfill({ orderId: o.id,buyerId: 1 }); await started;
    assert.equal(store.state().allocations.length,0);
    await service.createOrder(request(2)); // Succeeds while verification is pending.
    release(); await operation;
    assert.equal(store.state().allocations.length,1);
});
test('repeated confirmation creates one purchase/allocation and never renews expired access', async () => {
    const { service,store,provider } = setup(), o = await service.createOrder(request());
    await service.fulfill({ orderId: o.id,buyerId: 1 });
    const before = store.state();
    assert.equal((await service.fulfill({ orderId: o.id,buyerId: 1 })).replay,true);
    assert.deepEqual(store.state(),before);
    const later = createServices({ writerPolicy:require('./fixtures/courseWriterPolicy.cjs')(), store,provider,policy: enabled(),now: () => fiveMonths(time/1000)+1 });
    assert.equal((await later.fulfill({ orderId: o.id,buyerId: 1 })).replay,true);
    assert.deepEqual(store.state(),before);
    await assert.rejects(later.createOrder(request()), { code: 'REPURCHASE_BLOCKED' });
});
test('concurrent sales reject competing work, retain transaction until settlement, then assign unique 100/101', async () => {
    const { service,store } = setup(historical(99));
    const a = await service.createOrder(request(1)), b = await service.createOrder(request(2));
    let release, entered;
    const started = new Promise(r => { entered=r; });
    store.controls.pauseAt = 'grant'; store.controls.pause = () => { entered(); return new Promise(r => { release=r; }); };
    const first = service.fulfill({ orderId: a.id,buyerId: 1 }); await started;
    await assert.rejects(service.fulfill({ orderId: b.id,buyerId: 2 }), { code: 'PAYSTACK_NG_BUSY' });
    assert.equal(store.state().allocations.length,0);
    release(); assert.equal((await first).ordinal,100);
    store.controls.pauseAt=null;
    assert.equal((await service.fulfill({ orderId: b.id,buyerId: 2 })).ordinal,101);
    assert.deepEqual(store.state().allocations.map(a => a.scholarMinor),[105000,75000]);
});
test('every financial write failure rolls back evidence, entitlement, ordinal and allocation together', async () => {
    for (const failAt of ['saveEvidence','grant','allocate','advance','complete','commit']) {
        const { service,store } = setup(historical(99)), o = await service.createOrder(request()), before = store.state();
        store.controls.failAt=failAt;
        await assert.rejects(service.fulfill({ orderId: o.id,buyerId: 1 }), { code: 'SYNTHETIC_DB_FAILURE' });
        assert.deepEqual(store.state(),before,failAt);
        store.controls.failAt=null;
        assert.equal((await service.fulfill({ orderId: o.id,buyerId: 1 })).ordinal,100);
    }
});
test('wrong offering, duplicate transaction, missing provider and wrong scope do not grant value', async () => {
    const { service,store,provider } = setup();
    const a=await service.createOrder(request(1)), b=await service.createOrder(request(2));
    await service.fulfill({ orderId: a.id,buyerId: 1 });
    provider.patch={ transactionId: 'transaction_1' };
    const before=store.state();
    await assert.rejects(service.fulfill({ orderId: b.id,buyerId: 2 }), { code: 'ER_DUP_ENTRY' });
    assert.deepEqual(store.state(),before);
    provider.patch={}; store.controls.approved=false;
    await assert.rejects(service.fulfill({ orderId: b.id,buyerId: 2 }), { code: 'OFFERING_UNAVAILABLE' });
    store.controls.approved=true; provider.kind='live-client';
    await assert.rejects(service.fulfill({ orderId: b.id,buyerId: 2 }), { code: 'OFFLINE_PROVIDER_REQUIRED' });
    const other=createServices({ writerPolicy:require('./fixtures/courseWriterPolicy.cjs')(), store,provider,policy: createPolicy({ enabled: true,merchantAccount: 'other' }),now: () => time });
    await assert.rejects(other.fulfill({ orderId: b.id,buyerId: 2 }), { code: 'ORDER_CONTEXT_MISMATCH' });
});
