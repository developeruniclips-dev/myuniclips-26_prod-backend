const { randomUUID } = require('crypto');
const { toMinor, decimal, allocation } = require('./money');
function failure(message, status = 409) { return Object.assign(new Error(message), { status }); }
const same = (a, b) => String(a) === String(b);
async function transaction(pool, work) {
    const db = await pool.getConnection();
    try { await db.beginTransaction(); const result = await work(db); await db.commit(); return result; }
    catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
}
function validateEvidence(order, evidence) {
    const { session: s, identity, payment: p, charge } = evidence;
    if (identity.account !== order.provider_account || Number(identity.livemode) !== Number(order.livemode) ||
        Number(s.livemode) !== Number(order.livemode) || s.mode !== 'payment' ||
        s.client_reference_id !== order.id || s.metadata?.orderId !== order.id || s.metadata?.type !== 'uniclips_order_v1' ||
        !same(s.metadata?.buyerId, order.buyer_id) || !same(s.metadata?.subjectId, order.subject_id) ||
        !same(s.metadata?.scholarId, order.scholar_id) || (order.session_id && order.session_id !== s.id) ||
        s.amount_total !== Number(order.amount_minor) || s.currency?.toUpperCase() !== order.currency) throw failure('Payment does not match this order');
    if (s.payment_status !== 'paid') return false;
    if (!p || p.status !== 'succeeded' || p.amount_received !== Number(order.amount_minor) ||
        p.currency?.toUpperCase() !== order.currency || Number(p.livemode) !== Number(order.livemode) ||
        p.metadata?.orderId !== order.id || !charge?.id || !charge.paid ||
        charge.amount !== Number(order.amount_minor) || charge.currency?.toUpperCase() !== order.currency ||
        charge.payment_intent !== p.id || (order.payment_id && order.payment_id !== p.id)) throw failure('Payment verification failed');
    return true;
}
function createPaymentService({ pool, provider }) {
    async function createOrderLocked(db, buyerId, subjectId, scholarId) {
        if (![buyerId, subjectId, scholarId].every(v => /^\d+$/.test(String(v)) && Number(v) > 0)) throw failure('Invalid offering', 400);
        if (same(buyerId, scholarId)) throw failure('You already own this course', 400);
        const [[course]] = await db.query(`SELECT s.*, p.provider, p.currency, p.enabled, c.code AS country_code,
            sp.stripe_account_id FROM subjects s JOIN universities u ON u.id=s.university_id
            JOIN countries c ON c.id=u.country_id JOIN payment_catalogue_policy p ON p.university_id=u.id
            JOIN scholar_subjects ss ON ss.subject_id=s.id AND ss.scholar_user_id=? AND ss.approved=1
            JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id AND sp.approved=1
            WHERE s.id=? AND EXISTS (SELECT 1 FROM videos v WHERE v.subject_id=s.id AND v.scholar_user_id=ss.scholar_user_id AND v.approved=1)`, [scholarId, subjectId]);
        if (!course || !course.enabled || course.country_code !== 'FI' || course.provider !== 'stripe' || course.currency !== 'EUR') throw failure('Checkout is not available for this offering');
        const [[existing]] = await db.query('SELECT id FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=?', [buyerId, subjectId, scholarId]);
        if (existing) throw failure('This course has already been purchased');
        const [[pending]] = await db.query("SELECT * FROM payment_orders WHERE buyer_id=? AND subject_id=? AND scholar_id=? AND state IN ('created','pending','paid','review_required') ORDER BY created_at DESC LIMIT 1", [buyerId, subjectId, scholarId]);
        if (pending) {
            if (pending.state === 'pending' && pending.checkout_url) return { orderId: pending.id, sessionId: pending.session_id, url: pending.checkout_url, currency: pending.currency, amount: decimal(pending.amount_minor) };
            throw failure('An earlier checkout needs verification. Contact support before paying again.');
        }
        const amount = toMinor(course.bundle_price, course.currency);
        if (amount < 50) throw failure('This offering has no valid paid price');
        const [[count]] = await db.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=? AND scholar_id=?', [subjectId, scholarId]);
        const quote = allocation(amount, Number(count.n) + 1);
        const identity = await provider.identity();
        const order = { id: randomUUID(), buyer_id: Number(buyerId), subject_id: Number(subjectId), scholar_id: Number(scholarId),
            university_id: course.university_id, provider: provider.name, currency: course.currency, amount_minor: amount,
            provider_account: identity.account, livemode: identity.livemode, destination_account: course.stripe_account_id || null };
        await db.query(`INSERT INTO payment_orders (id,buyer_id,subject_id,scholar_id,university_id,provider,currency,amount_minor,
            rule_version,quoted_rate,quoted_scholar_minor,quoted_platform_minor,provider_account,livemode,destination_account)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [order.id, order.buyer_id, order.subject_id, order.scholar_id, order.university_id,
            order.provider, order.currency, amount, 'successful_bundle_sales_70_100_then_50_v1', quote.rate, quote.scholar, quote.platform,
            identity.account, identity.livemode, order.destination_account]);
        // A timeout leaves a durable order. Do not manufacture another session for this order.
        const session = await provider.createCheckout(order, course.name);
        await db.query("UPDATE payment_orders SET session_id=?, checkout_url=?, state=IF(state='created','pending',state) WHERE id=? AND (session_id IS NULL OR session_id=?)",
            [session.id, session.url, order.id, session.id]);
        return { orderId: order.id, sessionId: session.id, url: session.url, currency: order.currency, amount: decimal(amount) };
    }
    async function createOrder(buyerId, subjectId, scholarId) {
        if (![buyerId, subjectId, scholarId].every(v => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0)) throw failure('Invalid offering', 400);
        [buyerId, subjectId, scholarId] = [buyerId, subjectId, scholarId].map(Number);
        const db = await pool.getConnection();
        const key = `checkout:${buyerId}:${subjectId}:${scholarId}`;
        let locked = false;
        try {
            const [[lock]] = await db.query('SELECT GET_LOCK(?,0) AS acquired', [key]);
            locked = Number(lock.acquired) === 1;
            if (!locked) throw failure('Checkout is being prepared. Please retry.');
            return await createOrderLocked(db, buyerId, subjectId, scholarId);
        } finally {
            if (locked) await db.query('SELECT RELEASE_LOCK(?)', [key]);
            db.release();
        }
    }
    async function verifySession(sessionId, buyerId) {
        if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId) || sessionId.length > 255) throw failure('Invalid checkout reference', 400);
        const evidence = await provider.evidence(sessionId);
        const orderId = evidence.session.metadata?.orderId;
        if (!orderId) throw failure('Payment predates verified orders; contact support for reconciliation');
        const result = await transaction(pool, async db => {
            const [[order]] = await db.query('SELECT * FROM payment_orders WHERE id=? FOR UPDATE', [orderId]);
            if (!order || (buyerId != null && !same(order.buyer_id, buyerId))) throw failure('Order not found', 404);
            if (!validateEvidence(order, evidence)) return { success: false, state: 'pending', orderId };
            if (order.state === 'fulfilled') {
                const [[purchase]] = await db.query('SELECT is_access_active AND (access_expires_at IS NULL OR access_expires_at>NOW()) AS active FROM subject_purchases WHERE id=?', [order.purchase_id]);
                return { success: true, state: 'fulfilled', orderId, subjectId: order.subject_id, scholarId: order.scholar_id, accessActive: Boolean(purchase?.active) };
            }
            // Convert Unix time inside MySQL, not through the Node driver's local timezone.
            const paidAt = evidence.charge.created;
            if (!Number.isSafeInteger(paidAt) || paidAt <= 0) throw failure('Invalid payment timestamp');
            await db.query(`UPDATE payment_orders SET session_id=?, payment_id=?, charge_id=?, paid_at=FROM_UNIXTIME(?), state='paid' WHERE id=?`,
                [sessionId, evidence.payment.id, evidence.charge.id, paidAt, orderId]);
            // Another independently paid order for the same entitlement must be reviewed, never renew access.
            const [[existing]] = await db.query('SELECT id FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=?', [order.buyer_id, order.subject_id, order.scholar_id]);
            if (existing) {
                await db.query("UPDATE payment_orders SET state='review_required' WHERE id=?", [orderId]);
                return { success: false, state: 'review_required', orderId };
            }
            // Upsert serializes the first initializer too. Baseline preserves existing bundle-count policy.
            await db.query(`INSERT INTO payment_sale_counters (subject_id,scholar_id,legacy_baseline,successful_sales)
                SELECT ?,?,COUNT(*),COUNT(*) FROM subject_purchases WHERE subject_id=? AND scholar_id=?
                ON DUPLICATE KEY UPDATE subject_id=VALUES(subject_id)`, [order.subject_id, order.scholar_id, order.subject_id, order.scholar_id]);
            const [[counter]] = await db.query('SELECT * FROM payment_sale_counters WHERE subject_id=? AND scholar_id=? FOR UPDATE', [order.subject_id, order.scholar_id]);
            const ordinal = Number(counter.successful_sales) + 1;
            const share = allocation(Number(order.amount_minor), ordinal);
            const [purchase] = await db.query(`INSERT INTO subject_purchases
                (buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active)
                VALUES (?,?,?,?,?,?,FROM_UNIXTIME(?),DATE_ADD(FROM_UNIXTIME(?), INTERVAL 5 MONTH),1)`,
            [order.buyer_id, order.subject_id, order.scholar_id, decimal(order.amount_minor), order.currency, evidence.payment.id, paidAt, paidAt]);
            await db.query(`INSERT INTO payment_allocations (order_id,subject_id,scholar_id,sale_ordinal,currency,gross_minor,scholar_rate,scholar_minor,platform_minor)
                VALUES (?,?,?,?,?,?,?,?,?)`, [orderId, order.subject_id, order.scholar_id, ordinal, order.currency, order.amount_minor, share.rate, share.scholar, share.platform]);
            await db.query('UPDATE payment_sale_counters SET successful_sales=? WHERE subject_id=? AND scholar_id=?', [ordinal, order.subject_id, order.scholar_id]);
            await db.query(`INSERT INTO payment_transfers (order_id,provider,currency,amount_minor,destination_account,idempotency_key)
                VALUES (?,?,?,?,?,?)`, [orderId, provider.name, order.currency, share.scholar, order.destination_account, `transfer_${orderId}`]);
            await db.query("UPDATE payment_orders SET state='fulfilled', purchase_id=?, fulfilled_at=NOW() WHERE id=?", [purchase.insertId, orderId]);
            const [[access]] = await db.query('SELECT is_access_active AND access_expires_at>NOW() AS active FROM subject_purchases WHERE id=?', [purchase.insertId]);
            return { success: true, state: 'fulfilled', orderId, subjectId: order.subject_id, scholarId: order.scholar_id, accessActive: Boolean(access.active) };
        });
        return result;
    }
    async function orderStatus(id, buyerId) {
        const [[order]] = await pool.query('SELECT id,state,currency,amount_minor,subject_id,scholar_id FROM payment_orders WHERE id=? AND buyer_id=?', [id, buyerId]);
        if (!order) throw failure('Order not found', 404);
        return order;
    }
    return { createOrder, verifySession, orderStatus };
}
module.exports = { createPaymentService, transaction, failure, validateEvidence };
