const { failure, validateEvidence } = require('./paymentService');
function matches(transfer, instruction, order) {
    return transfer.amount === Number(instruction.amount_minor) && transfer.currency?.toUpperCase() === instruction.currency &&
        transfer.destination === instruction.destination_account && transfer.metadata?.orderId === order.id &&
        transfer.source_transaction === order.charge_id && !transfer.reversed;
}
function createTransferService({ pool, provider }) {
    return async function transferOrder(orderId) {
        if (typeof orderId !== 'string' || !/^[a-f0-9-]{36}$/.test(orderId)) throw failure('Invalid order reference', 400);
        // Lock through the provider operation to serialize webhook/admin/recovery callers.
        // An intent is durably marked uncertain BEFORE any external write.
        const db = await pool.getConnection();
        let locked = false;
        try {
            const [[lock]] = await db.query('SELECT GET_LOCK(?, 0) AS acquired', [`transfer:${orderId}`]);
            locked = Number(lock.acquired) === 1;
            if (!locked) return { state: 'processing' };
            const [[order]] = await db.query('SELECT * FROM payment_orders WHERE id=?', [orderId]);
            const [[instruction]] = await db.query('SELECT * FROM payment_transfers WHERE order_id=?', [orderId]);
            if (!order || !instruction || order.state !== 'fulfilled') throw failure('No earned allocation');
            if (instruction.state === 'completed') return { state: 'completed', transferId: instruction.transfer_id };
            if (order.refund_state !== 'none' || order.dispute_state !== 'none') throw failure('Payment adjustment requires review');
            if (!instruction.destination_account) return { state: 'pending', reason: 'payout_setup_required' };
            const [[owner]] = await db.query('SELECT stripe_account_id FROM scholar_profile WHERE user_id=? AND approved=1', [order.scholar_id]);
            if (owner?.stripe_account_id !== instruction.destination_account) throw failure('Connected account ownership requires review');
            const identity = await provider.identity();
            if (identity.account !== order.provider_account || Number(identity.livemode) !== Number(order.livemode)) throw failure('Provider context mismatch');
            const account = await provider.retrieveAccount(instruction.destination_account);
            if (account.deleted || account.country !== 'FI' || account.capabilities?.transfers !== 'active' || !account.payouts_enabled) {
                return { state: 'pending', reason: 'account_restricted' };
            }
            const evidence = await provider.evidence(order.session_id);
            if (!validateEvidence(order, evidence) || evidence.charge.amount_refunded > 0 || evidence.charge.disputed) {
                return { state: 'pending', reason: 'payment_adjustment_review_required' };
            }
            let transfer;
            if (instruction.attempted_at) {
                // Never blindly reuse a key after Stripe's retention window. Reconcile only.
                const found = await provider.findTransfers(orderId);
                if (found.length !== 1 || !matches(found[0], instruction, order)) return { state: 'uncertain', reason: 'manual_reconciliation_required' };
                transfer = found[0];
            } else {
                await db.query("UPDATE payment_transfers SET state='uncertain', attempted_at=NOW() WHERE order_id=?", [orderId]);
                try { transfer = await provider.createTransfer(order, instruction); }
                catch (error) {
                    const rejected = error.type === 'StripeInvalidRequestError';
                    await db.query('UPDATE payment_transfers SET state=?,error_code=? WHERE order_id=?', [rejected ? 'failed' : 'uncertain', rejected ? 'provider_rejected_review' : 'provider_result_unknown', orderId]);
                    return { state: rejected ? 'failed' : 'uncertain', reason: 'manual_reconciliation_required' };
                }
                if (!matches(transfer, instruction, order)) throw failure('Transfer result requires reconciliation');
            }
            await db.query("UPDATE payment_transfers SET state='completed',transfer_id=?,completed_at=NOW(),error_code=NULL WHERE order_id=?", [transfer.id, orderId]);
            return { state: 'completed', transferId: transfer.id };
        } finally {
            if (locked) await db.query('SELECT RELEASE_LOCK(?)', [`transfer:${orderId}`]);
            db.release();
        }
    };
}
module.exports = { createTransferService, matches };
