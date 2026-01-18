const { Router } = require("express");
const { 
  getAllScholarApplications, 
  approveScholarApplication, 
  rejectScholarApplication,
  getScholarProfileStatus
} = require("../controller/scholarProfileController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const scholarProfileRoutes = Router();

// Scholar routes - check own profile status
// Any authenticated user can check their scholar application status
scholarProfileRoutes.get(
  "/status",
  authMiddleware,
  getScholarProfileStatus
);

// Admin only routes
scholarProfileRoutes.get(
  "/applications",
  authMiddleware,
  authorizeRoles("Admin"),
  getAllScholarApplications
);

scholarProfileRoutes.post(
  "/approve",
  authMiddleware,
  authorizeRoles("Admin"),
  approveScholarApplication
);

scholarProfileRoutes.post(
  "/reject",
  authMiddleware,
  authorizeRoles("Admin"),
  rejectScholarApplication
);

module.exports = scholarProfileRoutes;
