// Runtime composition only; unit/integration tests inject isolated DB and provider doubles.
const { pool } = require('../../config/db');
const stripe = require('../../config/stripe');
const { createStripeProvider } = require('./stripeProvider');
const { createPaymentService } = require('./paymentService');
const { createTransferService } = require('./transferService');
const { createEventService } = require('./eventService');
const provider = createStripeProvider(stripe, process.env.FRONTEND_URL);
const payments = createPaymentService({ pool, provider });
const transferOrder = createTransferService({ pool, provider });
const handleEvent = createEventService({ pool, provider, payments, transferOrder });
module.exports = { payments, transferOrder, handleEvent };
