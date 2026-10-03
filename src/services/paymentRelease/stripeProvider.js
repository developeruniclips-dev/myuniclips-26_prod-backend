const { createStripeProvider } = require('../payments/stripeProvider');
const TYPE = 'uniclips_legacy_verified_v1';
function createReleaseStripeProvider(stripe, frontendUrl) {
    const base = createStripeProvider(stripe, frontendUrl);
    return {
        ...base,
        createCheckout: (snapshot, signature, name) => {
            const metadata = { type: TYPE, snapshot: JSON.stringify(snapshot), signature };
            return stripe.checkout.sessions.create({ mode: 'payment', client_reference_id: snapshot.nonce,
                line_items: [{ price_data: { currency: 'eur', unit_amount: snapshot.amountMinor, product_data: { name } }, quantity: 1 }],
                metadata, payment_intent_data: { metadata, transfer_group: `lv_${snapshot.nonce}` },
                success_url: `${frontendUrl}/course/${snapshot.subjectId}/${snapshot.scholarId}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${frontendUrl}/course/${snapshot.subjectId}/${snapshot.scholarId}?payment=cancelled`
            }, { idempotencyKey: `lv_checkout_${snapshot.nonce}` });
        },
        async findReleaseTransfers(group) {
            const found = [];
            for await (const transfer of stripe.transfers.list({ transfer_group: group, limit: 100 })) found.push(transfer);
            return found;
        },
        createReleaseTransfer: instruction => stripe.transfers.create({ amount: instruction.amountMinor, currency: 'eur',
            destination: instruction.destination, source_transaction: instruction.chargeId, transfer_group: instruction.group,
            metadata: { release: TYPE, purchaseId: String(instruction.purchaseId), instructionId: String(instruction.id) }
        }, { idempotencyKey: `lv_transfer_${instruction.id}_${instruction.purchaseId}` })
    };
}
module.exports = { createReleaseStripeProvider, TYPE };
