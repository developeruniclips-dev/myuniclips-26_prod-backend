const { Router } = require("express");
const { 
    setup2FA, 
    verify2FA, 
    validate2FA, 
    disable2FA, 
    get2FAStatus 
} = require("../controller/twoFactorController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const rateLimit = require("express-rate-limit");

const router = Router();

// Rate limiting for 2FA validation (prevent brute force)
const twoFactorLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: { error: "Too many 2FA attempts, please try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

// Protected routes - require authentication
router.get('/status', authMiddleware, get2FAStatus);
router.post('/setup', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), setup2FA);
router.post('/verify', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), twoFactorLimiter, verify2FA);
router.post('/disable', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), twoFactorLimiter, disable2FA);

// Public route for login 2FA validation (called after initial login)
router.post('/validate', twoFactorLimiter, validate2FA);

module.exports = router;
