const stripe = require('../config/stripe');
const { paymentRuntime } = require('../services/paymentRelease');
const stripeWebhook = async (req, res) => {
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.status(400).json({ message: 'Invalid webhook signature' }); }
    try {
        const result = await paymentRuntime().handleEvent(event);
        if (result?.legacyReviewRequired) console.warn('Legacy Stripe event requires separate review', { eventId: event.id });
        return res.json({ received: true });
    }
    catch (error) {
        console.warn('Stripe event processing failed', { eventId: event.id, code: error.code || 'verification_error' });
        return res.status(500).json({ message: 'Event processing incomplete; retry required' });
    }
};
module.exports = { stripeWebhook };
