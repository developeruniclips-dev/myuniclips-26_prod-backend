const ops = require('../controller/operationsController');
const { Router } = require("express");
const { 
  getAllScholarApplications, 
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
  ops.legacyReview('scholars','approve','user')
);

scholarProfileRoutes.post(
  "/reject",
  authMiddleware,
  authorizeRoles("Admin"),
  ops.legacyReview('scholars','reject','user')
);

module.exports = scholarProfileRoutes;
