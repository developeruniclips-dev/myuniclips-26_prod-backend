const { Router } = require("express");
const {
    getAllUsers,
    getOneUser,
    updateUser,
    deleteUser,
    getUserProfile,
    updateUserProfile,
    deleteUserBySuperAdmin,
    getAllUsersWithRoles,
    createSuperAdmin
} = require("../controller/userController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { uploadProfileFiles } = require("../middleware/uploadProfileFiles");

const router = Router();

// Protected routes - require authentication and proper roles
router.get("/", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsers); // Only admins can list all users
router.get("/with-roles", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsersWithRoles);
router.get("/profile", authMiddleware, getUserProfile);
router.get("/:id", authMiddleware, getOneUser); // Must be logged in to view user details
router.put("/profile", authMiddleware, uploadProfileFiles, updateUserProfile);
router.put("/:id", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateUser);
router.delete("/super-admin/:id", authMiddleware, authorizeRoles("SuperAdmin"), deleteUserBySuperAdmin);
router.delete("/:id", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), deleteUser);
router.post("/create-super-admin", authMiddleware, authorizeRoles("SuperAdmin"), createSuperAdmin); // Only existing SuperAdmin can create new SuperAdmin

module.exports = router;
