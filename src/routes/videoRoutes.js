const ops = require('../controller/operationsController');
const { Router } = require('express');
const { getAllVideos, getAllVideosAdmin, getVideo, listVideosBySubject, uploadVideo, watchVideo, deleteVideoByScholar, getScholarVideos } = require('../controller/videoController');
const { authMiddleware } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { uploadVideo: uploadMiddleware } = require('../middleware/uploadVideos');

const videoRoutes = Router();
const content = require('../controller/courseContentController');
videoRoutes.get('/limits', (req, res) => res.json(require('../config/courseLimits')));
videoRoutes.get('/scholar/courses/:subjectId', authMiddleware, authorizeRoles('Scholar'), content.getCourseContent);
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

videoRoutes.get('/:id', getVideo);
videoRoutes.post(
  "/",
  authMiddleware,
  authorizeRoles("Scholar"),
  (req, res, next) => uploadMiddleware.single('video')(req, res, error => {
    if (error) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Each video must be no larger than 1 GB' : 'Invalid video upload' });
    next();
  }),
  uploadVideo
);
videoRoutes.get('/:subjectId', listVideosBySubject);
videoRoutes.get('/watch/:id', watchVideo);

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
