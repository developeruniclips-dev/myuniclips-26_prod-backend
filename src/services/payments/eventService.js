const { transaction, failure } = require('./paymentService');
function createEventService({ pool, provider, payments, transferOrder }) {
    return async function handleEvent(event) {
        const identity = await provider.identity();
        if (event.account || Number(event.livemode) !== Number(identity.livemode)) throw failure('Wrong webhook platform or mode');
        const object = event.data?.object;
        if (!event.id || !object?.id) throw failure('Invalid event');
        await pool.query(`INSERT INTO payment_events (provider,event_id,event_type,object_id) VALUES ('stripe',?,?,?)
            ON DUPLICATE KEY UPDATE event_id=VALUES(event_id)`, [event.id, event.type, object.id]);
        const [[stored]] = await pool.query("SELECT * FROM payment_events WHERE provider='stripe' AND event_id=?", [event.id]);
        if (stored.event_type !== event.type || stored.object_id !== object.id) throw failure('Conflicting event');
        if (stored.state === 'processed') return;
        let orderId = object.metadata?.orderId || null;
        let state = 'processed';
        if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
            if (object.metadata?.type !== 'uniclips_order_v1') state = 'legacy_review_required';
            else {
                const result = await payments.verifySession(object.id);
                orderId = result.orderId;
                if (result.success) {
                    // Failure to move money never removes verified learner access.
                    try { await transferOrder(orderId); } catch { /* durable pending/uncertain transfer is reconciled separately */ }
                }
            }
        } else if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type)) {
            if (orderId) await pool.query(`UPDATE payment_orders SET state=? WHERE id=? AND session_id=? AND provider_account=?
                AND state IN ('created','pending')`, [event.type.endsWith('expired') ? 'expired' : 'failed', orderId, object.id, identity.account]);
        } else if (event.type === 'charge.refunded' || event.type.startsWith('charge.dispute.')) {
            await transaction(pool, async db => {
                const paymentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
                const [[order]] = await db.query("SELECT * FROM payment_orders WHERE provider='stripe' AND (payment_id=? OR id=?) FOR UPDATE", [paymentId || '', object.metadata?.orderId || '']);
                if (!order) { state = 'legacy_review_required'; return; }
                if (order.provider_account !== identity.account || object.currency?.toUpperCase() !== order.currency) throw failure('Adjustment context mismatch');
                orderId = order.id;
                const refund = event.type === 'charge.refunded';
                const amount = refund ? object.amount_refunded : object.amount;
                if (!Number.isSafeInteger(amount) || amount < 0 || amount > Number(order.amount_minor)) throw failure('Invalid adjustment amount');
                const adjustmentState = refund ? (amount === Number(order.amount_minor) ? 'fully_refunded' : 'partially_refunded') : object.status;
                await db.query(`INSERT IGNORE INTO payment_adjustments (provider,event_id,reference_id,order_id,kind,state,amount_minor,currency,provider_created)
                    VALUES ('stripe',?,?,?,?,?,?,?,?)`, [event.id, object.id, order.id, refund ? 'refund' : 'dispute', adjustmentState, amount, order.currency, event.created]);
                // Append evidence; never change the original allocation or entitlement dates.
                // Refund amounts are cumulative, so a stale partial event cannot undo a full refund.
                if (refund) await db.query(`UPDATE payment_orders SET refund_state=IF(refund_state='fully_refunded','fully_refunded',?) WHERE id=?`, [adjustmentState, order.id]);
                else {
                    const [[latest]] = await db.query("SELECT state FROM payment_adjustments WHERE order_id=? AND kind='dispute' ORDER BY provider_created DESC, created_at DESC LIMIT 1", [order.id]);
                    await db.query('UPDATE payment_orders SET dispute_state=? WHERE id=?', [latest.state, order.id]);
                }
            });
        } else if (event.type === 'payment_intent.succeeded' && object.metadata?.type !== 'uniclips_order_v1') {
            state = 'legacy_review_required';
        }
        await pool.query("UPDATE payment_events SET state=?,order_id=?,processed_at=NOW() WHERE provider='stripe' AND event_id=?", [state, orderId, event.id]);
    };
}
module.exports = { createEventService };
