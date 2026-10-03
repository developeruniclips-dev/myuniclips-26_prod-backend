const { VideoModel } = require("../models/videos");
const vimeoClient = require("../config/vimeo");
const fs = require("fs");

const { pool } = require('../config/db');
const { annotateCourses } = require('../utils/generalCourses');
const { ownedCourse, courseVideos, withCourseLock, validateUpload, validateMetadata, fail } = require('../utils/courseContent');

const uploadVideo = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No video file received' });
    const { title, description } = validateMetadata(req.body);
    const scholarId = req.user.id;
    const subjectId = Number(req.body.subjectId);
    const result = await withCourseLock(pool, scholarId, subjectId, async db => {
      await ownedCourse(db, scholarId, subjectId);
      const videos = await courseVideos(db, scholarId, subjectId);
      validateUpload(videos, req.file.size);
      const sequence = Math.max(0, ...videos.map(v => Number(v.sequence_index))) + 1;
      const uri = await new Promise((resolve, reject) => {
        // Vimeo has its own shorter metadata limits. Store media under a technical label;
        // retain the complete learner-facing text in UniClips, just as metadata edits do.
        vimeoClient.upload(req.file.path, { name: `UniClips course ${subjectId} lesson ${sequence}`, description: 'Lesson details are managed in UniClips.', privacy: { view: 'anybody' } },
          resolve, () => {}, () => reject(new Error('Vimeo upload failed')));
      });
      const vimeoId = uri.split('/videos/')[1];
      const videoUrl = `https://vimeo.com/${vimeoId}`;
      // Approval may have been revoked by an administrator during a long upload.
      await ownedCourse(db, scholarId, subjectId);
      await db.query(`INSERT INTO videos (scholar_user_id, subject_id, title, description, video_url, price, is_free, sequence_index)
        VALUES (?, ?, ?, ?, ?, 0, 1, ?)`, [scholarId, subjectId, title, description, videoUrl, sequence]);
      return { videoUrl, vimeoId };
    });
    res.status(201).json({ message: 'Video uploaded successfully to Vimeo', ...result });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : 'Unable to upload video. Please contact support before retrying if the transfer completed.' });
  } finally {
    if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
  }
};

// Get single video
const getVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const [rows] = await VideoModel.findById(videoId);

    if (rows.length === 0) return res.status(404).json({ message: "Video not found" });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// List videos by subject
const listVideosBySubject = async (req, res) => {
  try {
    const subjectId = Number(req.params.subjectId);
    const [rows] = await VideoModel.findBySubject(subjectId);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Watch video
const watchVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    if (isNaN(videoId)) return res.status(400).json({ message: "Invalid video ID" });

    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) return res.status(404).json({ message: "Video not found" });

    const video = rows[0];

    res.json(video);
  } catch (err) {
    console.error("Error fetching video:", err);
    res.status(500).json({ message: "Server error", error: err });
  }
};

// Get all videos
const getAllVideos = async (req, res) => {
  try {
    const [videos] = await VideoModel.getAllVideos();
    const annotated = await annotateCourses(pool, videos);
    res.status(200).json({ videos: req.query.category === 'general'
      ? annotated.filter(video => video.is_general_university_course) : annotated });
  } catch (err) {
    console.error("Error fetching videos:", err);
    res.status(500).json({ message: "Server error fetching videos" });
  }
};

// Get scholar's own videos
const getScholarVideos = async (req, res) => {
  try {
    const scholarId = req.user.id;
    const [videos] = await VideoModel.findByScholar(scholarId);
    res.status(200).json({ videos });
  } catch (err) {
    console.error("Error fetching scholar videos:", err);
    res.status(500).json({ message: "Server error fetching videos" });
  }
};

// Approve video with price (Admin only)
const approveVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const { price } = req.body;
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    const video = rows[0];
    const finalPrice = await withCourseLock(pool, video.scholar_user_id, video.subject_id, async db => {
      const [[current]] = await db.query('SELECT * FROM videos WHERE id = ?', [videoId]);
      if (!current) fail(404, 'Video not found');
      const amount = Number(current.sequence_index) === 1 ? 0 : Number(price || 0);
      if (!Number.isFinite(amount) || amount < 0) fail(400, 'Invalid price');
      await db.query('UPDATE videos SET approved = 1, price = ?, is_free = ? WHERE id = ?', [amount, amount === 0 ? 1 : 0, videoId]);
      return amount;
    });

    res.status(200).json({ 
      message: "Video approved successfully",
      price: finalPrice
    });
  } catch (err) {
    console.error("Error approving video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error approving video" });
  }
};

// Delete/Reject video (Admin only)
const deleteVideo = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    await withCourseLock(pool, rows[0].scholar_user_id, rows[0].subject_id, async db => {
      await db.query('DELETE FROM videos WHERE id = ?', [videoId]);
    });
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error deleting video" });
  }
};

// Delete video by scholar (only their own)
const deleteVideoByScholar = async (req, res) => {
  try {
    const videoId = Number(req.params.id);
    const scholarId = req.user.id;
    
    if (isNaN(videoId)) {
      return res.status(400).json({ message: "Invalid video ID" });
    }

    // Check if video exists and belongs to this scholar
    const [rows] = await VideoModel.findById(videoId);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Video not found" });
    }

    if (rows[0].scholar_user_id !== scholarId) {
      return res.status(403).json({ message: "You can only delete your own videos" });
    }

    await withCourseLock(pool, scholarId, rows[0].subject_id, async db => {
      await ownedCourse(db, scholarId, rows[0].subject_id);
      const [result] = await db.query('DELETE FROM videos WHERE id = ? AND scholar_user_id = ? AND approved = 0', [videoId, scholarId]);
      if (!result.affectedRows) fail(409, 'Approved videos cannot be deleted by scholars');
    });
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(err.status || 500).json({ message: err.status ? err.message : "Server error deleting video" });
  }
};

// Get all videos for admin (including unapproved)
const getAllVideosAdmin = async (req, res) => {
  try {
    const [videos] = await VideoModel.getAllVideosAdmin();
    res.status(200).json({ videos });
  } catch (err) {
    console.error("Error fetching admin videos:", err);
    res.status(500).json({ message: "Server error fetching videos" });
  }
};

module.exports = {
  uploadVideo,
  getVideo,
  listVideosBySubject,
  watchVideo,
  getAllVideos,
  getAllVideosAdmin,
  getScholarVideos,
  approveVideo,
  deleteVideo,
  deleteVideoByScholar
};
