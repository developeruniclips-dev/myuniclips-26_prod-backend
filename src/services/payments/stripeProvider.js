// The only payment provider implemented. No Paystack API or placeholder adapter.
function createStripeProvider(stripe, frontendUrl) {
    return {
        name: 'stripe',
        async identity() {
            const account = await stripe.accounts.retrieve();
            // Balance is read-only and reports the API key's mode, including restricted keys.
            const balance = await stripe.balance.retrieve();
            if (!account.id || typeof balance.livemode !== 'boolean') throw new Error('Cannot verify Stripe platform');
            return { account: account.id, livemode: balance.livemode };
        },
        async createCheckout(order, name) {
            const metadata = { orderId: order.id, buyerId: String(order.buyer_id), subjectId: String(order.subject_id),
                scholarId: String(order.scholar_id), type: 'uniclips_order_v1' };
            return stripe.checkout.sessions.create({ mode: 'payment', client_reference_id: order.id,
                line_items: [{ price_data: { currency: order.currency.toLowerCase(), unit_amount: order.amount_minor,
                    product_data: { name } }, quantity: 1 }], metadata,
                payment_intent_data: { metadata, transfer_group: `order_${order.id}` },
                success_url: `${frontendUrl}/course/${order.subject_id}/${order.scholar_id}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${frontendUrl}/course/${order.subject_id}/${order.scholar_id}?payment=cancelled`
            }, { idempotencyKey: `checkout_${order.id}` });
        },
        retrieveCheckout: id => stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent.latest_charge'] }),
        async evidence(sessionId) {
            const [session, identity] = await Promise.all([this.retrieveCheckout(sessionId), this.identity()]);
            const payment = session.payment_intent;
            const charge = payment && typeof payment === 'object' ? payment.latest_charge : null;
            return { session, identity, payment, charge };
        },
        retrieveAccount: id => stripe.accounts.retrieve(id),
        async findTransfers(orderId) {
            const matches = [];
            for await (const transfer of stripe.transfers.list({ transfer_group: `order_${orderId}`, limit: 100 })) matches.push(transfer);
            return matches;
        },
        createTransfer: (order, transfer) => stripe.transfers.create({ amount: Number(transfer.amount_minor),
            currency: transfer.currency.toLowerCase(), destination: transfer.destination_account,
            source_transaction: order.charge_id, transfer_group: `order_${order.id}`,
            metadata: { orderId: order.id } }, { idempotencyKey: transfer.idempotency_key })
    };
}
function classifyAccountError(error) {
    if (error.code === 'resource_missing') return 'account_unavailable_review_required';
    if (error.type === 'StripeAuthenticationError' || error.type === 'StripePermissionError') return 'provider_configuration_error';
    return 'provider_temporarily_unavailable';
}
module.exports = { createStripeProvider, classifyAccountError };
