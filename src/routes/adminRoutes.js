const ops = require('../controller/operationsController');
const { Router } = require("express");
const {
    getAdminProfile,
    getAllUsers,
    getOrphanedUsers,
    getSecurityUpdates,
    getActivityLog,
    getSuperAdminStats
} = require("../controller/adminController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { adminIPWhitelist, strictIPWhitelist } = require("../middleware/ipWhitelist");

const adminRoutes = Router();

// Apply IP whitelist to all admin routes when enabled
adminRoutes.use(adminIPWhitelist);

// Profile routes (Admin + SuperAdmin)
adminRoutes.get('/profile', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAdminProfile);
adminRoutes.put('/profile', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), ops.profileUpdate);

// User management routes
adminRoutes.get('/users', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsers);
adminRoutes.get('/users/orphaned', authMiddleware, authorizeRoles("SuperAdmin"), getOrphanedUsers);
adminRoutes.post('/users/create-admin', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), ops.createAdmin);
adminRoutes.put('/users/:userId/role', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), ops.changeRole);
adminRoutes.delete('/users/orphaned/:userId', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), ops.unavailable);
adminRoutes.delete('/users/:userId', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), ops.deleteUser);

// Security updates routes (Admin + SuperAdmin)
adminRoutes.get('/security-updates', authMiddleware, authorizeRoles("SuperAdmin"), getSecurityUpdates);
adminRoutes.post('/security-updates', authMiddleware, authorizeRoles("SuperAdmin"), ops.securityUpdate);
adminRoutes.put('/security-updates/:id/status', authMiddleware, authorizeRoles("SuperAdmin"), ops.securityUpdate);

// Activity log (SuperAdmin only)
adminRoutes.get('/activity-log', authMiddleware, authorizeRoles("SuperAdmin"), getActivityLog);

// SuperAdmin stats
adminRoutes.get('/stats', authMiddleware, authorizeRoles("SuperAdmin"), getSuperAdminStats);

module.exports = adminRoutes;
