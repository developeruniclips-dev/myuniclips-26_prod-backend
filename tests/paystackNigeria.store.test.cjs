'use strict';
// Scripted database/SQL contract tests only. No mysql package, socket or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const { createMysqlStore } = require('../src/services/paystackNigeria/store');
const { statements } = require('../src/services/paystackNigeria/schema');
const { RULE } = require('../src/services/paystackNigeria/policy');
const { metadata } = require('./fixtures/paystackNigeriaMetadata.cjs');
function fixture(handler = async () => [[]], overrides = {}, schemaMetadata = metadata()) {
    const events = [];
    const db = {
        async query(sql,args=[]) { events.push({ sql,args }); if (sql.includes('@@session.time_zone')) return [[{ zone: '+00:00' }]]; return handler(sql,args); },
        async beginTransaction() { events.push('begin'); }, async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); }, release() { events.push('release'); }, destroy() { events.push('destroy'); }, ...overrides,
    };
    const pool = { async getConnection() { events.push('acquire'); return db; } };
    return { events,db,store: createMysqlStore({ pool,resolveHistoricalSales: async () => [],schemaMetadata }) };
}
const order = { id: '00000000-0000-4000-8000-000000000001',buyerId: 1,subjectId: 10,scholarId: 20,
    merchantAccount: 'synthetic-merchant',environment: 'test',entity: RULE.entity,reference: 'synthetic-reference',
    idempotencyKey: 'synthetic-request',currency: 'NGN',totalMinor: 150000,policyVersion: RULE.version,accessMonths: 5,createdAt: Date.UTC(2026,10,6) };
const evidence = { transactionId: 'synthetic-tx',reference: order.reference,currency: 'NGN',amountMinor: 150000,feesMinor: 3000,paidAt: order.createdAt/1000,evidenceDigest: 'a'.repeat(64) };
test('preview CLI emits seven additive proposed tables, rejects --apply, and imports no DB driver', () => {
    assert.equal(statements.length,7);
    for (const sql of statements) {
        assert.match(sql,/^CREATE TABLE paystack_ng_/);
        assert.doesNotMatch(sql,/\b(ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
    }
    const script=path.resolve(__dirname,'../scripts/previewPaystackNigeria.cjs');
    const good=cp.spawnSync(process.execPath,[script],{ encoding: 'utf8',env: { PATH: process.env.PATH,SystemRoot: process.env.SystemRoot },timeout: 5000,windowsHide: true });
    assert.equal(good.status,0); assert.equal((good.stdout.match(/CREATE TABLE/g)||[]).length,7);
    const bad=cp.spawnSync(process.execPath,[script,'--apply'],{ encoding: 'utf8',env: { PATH: process.env.PATH,SystemRoot: process.env.SystemRoot },timeout: 5000,windowsHide: true });
    assert.equal(bad.status,2); assert.equal(bad.stdout,''); assert.match(bad.stderr,/PREVIEW_ONLY/);
    assert(!Object.keys(require.cache).some(p => /[\\/]mysql2[\\/]|[\\/]dotenv[\\/]|[\\/]config[\\/]db\.js$/.test(p)));
});
test('schema uniqueness binds reference/event/transaction context, purchase and global ordinal', () => {
    const all=statements.join('\n');
    assert.match(all,/UNIQUE KEY order_entitlement \(buyer_id,subject_id,scholar_id\)/);
    assert.match(all,/UNIQUE KEY transaction_id \(merchant_account,environment,provider_transaction_id\)/);
    assert.match(all,/UNIQUE KEY event_once \(merchant_account,environment,event_key\)/);
    assert.match(all,/UNIQUE KEY allocated_ordinal \(subject_id,scholar_id,sale_ordinal\)/);
    assert.match(all,/CHECK \(successful_sales=historical_verified_sales\+ng_successful_sales\)/);
    assert.match(all,/CHECK \(payout_state='held'\)/);
    assert.doesNotMatch(all,/CREATE TABLE (?:payment_transfers|scholar_payouts)/);
});
test('SQL adapter uses one UTC transaction, explicit grant/allocate/counter/completion and no automatic payout writes', async () => {
    const f=fixture(async sql => {
        if (/INSERT INTO subject_purchases/.test(sql)) return [{ insertId: 7 }];
        if (/UPDATE paystack_ng_orders/.test(sql)) return [{ affectedRows: 1 }];
        return [[]];
    });
    await f.store.transaction(async tx => {
        await tx.insertOrder(order); await tx.saveEvidence(order,evidence);
        const purchaseId=await tx.grant(order,evidence); assert.equal(purchaseId,7);
        await tx.allocate(order,purchaseId,{ ordinal: 101,currency: 'NGN',grossMinor: 150000,scholarRate: 50,scholarMinor: 75000,platformGrossMinor: 75000 });
        await tx.advance(order,{ historicalSales: 99,ngSales: 1 },101,100);
        await tx.complete(order,purchaseId);
    });
    assert.equal(f.events.filter(x => x==='acquire').length,1);
    assert.deepEqual(f.events.filter(x => typeof x==='string'),['acquire','begin','commit','release']);
    const queries=f.events.filter(x => x.sql);
    const grant=queries.find(x => /INSERT INTO subject_purchases/.test(x.sql));
    assert.match(grant.sql,/DATE_ADD\(FROM_UNIXTIME\(\?\),INTERVAL 5 MONTH\)/);
    assert.deepEqual(grant.args,[1,10,20,order.reference,evidence.paidAt,evidence.paidAt]);
    const writes=queries.filter(x => /^\s*(INSERT|UPDATE)/i.test(x.sql));
    assert(!writes.some(x => /(?:INTO|UPDATE)\s+(?:scholar_payouts|payment_transfers|payment_orders|payment_allocations)\b/i.test(x.sql)));
    assert.equal(writes.filter(x => /UPDATE payment_sale_counters/.test(x.sql)).length,1);
    assert(writes.some(x => /'held'/.test(x.sql)));
});
test('transaction failure, commit uncertainty and begin failure always release; no automatic retry', async () => {
    for (const stage of ['work','begin','commit']) {
        const error=Object.assign(Error('synthetic fault'),{ code: 'SYNTHETIC_SQL_FAILURE' });
        const overrides={};
        if (stage==='begin') overrides.beginTransaction=async () => { throw error; };
        if (stage==='commit') overrides.commit=async () => { throw error; };
        const f=fixture(undefined,overrides);
        await assert.rejects(f.store.transaction(async () => { if (stage==='work') throw error; }), { code: error.code });
        assert.equal(f.events.filter(x => x==='acquire').length,1);
        assert.equal(f.events.at(-1),stage === 'begin' ? 'destroy' : 'release');
        assert.equal(f.events.includes('rollback'),stage!=='begin');
    }
    const f=fixture();
    await assert.rejects(f.store.transaction(async () => { throw Object.assign(Error('lock'),{ code: 'ER_LOCK_NOWAIT' }); }), { code: 'PAYSTACK_NG_BUSY' });
    assert.equal(f.events.filter(x => x==='acquire').length,1);
});
test('wrong database time zone fails before transaction or writes and releases connection', async () => {
    const f=fixture(undefined,{ query: async () => [[{ zone: 'SYSTEM' }]] });
    await assert.rejects(f.store.transaction(async () => assert.fail('work must not start')), { code: 'UTC_SESSION_REQUIRED' });
    await assert.rejects(f.store.readOrder(order.id), { code: 'UTC_SESSION_REQUIRED' });
    assert.equal(f.events.filter(x => x==='release').length,2);
});
test('baseline lock uses verified counter presence; unexpected missing table fails rather than silently changing mode', async () => {
    for (const present of [true,false]) {
        const f=fixture(async sql => {
            if (/payment_sale_counters/.test(sql)) {
                if (!present) throw Object.assign(Error('missing'),{ code: 'ER_NO_SUCH_TABLE' });
                return [[{ successful_sales: '99' }]];
            }
            if (/FROM subjects/.test(sql)) return [[{ id: 10 }]];
            if (/FROM paystack_ng_sale_counters/.test(sql)) return [[{ historical_verified_sales: '98',ng_successful_sales: '1',successful_sales: '99' }]];
            return [[]];
        }, {}, metadata(present));
        await f.store.transaction(async tx => {
            await tx.lockSubject(10);
            const result=await tx.lockLifetime(10,20);
            assert.equal(result.stripeCounter,present?99:null);
            assert.deepEqual(result.counter,{ historicalSales: 98,ngSales: 1,successfulSales: 99 });
        });
        const queries=f.events.filter(x => x.sql);
        assert(queries.some(x => /subjects.*FOR UPDATE NOWAIT/.test(x.sql)));
        assert.equal(queries.some(x => /payment_sale_counters.*FOR UPDATE NOWAIT/.test(x.sql)),present);
    }
    const f=fixture(async () => { throw Object.assign(Error('timeout'),{ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }); });
    await assert.rejects(f.store.transaction(tx => tx.lockLifetime(10,20)), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
    assert(!f.events.includes('commit'));
    const absent=fixture(async () => { throw Object.assign(Error('unexpected missing'),{ code: 'ER_NO_SUCH_TABLE' }); });
    await assert.rejects(absent.store.transaction(tx => tx.lockLifetime(10,20)),{ code: 'ER_NO_SUCH_TABLE' });
});
test('first shared-counter initialization includes ALL purchase currencies and is rolled back on failed proof', async () => {
    let selections=0;
    const f=fixture(async sql => {
        if (/SELECT successful_sales FROM payment_sale_counters/.test(sql)) return selections++ ? [[{ successful_sales: 99 }]] : [[]];
        if (/FROM paystack_ng_sale_counters/.test(sql)) return [[]];
        return [[]];
    });
    await assert.rejects(f.store.transaction(async tx => {
        await tx.lockLifetime(10,20);
        throw Object.assign(Error('no proof'),{ code: 'BASELINE_VERIFICATION_REQUIRED' });
    }), { code: 'BASELINE_VERIFICATION_REQUIRED' });
    const initialization=f.events.find(x => x.sql?.includes('INSERT INTO payment_sale_counters'));
    assert(initialization); assert.doesNotMatch(initialization.sql,/currency|provider/);
    assert.deepEqual(initialization.args,[10,20,10,20]); assert(f.events.includes('rollback'));
});
test('purchase census preserves currencies and refuses overflow before proof/ledger work', async () => {
    const f=fixture(async sql => {
        if (/FROM subject_purchases/.test(sql)) return [[{ id: 1,amount: '6.00',currency: 'EUR',transaction_id: 'synthetic-eur' },{ id: 2,amount: '1500.00',currency: 'NGN',transaction_id: 'synthetic-ngn' }]];
        return [[]];
    });
    const rows=await f.store.transaction(tx => tx.sales(10,20));
    assert.deepEqual(rows.map(x => x.amountMinor),[600,150000]);
    const query=f.events.find(x => x.sql?.includes('FROM subject_purchases'));
    assert.match(query.sql,/WHERE subject_id=\? AND scholar_id=\?/); assert.match(query.sql,/LIMIT 10001/);
    const large=fixture(async () => [Array(10001).fill({ id: 1 })]);
    await assert.rejects(large.store.transaction(tx => tx.sales(10,20)), { code: 'BASELINE_REVIEW_REQUIRED' });
});
test('historical resolver receives same-transaction SELECT interface; no implicit verification', async () => {
    assert.throws(() => createMysqlStore({ pool: { getConnection() {} } }), { code: 'STORE_DEPENDENCIES_REQUIRED' });
    let seen;
    const db={ query: async sql => sql.includes('@@session.time_zone') ? [[{ zone: '+00:00' }]] : [[]],beginTransaction: async () => {},commit: async () => {},rollback: async () => {},release() {} };
    const store=createMysqlStore({ pool: { getConnection: async () => db },schemaMetadata: metadata(),resolveHistoricalSales: async (reader,rows,scope) => {
        seen={ rows,scope };
        assert.throws(() => reader.query('UPDATE subject_purchases SET amount=0'),{ code: 'HISTORICAL_RESOLVER_READ_ONLY' });
        await reader.query('SELECT id FROM subject_purchases WHERE id=?',[1]);
        return [];
    } });
    await store.transaction(tx => tx.historicalProofs([{ id: 1 }],{ subjectId: 10,scholarId: 20 }));
    assert.deepEqual(seen,{ rows: [{ id: 1 }],scope: { subjectId: 10,scholarId: 20 } });
});
test('NGN earnings query reads only held Paystack allocations and preserves minor units', async () => {
    const f=fixture(async () => [[{ sales: '2',gross: '300000',scholar: '180000',platform: '120000' }]]);
    assert.deepEqual(await f.store.earnings(20),{ currency: 'NGN',sales: 2,grossMinor: 300000,scholarMinor: 180000,platformGrossMinor: 120000,payoutState: 'held' });
    const query=f.events.find(x => x.sql);
    assert.match(query.sql,/paystack_ng_allocations.*WHERE scholar_id=\? AND currency='NGN'/s);
    assert.doesNotMatch(query.sql,/scholar_payouts|payment_allocations\b/);
    assert.equal(f.events.at(-1),'release');
});
