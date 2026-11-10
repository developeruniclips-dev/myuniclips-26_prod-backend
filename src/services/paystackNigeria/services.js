'use strict';
const { randomUUID } = require('node:crypto');
const { createPolicy, id, amount, share, fail } = require('./policy');
const { lifetimeBaseline } = require('./baseline');
function uuid(value) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) fail('INVALID_ORDER_ID'); }
function fiveMonths(epoch) {
    const start = new Date(epoch * 1000), day = start.getUTCDate();
    start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() + 5);
    const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, last));
    return start.getTime();
}
function createServices({ store, provider, policy = createPolicy(), now = Date.now, newId = randomUUID, writerPolicy = require('../coursePayments/writerPolicy').createWriterPolicy() } = {}) {
    if (!store) fail('STORE_REQUIRED');
    const context = o => {
        if (!o || o.merchantAccount !== policy.merchantAccount || o.environment !== policy.environment ||
            o.entity !== policy.entity || o.policyVersion !== policy.version || o.accessMonths !== 5) fail('ORDER_CONTEXT_MISMATCH');
        amount(o.totalMinor, o.currency);
    };
    async function offering(tx, subjectId, scholarId) {
        const row = await tx.offering(subjectId, scholarId, policy.merchantAccount, policy.environment);
        if (row.entity !== policy.entity || row.policyVersion !== policy.version) fail('OFFERING_POLICY_MISMATCH');
        amount(row.totalMinor, row.currency);
        if(!Number.isSafeInteger(row.universityId)||!Number.isSafeInteger(row.countryId)||row.countryCode!=='NG'||!Number.isSafeInteger(row.offeringRevision)||!row.routeRevision)fail('OFFERING_CONTEXT_REQUIRED');
        return row;
    }
    function receipt(o, e) {
        if (!e || e.verified !== true || e.status !== 'success' || e.reference !== o.reference ||
            e.refundedMinor !== 0 || e.disputed !== false ||
            e.orderId !== o.id || e.buyerId !== o.buyerId || e.subjectId !== o.subjectId || e.scholarId !== o.scholarId ||
            e.merchantAccount !== o.merchantAccount || e.environment !== o.environment ||
            typeof e.transactionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(e.transactionId) ||
            !/^[a-f0-9]{64}$/.test(e.evidenceDigest || '') || e.totalChargedMinor !== policy.totalMinor) fail('PAYMENT_EVIDENCE_MISMATCH');
        amount(e.amountMinor, e.currency);
        share(1, e.feesMinor); // Validate fees without guessing the lifetime tier.
        if (!Number.isSafeInteger(e.paidAt) || e.paidAt <= 0 || e.paidAt > Math.floor(now()/1000) ||
            e.paidAt < Math.floor(o.createdAt/1000) || (o.state !== 'fulfilled' && fiveMonths(e.paidAt) <= now())) fail('PAYMENT_TIME_REQUIRES_REVIEW');
    }
    return {
        async inspectOffering(subjectId,scholarId){
            policy.assertEnabled();id(subjectId);id(scholarId);await writerPolicy.assertSafe();
            return store.transaction(async tx=>{
                await tx.lockSubject(subjectId);const academic=await offering(tx,subjectId,scholarId);
                const locked=await tx.lifetimeSnapshot(subjectId,scholarId),purchases=await tx.sales(subjectId,scholarId),ownAllocations=await tx.allocations(subjectId,scholarId);
                const own=new Set(ownAllocations.map(r=>r.purchaseId)),historicalProofs=await tx.historicalProofs(purchases.filter(r=>!own.has(r.id)),{subjectId,scholarId});
                lifetimeBaseline({purchases,ownAllocations,historicalProofs,...locked});await writerPolicy.assertSafe();return academic;
            });
        },
        async createOrder({ buyerId, subjectId, scholarId, idempotencyKey, totalMinor = policy.totalMinor, currency = policy.currency }) {
            policy.assertEnabled(); [buyerId,subjectId,scholarId].forEach(id); amount(totalMinor,currency);
            if (buyerId === scholarId) fail('SELF_PURCHASE_BLOCKED');
            if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) fail('INVALID_IDEMPOTENCY_KEY');
            return store.transaction(async tx => {
                await tx.lockSubject(subjectId);
                if (!await tx.buyerExists(buyerId)) fail('BUYER_NOT_FOUND');
                const academic=await offering(tx,subjectId,scholarId);
                const previous = await tx.requestOrder(buyerId,idempotencyKey,policy.merchantAccount,policy.environment);
                if (previous) {
                    context(previous);
                    if (previous.subjectId !== subjectId || previous.scholarId !== scholarId) fail('IDEMPOTENCY_CONTEXT_MISMATCH');
                    return previous;
                }
                if (await tx.existingPurchase(buyerId,subjectId,scholarId)) fail('REPURCHASE_BLOCKED');
                if (await tx.existingOrder(buyerId,subjectId,scholarId)) fail('ORDER_ALREADY_EXISTS');
                const orderId = newId(); uuid(orderId);
                const o = { id: orderId, buyerId, subjectId, scholarId, idempotencyKey, reference: 'psng-' + orderId,
                    universityId:academic.universityId,countryId:academic.countryId,countryCode:academic.countryCode,offeringRevision:academic.offeringRevision,routeRevision:academic.routeRevision,
                    merchantAccount: policy.merchantAccount, environment: policy.environment, entity: policy.entity,
                    totalMinor: policy.totalMinor, currency: policy.currency, policyVersion: policy.version,
                    accessMonths: 5, state: 'created', createdAt: Math.floor(now()/1000)*1000, purchaseId: null };
                await tx.insertOrder(o);
                return o; // No hosted checkout, provider call or initiation occurs.
            });
        },
        async fulfill({ orderId, buyerId }) {
            policy.assertEnabled(); uuid(orderId); id(buyerId);
            await writerPolicy.assertSafe();
            const snapshot = await store.readOrder(orderId);
            if (!snapshot || snapshot.buyerId !== buyerId) fail('ORDER_NOT_FOUND');
            context(snapshot);
            const authenticated=require('./provider').isProvider(provider);
            if (!provider || !authenticated&&provider.kind !== 'offline-double' || typeof provider.verify !== 'function') fail('OFFLINE_PROVIDER_REQUIRED');
            let e;
            try { e = await provider.verify(snapshot.reference,snapshot); } catch(error) { if(authenticated)throw error;fail('PAYMENT_EVIDENCE_UNAVAILABLE'); }
            e = e && { ...e, feesMinor: e.feesMinor ?? null };
            receipt(snapshot,e); // Provider double settles before acquiring transaction locks.
            await writerPolicy.assertSafe();
            return store.transaction(async tx => {
                // Exclusive verified-legacy mode only: serialize the entire
                // census with the legacy verifier's existing subject-row lock.
                await tx.lockSubject(snapshot.subjectId);
                const locked = snapshot.state === 'fulfilled' ? null : await tx.lockLifetime(snapshot.subjectId,snapshot.scholarId);
                const o = await tx.order(orderId); context(o);
                if(authenticated)await tx.transportGuard(o,e);
                if (o.buyerId !== buyerId || o.subjectId !== snapshot.subjectId || o.scholarId !== snapshot.scholarId || o.reference !== snapshot.reference) fail('ORDER_CONTEXT_MISMATCH');
                if (o.state === 'fulfilled') {
                    const stored = await tx.evidence(orderId);
                    if (!stored || stored.transactionId !== e.transactionId || stored.reference !== e.reference) fail('PAYMENT_EVIDENCE_MISMATCH');
                    return { orderId, purchaseId: o.purchaseId, state: 'fulfilled', replay: true };
                }
                if (o.state !== 'created') fail('ORDER_REQUIRES_REVIEW');
                if (!locked) fail('ORDER_STATE_CHANGED');
                const academic=await offering(tx,o.subjectId,o.scholarId);
                if(['universityId','countryId','countryCode','offeringRevision','routeRevision'].some(k=>academic[k]!==o[k]))fail('ORDER_CONTEXT_CHANGED');
                if (await tx.existingPurchase(buyerId,o.subjectId,o.scholarId)) fail('REPURCHASE_BLOCKED');
                const purchases = await tx.sales(o.subjectId,o.scholarId);
                const ownAllocations = await tx.allocations(o.subjectId,o.scholarId);
                const ownIds = new Set(ownAllocations.map(row => row.purchaseId));
                const historicalProofs = await tx.historicalProofs(purchases.filter(row => !ownIds.has(row.id)), { subjectId: o.subjectId, scholarId: o.scholarId });
                const baseline = lifetimeBaseline({ purchases, ownAllocations, historicalProofs, ...locked });
                const s = share(baseline.successfulSales + 1,e.feesMinor);
                await tx.saveEvidence(o,e);
                const purchaseId = await tx.grant(o,e);
                await tx.allocate(o,purchaseId,s);
                await tx.appendSaleProof(o,purchaseId,s,e);
                await tx.advance(o,baseline,s.ordinal,locked.stripeCounter);
                await writerPolicy.assertSafe();
                await tx.complete(o,purchaseId);
                return { orderId, purchaseId, state: 'fulfilled', ordinal: s.ordinal,
                    scholarMinor: s.scholarMinor, currency: 'NGN', payoutState: 'held', replay: false };
            });
        },
        async earnings(scholarId) { policy.assertEnabled(); id(scholarId); return store.earnings(scholarId); },
    };
}
module.exports = { createServices, fiveMonths };
