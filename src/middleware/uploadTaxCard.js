const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { generateSecureFilename, createSecureFileFilter, postUploadValidation } = require('./secureUpload');

// Ensure uploads directory exists
const uploadDir = 'uploads/tax-cards';
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

const uploadTaxCard = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: createSecureFileFilter('taskCard') // taskCard allows PDF and images
}).single('taxCard');

// Export post-upload validation middleware
const validateTaxCardContent = postUploadValidation('taskCard');

module.exports = { uploadTaxCard, validateTaxCardContent };
