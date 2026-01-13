const express = require("express");
const { Router } = require("express");
const { 
  createPaymentIntent, 
  getUserPurchases, 
  purchaseVideo, 
  getAllTransactions,
  // Stripe Checkout Session (Marketplace)
  createCheckoutSession,
  handleCheckoutSuccess,
  // Subject bundle functions
  createSubjectPaymentIntent,
  confirmSubjectPurchase,
  checkSubjectPurchase,
  getMySubjectPurchases
} = require("../controller/purchaseController");
const { stripeWebhook } = require("../controller/stripeWebhookController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const purchaseRoutes = Router();

// Legacy individual video purchases
purchaseRoutes.post('/', authMiddleware, authorizeRoles("Learner","Scholar"), purchaseVideo);
purchaseRoutes.get('/my-purchases', authMiddleware, authorizeRoles("Learner","Scholar"), getUserPurchases);

// NEW: Stripe Checkout Session (Marketplace model - redirects to Stripe)
purchaseRoutes.post('/create-checkout-session', authMiddleware, authorizeRoles("Learner","Scholar"), createCheckoutSession);
purchaseRoutes.post('/checkout-success', authMiddleware, authorizeRoles("Learner","Scholar"), handleCheckoutSuccess);

// Subject bundle purchases with embedded card form
purchaseRoutes.post('/subject/create-payment-intent', authMiddleware, authorizeRoles("Learner","Scholar"), createSubjectPaymentIntent);
purchaseRoutes.post('/subject/confirm', authMiddleware, authorizeRoles("Learner","Scholar"), confirmSubjectPurchase);
purchaseRoutes.get('/subject/check', authMiddleware, authorizeRoles("Learner","Scholar"), checkSubjectPurchase);
purchaseRoutes.get('/subject/my-purchases', authMiddleware, authorizeRoles("Learner","Scholar"), getMySubjectPurchases);

// Admin: Get all transactions
purchaseRoutes.get('/transactions/all', authMiddleware, authorizeRoles("Admin"), getAllTransactions);

// Legacy Stripe PaymentIntent (for individual videos)
purchaseRoutes.post("/create-payment-intent", authMiddleware, createPaymentIntent);

// Webhook
purchaseRoutes.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);

module.exports = purchaseRoutes;
