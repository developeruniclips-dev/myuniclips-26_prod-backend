const ops = require('../controller/operationsController');
const { Router } = require('express');
const { deleteSubjectByScholar, getAllScholarSubjects, getScholarSubjectsStatus, requestSubject, getAllScholarSubjectsAdmin } = require('../controller/scholarSubjectController');
const { authMiddleware } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');

const scholarSubjectRouter = Router();

scholarSubjectRouter.get('/available', authMiddleware, authorizeRoles('Scholar'), async (req, res) => {
    try {
        const { pool } = require('../config/db');
        const { scholarContext, availableSubjects } = require('../utils/academicContext');
        const profile = await scholarContext(pool, req.user.id);
        if (!profile?.approved) return res.status(403).json({ message: 'Scholar approval is required' });
        if (!profile.university_id) return res.status(409).json({ message: 'Your academic profile needs review. Please contact support.' });
        res.json({ subjects: await availableSubjects(pool, profile) });
    } catch { res.status(500).json({ message: 'Unable to load available subjects' }); }
});

scholarSubjectRouter.post('/', authMiddleware, authorizeRoles("Scholar"), requestSubject);
scholarSubjectRouter.post('/approve', authMiddleware, authorizeRoles("Admin"), ops.legacyReview('courses','approve','offering'));
scholarSubjectRouter.put('/approve/:id', authMiddleware, authorizeRoles("Admin"), ops.legacyReview('courses','approve'));
scholarSubjectRouter.delete('/my/:id', authMiddleware, authorizeRoles("Scholar"), deleteSubjectByScholar);
scholarSubjectRouter.delete('/:id', authMiddleware, authorizeRoles("Admin"), ops.legacyReview('courses','reject'));
scholarSubjectRouter.get('/status', authMiddleware, authorizeRoles("Scholar"), getScholarSubjectsStatus);
scholarSubjectRouter.get('/by-user', authMiddleware, authorizeRoles("Scholar"), getAllScholarSubjects);
scholarSubjectRouter.get('/all', authMiddleware, authorizeRoles("Admin"), getAllScholarSubjectsAdmin);

module.exports = scholarSubjectRouter;
