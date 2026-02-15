const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { generateSecureFilename, createSecureFileFilter } = require('./secureUpload');

// Ensure uploads directory exists
const profileImagesDir = 'uploads/profile-images';

if (!fs.existsSync(profileImagesDir)) {
  fs.mkdirSync(profileImagesDir, { recursive: true });
}

// Configure storage with secure filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'profileImage') {
      cb(null, profileImagesDir);
    } else {
      cb(new Error('Unexpected field'));
    }
  },
  filename: (req, file, cb) => {
    // Use cryptographically secure random filename
    const secureName = generateSecureFilename(file.originalname);
    cb(null, secureName);
  }
});

// Multer configuration - only accepts profile image
const uploadProfileFiles = multer({
  storage: storage,
  limits: { 
    fileSize: 5 * 1024 * 1024, // 5MB limit per file
  },
  fileFilter: createSecureFileFilter('image')
}).single('profileImage');

module.exports = { uploadProfileFiles };
