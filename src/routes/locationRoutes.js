const { Router } = require("express");
const {
    getAllCountries,
    getUniversitiesByCountry,
    getAllUniversities,
    getProgramsByUniversity,
    getSubjectsByUniversityAndProgram,
    addCountry,
    addUniversity
} = require("../controller/locationController");
const { authMiddleware } = require("../middleware/auth");
const { authorizeRoles } = require("../middleware/roles");

const locationRoutes = Router();

// Public routes - for scholar application form
locationRoutes.get('/countries', getAllCountries);
locationRoutes.get('/universities/by-country/:countryId', getUniversitiesByCountry);
locationRoutes.get('/universities', getAllUniversities);
locationRoutes.get('/programs/by-university/:universityId', getProgramsByUniversity);
locationRoutes.get('/subjects/by-university/:universityId/program/:program', getSubjectsByUniversityAndProgram);

// Admin routes - for managing locations
locationRoutes.post('/countries', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), addCountry);
locationRoutes.post('/universities', authMiddleware, authorizeRoles("Admin", "SuperAdmin"), addUniversity);

module.exports = locationRoutes;
