const { paymentMode } = require('./mode');
let current;
function paymentRuntime() {
    // Phase2A is explicitly opt-in; table presence never selects the architecture.
    if (paymentMode() === 'phase2a') return require('../payments');
    if (!current) {
        const { pool } = require('../../config/db');
        const stripe = require('../../config/stripe');
        const { createReleaseStripeProvider } = require('./stripeProvider');
        const { createReleaseService } = require('./service');
        current = createReleaseService({ pool, provider: createReleaseStripeProvider(stripe, process.env.FRONTEND_URL), signingSecret: process.env.JWT_SECRET });
    }
    return current;
}
module.exports = { paymentRuntime, paymentMode };
