const { createHmac, timingSafeEqual, randomUUID, createHash } = require('crypto');
const { toMinor, decimal, allocation } = require('../payments/money');
const { scholarContext } = require('../../utils/academicContext');
const { TYPE } = require('./stripeProvider');
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const same = (a, b) => String(a) === String(b);
const key = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
const instructionSql = `JSON_EXTRACT(CASE WHEN JSON_VALID(description) THEN description ELSE '{}' END,'$.purchaseId')=?
    AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(description) THEN description ELSE '{}' END,'$.kind'))=?`;

function createReleaseService({ pool, provider, signingSecret }) {
    const signature = snapshot => {
        if (!signingSecret) fail('Payment signing configuration is unavailable.', 503);
        return createHmac('sha256', signingSecret).update('uniclips:legacy_verified:v1\0').update(JSON.stringify(snapshot)).digest('hex');
    };
    function ticket(session) {
        let snapshot;
        try { snapshot = JSON.parse(session.metadata?.snapshot); } catch { fail('Payment requires manual review.'); }
        const supplied = session.metadata?.signature;
        if (!/^[a-f0-9]{64}$/.test(supplied || '') || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(snapshot), 'hex')))
            fail('Payment signature does not match.');
        if (snapshot.version !== 1 || ![snapshot.buyerId, snapshot.subjectId, snapshot.scholarId, snapshot.universityId].every(positive) ||
            !Number.isSafeInteger(snapshot.amountMinor) || snapshot.amountMinor < 50 || snapshot.currency !== 'EUR' ||
            !/^[a-f0-9-]{36}$/.test(snapshot.nonce || '') || typeof snapshot.account !== 'string' || typeof snapshot.livemode !== 'boolean')
            fail('Invalid payment context.');
        return snapshot;
    }
    async function locked(name, work) {
        const db = await pool.getConnection(); let acquired = false;
        try {
            const [[lock]] = await db.query('SELECT GET_LOCK(?,10) AS acquired', [name]);
            acquired = Number(lock.acquired) === 1;
            if (!acquired) fail('Payment is being processed. Please retry.');
            return await work(db);
        } finally { try { if (acquired) await db.query('SELECT RELEASE_LOCK(?)', [name]); } finally { db.release(); } }
    }
    async function course(db, subjectId, scholarId, lock = false) {
        const [[row]] = await db.query(`SELECT s.*,c.code AS country_code FROM subjects s JOIN universities u ON u.id=s.university_id
            JOIN countries c ON c.id=u.country_id WHERE s.id=?${lock ? ' FOR UPDATE' : ''}`, [subjectId]);
        if (!row) fail('Course offering not found.', 404);
        if (row.country_code !== 'FI') fail('Course payments are not currently available for this market.');
        const context = await scholarContext(db, scholarId);
        const [[offering]] = await db.query('SELECT id FROM scholar_subjects WHERE subject_id=? AND scholar_user_id=? AND approved=1', [subjectId, scholarId]);
        const [[content]] = await db.query('SELECT id FROM videos WHERE subject_id=? AND scholar_user_id=? AND approved=1 LIMIT 1', [subjectId, scholarId]);
        if (!context?.approved || context.country_code !== 'FI' || !same(context.university_id, row.university_id) ||
            context.degree !== row.degree_programmes || !offering || !content) fail('Course offering is not available.');
        return { ...row, destination: context.stripe_account_id || null };
    }
    async function createOrder(buyerId, subjectId, scholarId) {
        if (![buyerId, subjectId, scholarId].every(positive)) fail('Invalid offering.', 400);
        if (same(buyerId, scholarId)) fail('You already own this course.', 400);
        return locked(`lv_checkout:${key(`${buyerId}:${subjectId}:${scholarId}`)}`, async db => {
            const offering = await course(db, subjectId, scholarId);
            const [[buyer]] = await db.query('SELECT id FROM users WHERE id=?', [buyerId]);
            if (!buyer) fail('Learner not found.', 404);
            const [[existing]] = await db.query('SELECT id FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=?', [buyerId, subjectId, scholarId]);
            if (existing) fail('This course has already been purchased.');
            const amount = toMinor(offering.bundle_price, 'EUR');
            if (amount < 50) fail('This offering has no valid paid price.');
            const identity = await provider.identity();
            if (!identity.account || typeof identity.livemode !== 'boolean') fail('Cannot verify payment provider.', 503);
            const snapshot = { version: 1, nonce: randomUUID(), buyerId: Number(buyerId), subjectId: Number(subjectId), scholarId: Number(scholarId),
                universityId: Number(offering.university_id), amountMinor: amount, currency: 'EUR', account: identity.account,
                livemode: identity.livemode, destination: offering.destination };
            if (JSON.stringify(snapshot).length > 500) fail('Payment context is too long.', 503);
            const session = await provider.createCheckout(snapshot, signature(snapshot), offering.name);
            return { sessionId: session.id, url: session.url, amount: decimal(amount), currency: 'EUR' };
        });
    }
    function evidenceMatches(evidence, snapshot, sessionId) {
        const { session: s, identity, payment: p, charge } = evidence;
        if (s.id !== sessionId || identity.account !== snapshot.account || identity.livemode !== snapshot.livemode ||
            s.livemode !== snapshot.livemode || s.mode !== 'payment' || s.client_reference_id !== snapshot.nonce ||
            s.amount_total !== snapshot.amountMinor || s.currency?.toUpperCase() !== 'EUR') fail('Payment does not match the server checkout.');
        if (s.payment_status !== 'paid') return false;
        if (!p?.id || p.status !== 'succeeded' || p.amount_received !== snapshot.amountMinor || p.currency?.toUpperCase() !== 'EUR' ||
            p.livemode !== snapshot.livemode || p.metadata?.type !== TYPE || p.metadata?.snapshot !== s.metadata.snapshot ||
            p.metadata?.signature !== s.metadata.signature || !charge?.id || !charge.paid || charge.payment_intent !== p.id ||
            charge.amount !== snapshot.amountMinor || charge.currency?.toUpperCase() !== 'EUR' || charge.livemode !== snapshot.livemode ||
            !Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.amount_refunded > 0 || charge.disputed)
            fail('Successful payment could not be verified.');
        return true;
    }
    async function result(db, purchase) {
        const [[access]] = await db.query('SELECT is_access_active AND (access_expires_at IS NULL OR access_expires_at>NOW()) AS active FROM subject_purchases WHERE id=?', [purchase.id]);
        return { success: true, state: 'fulfilled', orderId: `legacy_${purchase.id}`, subjectId: purchase.subject_id,
            scholarId: purchase.scholar_id, accessActive: Boolean(access.active) };
    }
    async function historical(evidence, buyerId, sessionId) {
        const { session: s, identity, payment: p, charge } = evidence;
        const m = s.metadata || {};
        if (s.id !== sessionId || m.type !== 'subject_bundle' || ![m.buyerId, m.subjectId, m.scholarId].every(positive) ||
            (buyerId != null && !same(m.buyerId, buyerId))) fail('Old payment requires manual review.');
        if (s.mode !== 'payment' || s.payment_status !== 'paid' || s.livemode !== identity.livemode || s.currency?.toUpperCase() !== 'EUR' ||
            !p?.id || p.status !== 'succeeded' || p.livemode !== identity.livemode || p.amount_received !== s.amount_total ||
            p.currency?.toUpperCase() !== 'EUR' || !charge?.paid || charge.livemode !== identity.livemode || charge.payment_intent !== p.id ||
            charge.amount !== s.amount_total || charge.currency?.toUpperCase() !== 'EUR') fail('Old payment could not be verified.');
        const [[purchase]] = await pool.query(`SELECT sp.* FROM subject_purchases sp JOIN subjects s ON s.id=sp.subject_id
            JOIN universities u ON u.id=s.university_id JOIN countries c ON c.id=u.country_id WHERE sp.buyer_user_id=? AND sp.subject_id=? AND sp.scholar_id=? AND c.code='FI'`,
        [m.buyerId, m.subjectId, m.scholarId]);
        if (!purchase || ![p.id, s.id].includes(purchase.transaction_id) || purchase.currency?.toUpperCase() !== 'EUR' || toMinor(purchase.amount, 'EUR') !== s.amount_total)
            fail('Old payment requires reconciliation; no purchase or transfer was created.');
        // Never retry a historical automatic transfer whose durable instruction did not exist.
        return { ...await result(pool, purchase), historical: true };
    }
    async function verifySession(sessionId, buyerId) {
        if (typeof sessionId !== 'string' || !/^cs_[a-zA-Z0-9_]+$/.test(sessionId) || sessionId.length > 255) fail('Invalid checkout reference.', 400);
        const evidence = await provider.evidence(sessionId);
        if (evidence.session.metadata?.type !== TYPE) return historical(evidence, buyerId, sessionId);
        const snapshot = ticket(evidence.session);
        if (buyerId != null && !same(snapshot.buyerId, buyerId)) fail('Order not found.', 404);
        if (!evidenceMatches(evidence, snapshot, sessionId)) return { success: false, state: 'pending' };
        return locked(`lv_payment:${key(evidence.payment.id)}`, async db => {
            await db.beginTransaction();
            try {
                // This existing row lock serializes prospective paid sales and transfer intents.
                const [[subject]] = await db.query(`SELECT s.id,s.university_id,c.code FROM subjects s JOIN universities u ON u.id=s.university_id
                    JOIN countries c ON c.id=u.country_id WHERE s.id=? FOR UPDATE`, [snapshot.subjectId]);
                if (!subject || subject.code !== 'FI' || !same(subject.university_id, snapshot.universityId)) fail('Payment academic context requires review.');
                const [[existing]] = await db.query('SELECT * FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=?',
                    [snapshot.buyerId, snapshot.subjectId, snapshot.scholarId]);
                if (existing) {
                    if (existing.transaction_id !== evidence.payment.id || existing.currency?.toUpperCase() !== 'EUR' || toMinor(existing.amount, 'EUR') !== snapshot.amountMinor)
                        fail('Another purchase exists. This payment requires review.');
                    const response = await result(db, existing); await db.commit(); return response;
                }
                await course(db, snapshot.subjectId, snapshot.scholarId);
                const [[count]] = await db.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=? AND scholar_id=?', [snapshot.subjectId, snapshot.scholarId]);
                const ordinal = Number(count.n) + 1, share = allocation(snapshot.amountMinor, ordinal);
                const [insert] = await db.query(`INSERT INTO subject_purchases (buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active)
                    VALUES (?,?,?,?,'EUR',?,FROM_UNIXTIME(?),DATE_ADD(FROM_UNIXTIME(?), INTERVAL 5 MONTH),1)`,
                    [snapshot.buyerId, snapshot.subjectId, snapshot.scholarId, decimal(snapshot.amountMinor), evidence.payment.id, evidence.charge.created, evidence.charge.created]);
                const instruction = { kind: TYPE, purchaseId: insert.insertId, sessionId, paymentId: evidence.payment.id, chargeId: evidence.charge.id,
                    group: `lv_${snapshot.nonce}`, amountMinor: share.scholar, grossMinor: snapshot.amountMinor, currency: 'EUR', rate: share.rate,
                    ordinal, destination: snapshot.destination, account: snapshot.account, livemode: snapshot.livemode };
                await db.query("INSERT INTO scholar_payouts (scholar_user_id,amount,currency,status,description) VALUES (?,?,'eur','pending',?)",
                    [snapshot.scholarId, decimal(share.scholar), JSON.stringify(instruction)]);
                const response = await result(db, { id: insert.insertId, subject_id: snapshot.subjectId, scholar_id: snapshot.scholarId });
                await db.commit(); return response;
            } catch (error) { await db.rollback(); throw error; }
        });
    }
    function transferMatches(t, instruction) {
        return /^tr_[a-zA-Z0-9_]+$/.test(t.id || '') && t.amount === instruction.amountMinor && t.currency?.toUpperCase() === 'EUR' && t.destination === instruction.destination &&
            t.source_transaction === instruction.chargeId && t.transfer_group === instruction.group && !t.reversed &&
            t.metadata?.release === TYPE && same(t.metadata?.instructionId, instruction.id) && same(t.metadata?.purchaseId, instruction.purchaseId);
    }
    async function transferOrder(orderId) {
        if (!/^legacy_\d+$/.test(orderId || '')) fail('Invalid transfer reference.', 400);
        const purchaseId = Number(orderId.slice(7));
        const [instructions] = await pool.query(`SELECT id FROM scholar_payouts WHERE ${instructionSql}`, [purchaseId, TYPE]);
        if (!instructions.length) return { state: 'historical', reason: 'no_new_transfer_instruction' };
        if (instructions.length !== 1) fail('Transfer instructions require reconciliation.');
        return locked(`lv_transfer:${instructions[0].id}`, async db => {
            const [[row]] = await db.query('SELECT * FROM scholar_payouts WHERE id=?', [instructions[0].id]);
            const instruction = { ...JSON.parse(row.description), id: row.id };
            if (row.status === 'completed') return { state: 'completed', transferId: row.stripe_transfer_id };
            if (!['pending', 'uncertain'].includes(row.status)) return { state: row.status, reason: 'manual_reconciliation_required' };
            if (!instruction.destination) return { state: 'pending', reason: 'payout_setup_required' };
            const [[purchase]] = await db.query('SELECT * FROM subject_purchases WHERE id=?', [purchaseId]);
            const [[scholar]] = await db.query('SELECT stripe_account_id,approved FROM scholar_profile WHERE user_id=?', [row.scholar_user_id]);
            if (!purchase || !same(purchase.scholar_id, row.scholar_user_id) || purchase.transaction_id !== instruction.paymentId ||
                purchase.currency?.toUpperCase() !== 'EUR' || toMinor(purchase.amount, 'EUR') !== instruction.grossMinor ||
                toMinor(row.amount, 'EUR') !== instruction.amountMinor || !scholar?.approved || scholar.stripe_account_id !== instruction.destination)
                fail('Transfer ownership/allocation requires review.');
            const evidence = await provider.evidence(instruction.sessionId), snapshot = ticket(evidence.session);
            if (!evidenceMatches(evidence, snapshot, instruction.sessionId) || !same(snapshot.buyerId, purchase.buyer_user_id) ||
                !same(snapshot.subjectId, purchase.subject_id) || !same(snapshot.scholarId, purchase.scholar_id) ||
                instruction.account !== snapshot.account || instruction.livemode !== snapshot.livemode || instruction.chargeId !== evidence.charge.id ||
                instruction.destination !== snapshot.destination || instruction.group !== `lv_${snapshot.nonce}`) fail('Transfer payment requires review.');
            const account = await provider.retrieveAccount(instruction.destination);
            if (account.deleted || account.country !== 'FI' || account.capabilities?.transfers !== 'active' || !account.payouts_enabled)
                return { state: 'pending', reason: 'account_restricted' };
            let transfer;
            if (row.status === 'uncertain') {
                const found = await provider.findReleaseTransfers(instruction.group);
                if (found.length !== 1 || !transferMatches(found[0], instruction)) return { state: 'uncertain', reason: 'manual_reconciliation_required' };
                transfer = found[0];
            } else {
                // Durable marker BEFORE external movement. Even a DB failure afterward cannot
                // cause automatic re-creation, including after provider key retention expires.
                const [marked] = await db.query("UPDATE scholar_payouts SET status='uncertain' WHERE id=? AND status='pending'", [row.id]);
                if (marked.affectedRows !== 1) fail('Transfer state changed; review before retrying.');
                try { transfer = await provider.createReleaseTransfer(instruction); }
                catch { return { state: 'uncertain', reason: 'provider_result_requires_reconciliation' }; }
                if (!transferMatches(transfer, instruction)) fail('Transfer result requires review.');
            }
            await db.query("UPDATE scholar_payouts SET status='completed',stripe_transfer_id=? WHERE id=?", [transfer.id, row.id]);
            return { state: 'completed', transferId: transfer.id };
        });
    }
    async function handleEvent(event) {
        if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return;
        if (event.account) fail('Wrong webhook platform.');
        const session = event.data?.object;
        if (session?.metadata?.type !== TYPE) return { legacyReviewRequired: true };
        const snapshot = ticket(session);
        if (event.livemode !== snapshot.livemode) fail('Wrong webhook mode.');
        const response = await verifySession(session.id);
        if (response.success) { try { await transferOrder(response.orderId); } catch { /* Durable instruction remains pending/uncertain; access is not removed. */ } }
        return response;
    }
    async function orderStatus(orderId, buyerId) {
        if (!/^legacy_\d+$/.test(orderId || '')) fail('Order not found.', 404);
        const [[purchase]] = await pool.query('SELECT * FROM subject_purchases WHERE id=? AND buyer_user_id=?', [Number(orderId.slice(7)), buyerId]);
        if (!purchase) fail('Order not found.', 404);
        return result(pool, purchase);
    }
    return { payments: { createOrder, verifySession, orderStatus }, transferOrder, handleEvent };
}
module.exports = { createReleaseService, TYPE };
