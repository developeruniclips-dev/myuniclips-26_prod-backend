const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const {
  addToLibrary,
  removeFromLibrary,
  getMyLibrary,
  isInLibrary,
  markVideoWatched,
  getCourseProgress,
  saveVideoProgress,
  getVideoProgress,
  getLearningProgress
} = require('../controller/libraryController');

// All routes require authentication
router.use(authMiddleware);

// Library management
router.post('/add', addToLibrary);
router.post('/remove', removeFromLibrary);
router.get('/my-library', getMyLibrary);
router.get('/check', isInLibrary);

// Progress tracking
router.post('/mark-watched', markVideoWatched);
router.get('/progress', getCourseProgress);
router.get('/learning-progress', getLearningProgress);
router.post('/save-progress', saveVideoProgress);
router.get('/video-progress', getVideoProgress);

module.exports = router;
