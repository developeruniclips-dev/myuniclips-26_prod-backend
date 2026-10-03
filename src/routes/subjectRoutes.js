const ops = require('../controller/operationsController');
const { Router } = require("express");
const { 
    getAllSubjects, 
    getOneSubject, 
    getAllPrograms, 
    getSubjectsByProgram,
    getSubjectBundlePrice
} = require("../controller/subjectController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const subjectRoutes = Router();

subjectRoutes.get('/', getAllSubjects);
subjectRoutes.get('/programs/all', getAllPrograms);
subjectRoutes.get('/by-program/:program', getSubjectsByProgram);
subjectRoutes.get('/:id', getOneSubject);
subjectRoutes.post('/', authMiddleware, authorizeRoles("SuperAdmin"), ops.unavailable); // Protected: Only admins can create subjects

// Bundle price management
subjectRoutes.get('/:id/bundle-price', getSubjectBundlePrice);
subjectRoutes.put('/:id/bundle-price', authMiddleware, authorizeRoles("SuperAdmin"), ops.price);
subjectRoutes.put('/:id/price', authMiddleware, authorizeRoles("SuperAdmin"), ops.price);

module.exports = subjectRoutes;
