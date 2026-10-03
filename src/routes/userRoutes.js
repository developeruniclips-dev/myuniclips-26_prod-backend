const ops = require('../controller/operationsController');
const { Router } = require("express");
const {
    getAllUsers,
    getUserProfile,
    updateUserProfile,
    getAllUsersWithRoles
} = require("../controller/userController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");
const { uploadProfileFiles } = require("../middleware/uploadProfileFiles");

const router = Router();

// Protected routes - require authentication and proper roles
router.get("/", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsers); // Only admins can list all users
router.get("/with-roles", authMiddleware, authorizeRoles("Admin", "SuperAdmin"), getAllUsersWithRoles);
router.get("/profile", authMiddleware, getUserProfile);
router.get("/:id", authMiddleware, async (req,res) => {
    try { const {pool}=require('../config/db'); const {actorFromDb,staff}=require('../services/operations/common');const actor=await actorFromDb(pool,req.user);
      if(Number(req.params.id)!==actor.id&&!staff(actor))return res.status(403).json({message:'Access denied'});
      const [[row]]=await pool.query('SELECT id,fname,lname,email,created_at FROM users WHERE id=?',[req.params.id]);
      if(!row)return res.status(404).json({message:'User not found'});res.json(row);
    } catch {res.status(503).json({message:'Unable to retrieve profile'});}
  }); // Must be logged in to view user details
router.put("/profile", authMiddleware, uploadProfileFiles, updateUserProfile);
router.put("/:id", authMiddleware, authorizeRoles("SuperAdmin"), ops.updatePerson);
router.delete("/super-admin/:id", authMiddleware, authorizeRoles("SuperAdmin"), ops.deleteUser);
router.delete("/:id", authMiddleware, authorizeRoles("SuperAdmin"), ops.deleteUser);
router.post("/create-super-admin", authMiddleware, authorizeRoles("SuperAdmin"), ops.createAdmin); // Only existing SuperAdmin can create new SuperAdmin

module.exports = router;
