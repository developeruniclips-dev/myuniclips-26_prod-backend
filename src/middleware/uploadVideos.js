const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { generateSecureFilename, createSecureFileFilter, postUploadValidation } = require("./secureUpload");

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "../../uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for local disk storage with secure filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Use cryptographically secure random filename
    const secureName = generateSecureFilename(file.originalname);
    cb(null, secureName);
  }
});

const uploadVideo = multer({
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB max
  fileFilter: createSecureFileFilter('video')
});

// Export post-upload validation middleware for content verification
const validateVideoContent = postUploadValidation('video');

module.exports = { uploadVideo, validateVideoContent };
