const { Router } = require("express");
const { createAuthRateLimits } = require('../middleware/authRateLimits');
const limits = createAuthRateLimits();
const { sharedAuthAdmission: admission, sharedRecoveryAdmission: recoveryAdmission } = require('../middleware/authAdmission');
const { requestPasswordReset, resetPassword, changePassword } = require("../controller/passwordController");
const { authMiddleware } = require("../middleware/auth");

const router = Router();

// Public routes (no auth required) - with rate limiting
router.post("/forgot", limits.recoveryNetwork, limits.recoveryEmail, recoveryAdmission.wrap(requestPasswordReset));
router.post("/reset", limits.recoveryNetwork, limits.resetEmail, admission.wrap(resetPassword));

// Protected routes (auth required)
router.post("/change", authMiddleware, admission.wrap(changePassword));

module.exports = router;
