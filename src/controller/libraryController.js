const { pool } = require('../config/db');
const { annotateCourses } = require('../utils/generalCourses');
const access=require('../services/contentAuthorization').createContentAuthorization(pool);
const safeFailure=(res,error)=>{require('../utils/safeLogging').logError('Library content request failed',error);return res.status(error.status||503).json({message:error.status?error.message:'Library is temporarily unavailable'});};

// Add course to library
const addToLibrary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subjectId, scholarId } = req.body;

    if (!subjectId || !scholarId) {
      return res.status(400).json({ message: 'Subject ID and Scholar ID are required' });
    }
    await access.course(req.user,subjectId,scholarId);

    await pool.query(
      `INSERT INTO user_library (user_id, subject_id, scholar_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE added_at = CURRENT_TIMESTAMP`,
      [userId, subjectId, scholarId]
    );

    res.status(200).json({ message: 'Course added to library', success: true });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Remove course from library
const removeFromLibrary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subjectId, scholarId } = req.body;

    await pool.query(
      'DELETE FROM user_library WHERE user_id = ? AND subject_id = ? AND scholar_id = ?',
      [userId, subjectId, scholarId]
    );

    res.status(200).json({ message: 'Course removed from library', success: true });
  } catch (error) {
    console.error('Error removing from library:', error);
    res.status(500).json({ message: 'Failed to remove course from library' });
  }
};

// Get user's library with progress
const getMyLibrary = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all courses in user's library
    const [library] = await pool.query(`
      SELECT 
        ul.id,
        ul.subject_id,
        ul.scholar_id,
        ul.added_at,
        s.name AS subject_name,
        s.degree_programmes,
        u.fname AS scholar_fname,
        u.lname AS scholar_lname,
        sp.university AS scholar_university
      FROM user_library ul
      JOIN subjects s ON ul.subject_id = s.id
      JOIN users u ON ul.scholar_id = u.id
      LEFT JOIN scholar_profile sp ON ul.scholar_id = sp.user_id
      JOIN scholar_subjects ss ON ss.subject_id=ul.subject_id AND ss.scholar_user_id=ul.scholar_id
      JOIN course_workflows cw ON cw.offering_id=ss.id AND cw.state='PUBLISHED'
      WHERE ul.user_id = ? AND sp.approved=1 AND ss.approved=1
      ORDER BY ul.added_at DESC
    `, [userId]);

    // For each course, get video count and progress
    const libraryWithProgress = await Promise.all(library.map(async (course) => {
      // Get all videos for this course
      const [videos] = await pool.query(`
        SELECT v.id, v.title, v.price, v.sequence_index,
          v.id=(SELECT first.id FROM videos first WHERE first.subject_id=v.subject_id AND first.scholar_user_id=v.scholar_user_id ORDER BY first.sequence_index,first.id LIMIT 1) AS is_free
        FROM videos v
        WHERE v.subject_id = ? AND v.scholar_user_id = ? AND v.approved = 1
        ORDER BY v.sequence_index
      `, [course.subject_id, course.scholar_id]);

      // Get progress for these videos
      const [progress] = await pool.query(`
        SELECT video_id, watched
        FROM video_progress
        WHERE user_id = ? AND video_id IN (?)
      `, [userId, videos.length > 0 ? videos.map(v => v.id) : [0]]);

      const progressMap = {};
      progress.forEach(p => { progressMap[p.video_id] = p.watched; });

      const totalVideos = videos.length;
      const watchedVideos = progress.filter(p => p.watched).length;
      const progressPercent = totalVideos > 0 ? Math.round((watchedVideos / totalVideos) * 100) : 0;

      // Get first video thumbnail
      const thumbnailUrl = '/course-fallback.svg';

      return {
        ...course,
        thumbnailUrl,
        totalVideos,
        watchedVideos,
        progressPercent,
        videos: videos.map(v => ({
          ...v,
          watched: progressMap[v.id] || false
        }))
      };
    }));

    res.status(200).json({ library: await annotateCourses(pool, libraryWithProgress) });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Check if course is in library
const isInLibrary = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subjectId, scholarId } = req.query;

    const [rows] = await pool.query(
      'SELECT id FROM user_library WHERE user_id = ? AND subject_id = ? AND scholar_id = ?',
      [userId, subjectId, scholarId]
    );

    res.status(200).json({ inLibrary: rows.length > 0 });
  } catch (error) {
    console.error('Error checking library:', error);
    res.status(500).json({ message: 'Failed to check library status' });
  }
};

// Mark video as watched
const markVideoWatched = async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.body;
    await access.playback(req.user,videoId);

    await pool.query(
      `INSERT INTO video_progress (user_id, video_id, watched, watched_at)
       VALUES (?, ?, TRUE, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE watched = TRUE, watched_at = CURRENT_TIMESTAMP`,
      [userId, videoId]
    );

    res.status(200).json({ message: 'Video marked as watched', success: true });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Get video progress for a course
const getCourseProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { subjectId, scholarId } = req.query;

    // Get all videos for this course
    await access.course(req.user,subjectId,scholarId);
    const [videos] = await pool.query(`
      SELECT id FROM videos
      WHERE subject_id = ? AND scholar_user_id = ? AND approved = 1
    `, [subjectId, scholarId]);

    if (videos.length === 0) {
      return res.status(200).json({ progress: [], totalVideos: 0, watchedVideos: 0, progressPercent: 0 });
    }

    // Get progress
    const [progress] = await pool.query(`
      SELECT video_id, watched, watched_at
      FROM video_progress
      WHERE user_id = ? AND video_id IN (?)
    `, [userId, videos.map(v => v.id)]);

    const watchedVideos = progress.filter(p => p.watched).length;
    const progressPercent = Math.round((watchedVideos / videos.length) * 100);

    res.status(200).json({
      progress,
      totalVideos: videos.length,
      watchedVideos,
      progressPercent
    });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Save video playback progress (timestamp)
const saveVideoProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId, progressSeconds } = req.body;

    if (!videoId || progressSeconds === undefined) {
      return res.status(400).json({ message: 'Video ID and progress seconds are required' });
    }
    if(!Number.isSafeInteger(progressSeconds)||progressSeconds<0||progressSeconds>86400)return res.status(400).json({message:'Invalid playback progress'});
    await access.playback(req.user,videoId);

    await pool.query(
      `INSERT INTO video_progress (user_id, video_id, progress_seconds, watched_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE progress_seconds = ?, watched_at = CURRENT_TIMESTAMP`,
      [userId, videoId, progressSeconds, progressSeconds]
    );

    res.status(200).json({ message: 'Progress saved', success: true });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Get video playback progress (timestamp)
const getVideoProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { videoId } = req.query;

    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }
    await access.playback(req.user,videoId);

    const [rows] = await pool.query(
      `SELECT progress_seconds, watched FROM video_progress WHERE user_id = ? AND video_id = ?`,
      [userId, videoId]
    );

    if (rows.length === 0) {
      return res.status(200).json({ progressSeconds: 0, watched: false });
    }

    res.status(200).json({ 
      progressSeconds: rows[0].progress_seconds || 0,
      watched: rows[0].watched || false
    });
  } catch (error) {
    safeFailure(res,error);
  }
};

// Dashboard summary reads existing playback records; it never writes progress.
const getLearningProgress = async (req, res) => {
  try {
    const [progress] = await pool.query(`
      SELECT vp.video_id, vp.watched, vp.progress_seconds, vp.watched_at,
             v.subject_id, v.scholar_user_id AS scholar_id, v.title
      FROM video_progress vp
      JOIN videos v ON v.id = vp.video_id
      WHERE vp.user_id = ? AND v.approved = 1
    `, [req.user.id]);
    res.json({ progress });
  } catch (error) {
    res.status(500).json({ message: 'Unable to load learning progress' });
  }
};

module.exports = {
  getLearningProgress,
  addToLibrary,
  removeFromLibrary,
  getMyLibrary,
  isInLibrary,
  markVideoWatched,
  getCourseProgress,
  saveVideoProgress,
  getVideoProgress
};
