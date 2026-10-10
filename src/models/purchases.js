const { pool } = require("../config/db");
const {ACTIVE_ENTITLEMENT_SQL,activeEntitlementSql}=require('../services/contentAuthorization');

// Subject bundle price in EUR
const SUBJECT_BUNDLE_PRICE = 6.00;
// Course access duration in months
const ACCESS_DURATION_MONTHS = 5;

const PurchaseModel = {
  // Legacy video-based purchases (keep for backwards compatibility)
  create: (buyerUserId, videoId, amount, currency = "EUR") =>
    pool.query("INSERT INTO purchases (buyer_user_id, video_id, amount, currency) VALUES (?, ?, ?, ?)", [buyerUserId, videoId, amount, currency]),

  findByUserAndVideo: (buyerUserId, videoId) =>
    pool.query("SELECT * FROM purchases WHERE buyer_user_id = ? AND video_id = ?", [buyerUserId, videoId]),

  findByUser: (buyerUserId) =>
    pool.query("SELECT p.*, v.title, v.subject_id, v.scholar_user_id AS scholar_id FROM purchases p JOIN videos v ON p.video_id = v.id WHERE p.buyer_user_id = ?", [buyerUserId]),

  savePurchase: (user_id, video_id, amount, transaction_id) => {
    return pool.query(
      "INSERT INTO purchases (user_id, video_id, amount, transaction_id) VALUES (?, ?, ?, ?)",
      [user_id, video_id, amount, transaction_id]
    );
  },

  hasPurchased: (user_id, video_id) => {
    return pool.query(
      "SELECT * FROM purchases WHERE buyer_user_id = ? AND video_id = ?",
      [user_id, video_id]
    );
  },

  // NEW: Subject bundle purchases with 5-month access expiry
  purchaseSubjectBundle: (buyerUserId, subjectId, scholarId, amount = SUBJECT_BUNDLE_PRICE, transactionId = null) => {
    // Calculate access expiry date (5 months from now)
    return pool.query(
      `INSERT INTO subject_purchases (buyer_user_id, subject_id, scholar_id, amount, currency, transaction_id, access_expires_at, is_access_active) 
       VALUES (?, ?, ?, ?, 'EUR', ?, DATE_ADD(NOW(), INTERVAL ? MONTH), 1)`,
      [buyerUserId, subjectId, scholarId, amount, transactionId, ACCESS_DURATION_MONTHS]
    );
  },

  // Check if user has ACTIVE (non-expired) access to subject
  hasPurchasedSubject: (buyerUserId, subjectId, scholarId) => {
    return pool.query(
      `SELECT *, 
        CASE WHEN ${ACTIVE_ENTITLEMENT_SQL} THEN 1 ELSE 0 END as is_active,
        DATEDIFF(access_expires_at, NOW()) as days_remaining
       FROM subject_purchases 
       WHERE buyer_user_id = ? AND subject_id = ? AND scholar_id = ?`,
      [buyerUserId, subjectId, scholarId]
    );
  },

  // Check if access is still valid (not expired)
  hasActiveAccess: async (buyerUserId, subjectId, scholarId) => {
    const [rows] = await pool.query(
      `SELECT id FROM subject_purchases 
       WHERE buyer_user_id = ? AND subject_id = ? AND scholar_id = ?
       AND ${ACTIVE_ENTITLEMENT_SQL}`,
      [buyerUserId, subjectId, scholarId]
    );
    return rows.length > 0;
  },

  // Get all subject bundles purchased by user with access status
  getUserSubjectPurchases: (buyerUserId) => {
    return pool.query(
      `SELECT sp.*, s.name as subject_name, u.fname as scholar_fname, u.lname as scholar_lname,
        CASE WHEN ${activeEntitlementSql('sp')} THEN 1 ELSE 0 END as is_active,
        DATEDIFF(sp.access_expires_at, NOW()) as days_remaining,
        sp.access_expires_at
       FROM subject_purchases sp
       JOIN subjects s ON sp.subject_id = s.id
       JOIN users u ON sp.scholar_id = u.id
       WHERE sp.buyer_user_id = ?
       ORDER BY sp.created_at DESC`,
      [buyerUserId]
    );
  },

  // Get expired purchases (for repurchase prompts)
  getExpiredPurchases: (buyerUserId) => {
    return pool.query(
      `SELECT sp.*, s.name as subject_name, u.fname as scholar_fname, u.lname as scholar_lname,
        s.bundle_price as current_price
       FROM subject_purchases sp
       JOIN subjects s ON sp.subject_id = s.id
       JOIN users u ON sp.scholar_id = u.id
       WHERE sp.buyer_user_id = ? 
       AND sp.access_expires_at IS NOT NULL 
       AND sp.access_expires_at <= NOW()
       ORDER BY sp.access_expires_at DESC`,
      [buyerUserId]
    );
  },

  // Get all sales for a scholar (for earnings)
  getScholarSubjectSales: (scholarId) => {
    return pool.query(
      `SELECT sp.*, s.name as subject_name, u.fname as buyer_fname, u.lname as buyer_lname
       FROM subject_purchases sp
       JOIN subjects s ON sp.subject_id = s.id
       JOIN users u ON sp.buyer_user_id = u.id
       WHERE sp.scholar_id = ?
       ORDER BY sp.created_at DESC`,
      [scholarId]
    );
  },

  // Renew access for an expired purchase (repurchase at current price)
  renewAccess: (purchaseId, newAmount, transactionId = null) => {
    return pool.query(
      `UPDATE subject_purchases 
       SET access_expires_at = DATE_ADD(NOW(), INTERVAL ? MONTH),
           is_access_active = 1,
           amount = ?,
           transaction_id = COALESCE(?, transaction_id),
           renewed_at = NOW()
       WHERE id = ?`,
      [ACCESS_DURATION_MONTHS, newAmount, transactionId, purchaseId]
    );
  }
};

module.exports = { PurchaseModel, SUBJECT_BUNDLE_PRICE, ACCESS_DURATION_MONTHS };
