const { PurchaseModel } = require("../models/purchases");
const { pool } = require("../config/db");
const { annotateCourses } = require('../utils/generalCourses');

const { paymentRuntime } = require('../services/paymentRelease');
const paymentError = (res, error) => {
  console.warn('Payment request failed', { code: error.code || 'verification_error' });
  return res.status(error.status || 503).json({ message: error.status ? error.message : 'Unable to verify payment. Please retry or contact support.' });
};
const createCheckoutSession = async (req, res) => {
  try { res.json(await paymentRuntime().payments.createOrder(req.user.id, req.body.subjectId, req.body.scholarId)); }
  catch (error) { paymentError(res, error); }
};
const handleCheckoutSuccess = async (req, res) => {
  try {
    const { payments, transferOrder } = paymentRuntime();
    const result = await payments.verifySession(req.body.sessionId, req.user.id);
    if (result.success) { try { await transferOrder(result.orderId); } catch { /* Reconcile durable transfer separately. */ } }
    res.status(result.success ? 200 : 202).json(result);
  } catch (error) { paymentError(res, error); }
};
const getOrderStatus = async (req, res) => {
  try { res.json(await paymentRuntime().payments.orderStatus(req.params.orderId, req.user.id)); }
  catch (error) { paymentError(res, error); }
};
// Unused legacy embedded payment creation is retired: use the verified hosted flow.
// Existing purchases remain readable; old in-flight payments require reconciliation.
const legacyCheckout = (req, res) => res.status(409).json({ message: 'Please purchase through the course Stripe Checkout.' });
const createSubjectPaymentIntent = legacyCheckout;
const confirmSubjectPurchase = handleCheckoutSuccess;

// NEW: Check if user has purchased a subject bundle
const checkSubjectPurchase = async (req, res) => {
  try {
    const { subjectId, scholarId } = req.query;
    const buyerId = req.user.id;

    if (!subjectId || !scholarId) {
      return res.status(400).json({ message: "Subject ID and Scholar ID are required" });
    }

    const [purchases] = await PurchaseModel.hasPurchasedSubject(buyerId, subjectId, scholarId);
    
    res.status(200).json({
      hasPurchased: purchases.some(p => Number(p.is_active) === 1 && Number(p.is_access_active) === 1),
      hasEverPurchased: purchases.length > 0,
      purchase: purchases[0] || null
    });
  } catch (err) {
    console.error("Error checking subject purchase:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// NEW: Get all subject purchases for current user
const getMySubjectPurchases = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const [purchases] = await PurchaseModel.getUserSubjectPurchases(buyerId);

    res.status(200).json({
      message: "Subject purchases fetched successfully",
      purchases: await annotateCourses(pool, purchases)
    });
  } catch (err) {
    console.error("Error fetching subject purchases:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

const purchaseVideo = legacyCheckout;

const getUserPurchases = async (req, res) => {
  try {
    const buyerId = req.user.id;

    const [purchases] = await PurchaseModel.findByUser(buyerId);

    if (!purchases || purchases.length === 0) {
      return res.status(200).json({
        message: "You have not purchased any videos yet",
        purchases: []
      });
    }

    return res.json({
      message: "Purchases fetched successfully",
      purchases
    });

  } catch (err) {
    console.error("Error fetching user purchases:", err);
    return res.status(500).json({
      message: "Server error fetching purchases",
      error: err
    });
  }
};

const createPaymentIntent = legacyCheckout;

// Admin: Get all transactions with details
const getAllTransactions = async (req, res) => {
  try {
    const { pool } = require("../config/db");
    
    // Get individual video purchases (legacy)
    const [videoPurchases] = await pool.query(`
      SELECT 
        t.id as transaction_id,
        t.provider,
        t.provider_transaction_id,
        t.status,
        t.created_at as transaction_date,
        p.id as purchase_id,
        p.amount,
        p.currency,
        p.created_at as purchase_date,
        u.id as buyer_id,
        u.fname as buyer_fname,
        u.lname as buyer_lname,
        u.email as buyer_email,
        v.id as video_id,
        v.title as video_title,
        v.scholar_user_id,
        s.fname as scholar_fname,
        s.lname as scholar_lname,
        'video' as purchase_type
      FROM transactions t
      LEFT JOIN purchases p ON t.purchase_id = p.id
      LEFT JOIN users u ON p.buyer_user_id = u.id
      LEFT JOIN videos v ON p.video_id = v.id
      LEFT JOIN users s ON v.scholar_user_id = s.id
      ORDER BY t.created_at DESC
    `);

    // Get course bundle purchases
    const [bundlePurchases] = await pool.query(`
      SELECT 
        sp.id as transaction_id,
        'stripe' as provider,
        sp.transaction_id as provider_transaction_id,
        'completed' as status,
        sp.created_at as transaction_date,
        sp.id as purchase_id,
        sp.amount,
        sp.currency,
        sp.created_at as purchase_date,
        buyer.id as buyer_id,
        buyer.fname as buyer_fname,
        buyer.lname as buyer_lname,
        buyer.email as buyer_email,
        NULL as video_id,
        subj.name as video_title,
        sp.scholar_id as scholar_user_id,
        scholar.fname as scholar_fname,
        scholar.lname as scholar_lname,
        'bundle' as purchase_type
      FROM subject_purchases sp
      JOIN users buyer ON sp.buyer_user_id = buyer.id
      JOIN users scholar ON sp.scholar_id = scholar.id
      JOIN subjects subj ON sp.subject_id = subj.id
      ORDER BY sp.created_at DESC
    `);

    // Combine and sort by date
    const allTransactions = [...videoPurchases, ...bundlePurchases].sort(
      (a, b) => new Date(b.transaction_date) - new Date(a.transaction_date)
    );

    res.json({
      message: "Transactions fetched successfully",
      transactions: allTransactions
    });

  } catch (err) {
    console.error("Error fetching transactions:", err);
    res.status(500).json({ message: "Server error fetching transactions", error: err });
  }
};

module.exports = {
  purchaseVideo,
  getUserPurchases,
  createPaymentIntent,
  getOrderStatus,
  getAllTransactions,
  // Stripe Checkout Session (Marketplace)
  createCheckoutSession,
  handleCheckoutSuccess,
  // Subject bundle functions
  createSubjectPaymentIntent,
  confirmSubjectPurchase,
  checkSubjectPurchase,
  getMySubjectPurchases
};
