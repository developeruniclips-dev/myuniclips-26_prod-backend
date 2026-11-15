const { Router } = require("express");
const {
    setup2FA,
    verify2FA,
    validate2FA,
    disable2FA,
    get2FAStatus,
    regenerateBackupCodes
} = require("../controller/twoFactorController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { createAuthRateLimits } = require('../middleware/authRateLimits');
const limits = createAuthRateLimits();
const { sharedAuthAdmission: admission } = require('../middleware/authAdmission');

const router = Router();

// Protected routes - require authentication
router.get('/status', authMiddleware, get2FAStatus);
router.post('/setup', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), limits.protectedFactorAccount, admission.wrap(setup2FA));
router.post('/verify', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), limits.protectedFactorAccount, admission.wrap(verify2FA));
router.post('/disable', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), limits.protectedFactorAccount, admission.wrap(disable2FA));
router.post('/backup-codes', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), limits.protectedFactorAccount, admission.wrap(regenerateBackupCodes));

// Public route for login 2FA validation (called after initial login)
router.post('/validate', limits.factorNetwork, limits.factorAccount, admission.wrap(validate2FA));

module.exports = router;
