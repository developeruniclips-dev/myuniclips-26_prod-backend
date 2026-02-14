const { Router } = require("express");
const { 
    createSubject, 
    getAllSubjects, 
    getOneSubject, 
    getAllPrograms, 
    getSubjectsByProgram,
    updateBundlePrice,
    getSubjectBundlePrice
} = require("../controller/subjectController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const subjectRoutes = Router();

subjectRoutes.get('/', getAllSubjects);
subjectRoutes.get('/programs/all', getAllPrograms);
subjectRoutes.get('/by-program/:program', getSubjectsByProgram);
subjectRoutes.get('/:id', getOneSubject);
subjectRoutes.post('/', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), createSubject); // Protected: Only admins can create subjects

// Bundle price management
subjectRoutes.get('/:id/bundle-price', getSubjectBundlePrice);
subjectRoutes.put('/:id/bundle-price', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateBundlePrice);
subjectRoutes.put('/:id/price', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), updateBundlePrice);

module.exports = subjectRoutes;
