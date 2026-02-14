const Stripe = require("stripe");
require("dotenv").config();

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("FATAL: STRIPE_SECRET_KEY environment variable is required");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
