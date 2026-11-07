'use strict';
// Offline semantic DB double. It is NOT a MySQL locking/DDL qualification.
const { RULE } = require('../../src/services/paystackNigeria/policy');
const { fiveMonths } = require('../../src/services/paystackNigeria/services');
const copy = value => structuredClone(value);
const pair = (s, c) => `${s}:${c}`;
function createMemoryStore(initial = {}) {
    let state = { purchases: [], proofs: [], orders: [], evidence: [], allocations: [], counters: {}, stripeCounters: {}, ...copy(initial) };
    let busy = false;
    const controls = { failAt: null, pauseAt: null, pause: null, approved: true, zone: '+00:00' };
    const trip = async name => {
        if (controls.pauseAt === name) await controls.pause();
        if (controls.failAt === name) throw Object.assign(new Error('synthetic database failure'), { code: 'SYNTHETIC_DB_FAILURE' });
    };
    return {
        controls,
        state: () => copy(state),
        edit: work => { if (busy) throw Error('test cannot edit active transaction'); work(state); },
        readOrder: async id => copy(state.orders.find(o => o.id === id)),
        async transaction(work) {
            if (busy) throw Object.assign(new Error('busy'), { code: 'PAYSTACK_NG_BUSY' });
            busy = true;
            const draft = copy(state);
            try {
                const result = await work({
                    lockSubject: async () => {},
                    offering: async () => { if (!controls.approved) throw Object.assign(Error('unavailable'), { code: 'OFFERING_UNAVAILABLE' }); return { currency: 'NGN', totalMinor: 150000, entity: RULE.entity, policyVersion: RULE.version,universityId:55,countryId:9,countryCode:'NG',offeringRevision:1,routeRevision:'country-course-v1',...controls.academic }; },
                    buyerExists: async id => id !== 9999,
                    existingPurchase: async (b,s,c) => draft.purchases.some(p => p.buyerId === b && p.subjectId === s && p.scholarId === c),
                    existingOrder: async (b,s,c) => copy(draft.orders.find(o => o.buyerId === b && o.subjectId === s && o.scholarId === c)),
                    requestOrder: async (b,k,m,e) => copy(draft.orders.find(o => o.buyerId === b && o.idempotencyKey === k && o.merchantAccount === m && o.environment === e)),
                    insertOrder: async o => { draft.orders.push(copy(o)); await trip('insertOrder'); },
                    order: async id => copy(draft.orders.find(o => o.id === id)),
                    lockLifetime: async (s,c) => ({ counter: copy(draft.counters[pair(s,c)]), stripeCounter: draft.stripeCounters[pair(s,c)] ?? null }),
                    lifetimeSnapshot:async(s,c)=>({counter:copy(draft.counters[pair(s,c)]),stripeCounter:draft.stripeCounters[pair(s,c)]??null}),
                    transportGuard:async(o,e)=>{if(controls.transportGuard)await controls.transportGuard(o,e);else throw Error('Transport guard fixture required');},
                    sales: async (s,c) => copy(draft.purchases.filter(p => p.subjectId === s && p.scholarId === c)),
                    allocations: async (s,c) => copy(draft.allocations.filter(a => a.subjectId === s && a.scholarId === c)),
                    historicalProofs: async rows => copy(draft.proofs.filter(p => rows.some(r => r.id === p.purchaseId))),
                    saveEvidence: async (o,e) => {
                        if (draft.evidence.some(p => p.transactionId === e.transactionId && p.merchantAccount === o.merchantAccount && p.environment === o.environment)) throw Object.assign(Error('duplicate'), { code: 'ER_DUP_ENTRY' });
                        draft.evidence.push({ ...copy(e), merchantAccount: o.merchantAccount, environment: o.environment }); await trip('saveEvidence');
                    },
                    evidence: async id => copy(draft.evidence.find(e => e.orderId === id)),
                    grant: async (o,e) => {
                        const id = Math.max(0,...draft.purchases.map(p => p.id)) + 1;
                        draft.purchases.push({ id, buyerId: o.buyerId, subjectId: o.subjectId, scholarId: o.scholarId,
                            currency: 'NGN', amountMinor: 150000, transactionId: e.reference, createdAt: e.paidAt*1000, expiresAt: fiveMonths(e.paidAt), active: true });
                        await trip('grant'); return id;
                    },
                    allocate: async (o,p,s) => { draft.allocations.push({ ...copy(s), orderId: o.id, purchaseId: p, subjectId: o.subjectId, scholarId: o.scholarId, reference: o.reference, payoutState: 'held' }); await trip('allocate'); },
                    appendSaleProof:async()=>trip('appendSaleProof'),
                    advance: async (o,b,n,existing) => {
                        draft.counters[pair(o.subjectId,o.scholarId)] = { historicalSales: b.historicalSales, ngSales: b.ngSales+1, successfulSales: n };
                        if (existing !== null) draft.stripeCounters[pair(o.subjectId,o.scholarId)] = n;
                        await trip('advance');
                    },
                    complete: async (o,p) => { Object.assign(draft.orders.find(r => r.id === o.id), { state: 'fulfilled', purchaseId: p }); await trip('complete'); },
                });
                await trip('commit'); state = draft; return result;
            } finally { busy = false; }
        },
        async earnings(scholarId) {
            const rows = state.allocations.filter(a => a.scholarId === scholarId);
            return { currency: 'NGN', sales: rows.length, grossMinor: rows.reduce((n,a) => n+a.grossMinor,0),
                scholarMinor: rows.reduce((n,a) => n+a.scholarMinor,0), platformGrossMinor: rows.reduce((n,a) => n+a.platformGrossMinor,0), payoutState: 'held' };
        },
    };
}
function historical(count, subjectId = 10, scholarId = 20) {
    const purchases = [], proofs = [];
    for (let n=1; n<=count; n++) {
        const currency = n%2 ? 'EUR' : 'NGN';
        const p = { id: n, buyerId: 1000+n, subjectId, scholarId, currency, amountMinor: currency === 'EUR' ? 600 : 150000, transactionId: 'historical_' + n };
        purchases.push(p);
        proofs.push({ purchaseId: n, ordinal: n, verified: true, provider: n%2 ? 'stripe' : 'other-reviewed-provider', provenance: 'synthetic-audited-sale', reference: p.transactionId, currency, amountMinor: p.amountMinor });
    }
    return { purchases, proofs };
}
module.exports = { createMemoryStore, historical };
