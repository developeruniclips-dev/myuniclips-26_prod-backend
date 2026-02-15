const { Router } = require('express');
const { getAllVideos, getAllVideosAdmin, getVideo, listVideosBySubject, uploadVideo, watchVideo, approveVideo, deleteVideo, deleteVideoByScholar, getScholarVideos } = require('../controller/videoController');
const { authMiddleware } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');
const { uploadVideo: uploadMiddleware } = require('../middleware/uploadVideos');

const videoRoutes = Router();

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
  uploadMiddleware.single("video"), // field name for the uploaded file
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
  approveVideo
);
videoRoutes.delete(
  "/:id",
  authMiddleware,
  authorizeRoles("Admin"),
  deleteVideo
);

module.exports = videoRoutes;
