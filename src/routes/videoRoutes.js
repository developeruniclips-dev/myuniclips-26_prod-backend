const ops = require('../controller/operationsController');
const { Router } = require('express');
const { getAllVideos, getAllVideosAdmin, getVideo, getLearnerCourse, requireCurrentScholar, listVideosBySubject, uploadVideo, watchVideo, deleteVideoByScholar, getScholarVideos } = require('../controller/videoController');
const { authMiddleware } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { uploadVideo: uploadMiddleware } = require('../middleware/uploadVideos');

const { videoAdmission } = require('../middleware/uploadAdmission');
const videoRoutes = Router();
const content = require('../controller/courseContentController');
videoRoutes.post('/scholar/courses/:subjectId/submit',authMiddleware,authorizeRoles('Scholar'),require('../controller/videoController').submitCourse);
videoRoutes.get('/:id/readiness',authMiddleware,require('../controller/videoController').reviewReadiness);
videoRoutes.get('/limits', (req, res) => res.json(require('../config/courseLimits')));
videoRoutes.get('/scholar/courses/:subjectId', authMiddleware, authorizeRoles('Scholar'), requireCurrentScholar, content.getCourseContent);
videoRoutes.put('/scholar/courses/:subjectId/order', authMiddleware, authorizeRoles('Scholar'), content.reorderCourse);
videoRoutes.patch('/my/:id', authMiddleware, authorizeRoles('Scholar'), content.editVideo);

videoRoutes.get('/all-videos', getAllVideos);

// Admin route - get all videos including unapproved
videoRoutes.get(
  '/admin/all',
  authMiddleware,
  authorizeRoles("Admin", "SuperAdmin"),
  getAllVideosAdmin
);

// Scholar's own videos - must be before /:id to avoid conflict
videoRoutes.get(
  "/scholar/my-videos",
  authMiddleware,
  authorizeRoles("Scholar"),
  getScholarVideos
);

videoRoutes.get('/courses/:subjectId/:scholarId', authMiddleware, getLearnerCourse);
videoRoutes.get('/subject/:subjectId', authMiddleware, listVideosBySubject);
videoRoutes.get('/:id', authMiddleware, getVideo);
videoRoutes.post(
  "/",
  authMiddleware,
  authorizeRoles("Scholar"),
  videoAdmission,
  uploadMiddleware,
  uploadVideo
);
videoRoutes.get('/watch/:id', authMiddleware, watchVideo);

// Scholar routes - delete their own videos
videoRoutes.delete(
  "/my/:id",
  authMiddleware,
  authorizeRoles("Scholar"),
  deleteVideoByScholar
);

// Admin routes
videoRoutes.put(
  "/:id/approve",
  authMiddleware,
  authorizeRoles("Admin"),
  ops.legacyReview('videos','approve')
);
videoRoutes.delete(
  "/:id",
  authMiddleware,
  authorizeRoles("Admin"),
  ops.legacyReview('videos','reject')
);

module.exports = videoRoutes;
