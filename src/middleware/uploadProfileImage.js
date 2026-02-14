const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { generateSecureFilename, createSecureFileFilter, postUploadValidation } = require('./secureUpload');

// Ensure uploads directory exists
const uploadDir = 'uploads/profile-images';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage with secure filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Use cryptographically secure random filename
    const secureName = generateSecureFilename(file.originalname);
    cb(null, secureName);
  }
});

// Multer configuration with secure file filter
const uploadProfileImage = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: createSecureFileFilter('image')
}).single('profileImage');

// Post-upload content validation
const validateImageContent = postUploadValidation('image');

// Error handling wrapper
const uploadProfileImageMiddleware = (req, res, next) => {
  uploadProfileImage(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'File size too large. Maximum size is 5MB' });
      }
      return res.status(400).json({ message: err.message });
    } else if (err) {
      return res.status(400).json({ message: err.message });
    }
    // Validate file content after upload
    validateImageContent(req, res, next);
  });
};

module.exports = { uploadProfileImageMiddleware };
