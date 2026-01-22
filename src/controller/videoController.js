const { VideoModel } = require("../models/videos");
const { ScholarProfileModel } = require("../models/scholarProfile");
const vimeoClient = require("../config/vimeo");
const fs = require("fs");
const path = require("path");

const MAX_VIDEOS_PER_SUBJECT = 7;

// Upload video to Vimeo
const uploadVideo = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const scholarId = req.user.id;
    const { subjectId, title, description, sequenceIndex } = req.body;
    // Price is set by admin during approval, default to 0
    const price = 0;

    if (!req.file) return res.status(400).json({ message: "No video file received" });

    const [scholar] = await ScholarProfileModel.findByUserId(scholarId);
    if (!scholar || !scholar[0].approved) return res.status(403).json({ message: "Scholar not approved" });

    // Check if scholar has reached the 7 video limit for this subject
    const [existingVideos] = await VideoModel.countByScholarAndSubject(scholarId, Number(subjectId));
    const videoCount = existingVideos[0]?.count || 0;
    
    if (videoCount >= MAX_VIDEOS_PER_SUBJECT) {
      // Delete the uploaded file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ 
        message: `You can only upload up to ${MAX_VIDEOS_PER_SUBJECT} videos per subject. You have already uploaded ${videoCount} videos for this subject.` 
      });
    }

    // Upload to Vimeo
    const filePath = req.file.path;
    
    // Vimeo has a 128 character limit for titles
    const vimeoTitle = title.length > 128 ? title.substring(0, 125) + '...' : title;
    
    vimeoClient.upload(
      filePath,
      {
        name: vimeoTitle,
        description: description || '',
        privacy: {
          view: 'anybody', // Can be 'anybody', 'nobody', 'password', 'unlisted'
        }
      },
      async (uri) => {
        try {
          // Extract Vimeo video ID from URI (format: /videos/123456789)
          const vimeoVideoId = uri.split('/videos/')[1];
          const vimeoUrl = `https://vimeo.com/${vimeoVideoId}`;
          
          // Delete local file after successful upload
          fs.unlinkSync(filePath);

          const isFirst = Number(sequenceIndex) === 1;
          const isFree = isFirst ? true : Number(price) === 0;
          const setPrice = isFirst ? 0 : Number(price);

          await VideoModel.create(
            scholarId,
            Number(subjectId),
            title,
            description,
            vimeoUrl,
            setPrice,
            isFree,
            Number(sequenceIndex)
          );

          res.status(201).json({
            message: "Video uploaded successfully to Vimeo",
            videoUrl: vimeoUrl,
            vimeoId: vimeoVideoId,
          });
        } catch (err) {
          console.error("Database error:", err);
          res.status(500).json({ message: "Video uploaded to Vimeo but failed to save to database", error: err.message });
        }
      },
      (bytesUploaded, bytesTotal) => {
        const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2);
        console.log(`Upload progress: ${percentage}%`);
      },
      (error) => {
        console.error("Vimeo upload error:", error);
        // Delete local file on error
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        res.status(500).json({ message: "Failed to upload video to Vimeo", error: error });
      }
    );
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "Server error uploading video", error: err.message });
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
    res.status(200).json({ videos });
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
    
    // First video (sequence 1) is always free
    let finalPrice = video.sequence_index === 1 ? 0 : (price || 0);
    
    await VideoModel.approve(videoId, finalPrice);
    
    res.status(200).json({ 
      message: "Video approved successfully",
      price: finalPrice
    });
  } catch (err) {
    console.error("Error approving video:", err);
    res.status(500).json({ message: "Server error approving video" });
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

    await VideoModel.deleteById(videoId);
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(500).json({ message: "Server error deleting video" });
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

    await VideoModel.deleteById(videoId);
    
    res.status(200).json({ message: "Video deleted successfully" });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(500).json({ message: "Server error deleting video" });
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
