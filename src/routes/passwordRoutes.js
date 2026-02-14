const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { requestPasswordReset, resetPassword, changePassword } = require("../controller/passwordController");
const { authMiddleware } = require("../middleware/auth");

const router = Router();

// ===== SECURITY: Strict rate limiting for password reset =====
const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: { error: "Too many password reset attempts, please try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

// Public routes (no auth required) - with rate limiting
router.post("/forgot", passwordResetLimiter, requestPasswordReset);
router.post("/reset", passwordResetLimiter, resetPassword);

// Protected routes (auth required)
router.post("/change", authMiddleware, changePassword);

module.exports = router;
