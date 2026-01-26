const { Router } = require("express");
const {
    getAdminProfile,
    updateAdminProfile,
    getAllUsers,
    createAdmin,
    updateUserRole,
    deleteUser,
    getSecurityUpdates,
    createSecurityUpdate,
    updateSecurityStatus,
    getActivityLog,
    getSuperAdminStats
} = require("../controller/adminController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const adminRoutes = Router();

// Profile routes (Admin + SuperAdmin)
adminRoutes.get('/profile', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAdminProfile);
adminRoutes.put('/profile', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateAdminProfile);

// User management routes (SuperAdmin only)
adminRoutes.get('/users', authMiddleware, authorizeRoles("SuperAdmin"), getAllUsers);
adminRoutes.post('/users/create-admin', authMiddleware, authorizeRoles("SuperAdmin"), createAdmin);
adminRoutes.put('/users/:userId/role', authMiddleware, authorizeRoles("SuperAdmin"), updateUserRole);
adminRoutes.delete('/users/:userId', authMiddleware, authorizeRoles("SuperAdmin"), deleteUser);

// Security updates routes (Admin + SuperAdmin)
adminRoutes.get('/security-updates', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getSecurityUpdates);
adminRoutes.post('/security-updates', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), createSecurityUpdate);
adminRoutes.put('/security-updates/:id/status', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateSecurityStatus);

// Activity log (SuperAdmin only)
adminRoutes.get('/activity-log', authMiddleware, authorizeRoles("SuperAdmin"), getActivityLog);

// SuperAdmin stats
adminRoutes.get('/stats', authMiddleware, authorizeRoles("SuperAdmin"), getSuperAdminStats);

module.exports = adminRoutes;
