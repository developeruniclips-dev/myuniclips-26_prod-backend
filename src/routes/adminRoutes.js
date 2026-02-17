const { Router } = require("express");
const {
    getAdminProfile,
    updateAdminProfile,
    getAllUsers,
    createAdmin,
    updateUserRole,
    deleteUser,
    getOrphanedUsers,
    cleanupOrphanedUser,
    getSecurityUpdates,
    createSecurityUpdate,
    updateSecurityStatus,
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
adminRoutes.put('/profile', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateAdminProfile);

// User management routes
adminRoutes.get('/users', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsers);
adminRoutes.get('/users/orphaned', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getOrphanedUsers);
adminRoutes.post('/users/create-admin', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), createAdmin);
adminRoutes.put('/users/:userId/role', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), updateUserRole);
adminRoutes.delete('/users/orphaned/:userId', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), cleanupOrphanedUser);
adminRoutes.delete('/users/:userId', authMiddleware, strictIPWhitelist, authorizeRoles("SuperAdmin"), deleteUser);

// Security updates routes (Admin + SuperAdmin)
adminRoutes.get('/security-updates', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getSecurityUpdates);
adminRoutes.post('/security-updates', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), createSecurityUpdate);
adminRoutes.put('/security-updates/:id/status', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateSecurityStatus);

// Activity log (SuperAdmin only)
adminRoutes.get('/activity-log', authMiddleware, authorizeRoles("SuperAdmin"), getActivityLog);

// SuperAdmin stats
adminRoutes.get('/stats', authMiddleware, authorizeRoles("SuperAdmin"), getSuperAdminStats);

module.exports = adminRoutes;
