/**
 * Secure File Upload Utilities
 * Provides secure file handling for all uploads
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Allowed extensions by category
const ALLOWED_EXTENSIONS = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    video: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
    document: ['pdf'],
    taskCard: ['jpg', 'jpeg', 'png', 'pdf']
};

// Allowed MIME types by category
const ALLOWED_MIMES = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    video: ['video/mp4', 'video/avi', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/webm'],
    document: ['application/pdf'],
    taskCard: ['image/jpeg', 'image/png', 'application/pdf']
};

/**
 * Generate a cryptographically secure random filename
 * @param {string} originalName - Original filename to extract extension
 * @returns {string} Secure random filename
 */
const generateSecureFilename = (originalName) => {
    const ext = path.extname(originalName).toLowerCase();
    const randomBytes = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now();
    return `${timestamp}_${randomBytes}${ext}`;
};

/**
 * Sanitize filename to prevent path traversal
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename
 */
const sanitizeFilename = (filename) => {
    // Remove directory traversal patterns
    return filename
        .replace(/\.\./g, '')
        .replace(/[\/\\]/g, '')
        .replace(/[<>:"|?*]/g, '');
};

/**
 * Validate file extension
 * @param {string} filename - Filename to validate
 * @param {string} category - File category (image, video, document, taskCard)
 * @returns {boolean} Whether the extension is valid
 */
const validateExtension = (filename, category) => {
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    const allowedExts = ALLOWED_EXTENSIONS[category] || [];
    return allowedExts.includes(ext);
};

/**
 * Validate MIME type
 * @param {string} mimetype - MIME type to validate
 * @param {string} category - File category
 * @returns {boolean} Whether the MIME type is valid
 */
const validateMimeType = (mimetype, category) => {
    const allowedMimes = ALLOWED_MIMES[category] || [];
    return allowedMimes.includes(mimetype);
};

/**
 * Validate bounded file/container structure; this is not a complete codec decoder.
 * Should be called after file is saved to disk
 * @param {string} filepath - Path to the file
 * @param {string} expectedExt - Expected file extension
 * @returns {Promise<boolean>} Whether the file content matches expected type
 */
const { validateFileContent } = require('../utils/uploadContent');

/**
 * Delete a file safely
 * @param {string} filepath - Path to file to delete
 */
const deleteFile = (filepath) => {
    try {
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    } catch (err) {
        require('../utils/safeLogging').logError('Upload cleanup failed', err);
    }
};

/**
 * Create a secure multer file filter
 * @param {string} category - File category (image, video, document, taskCard)
 * @returns {Function} Multer file filter function
 */
const createSecureFileFilter = (category) => {
    return (req, file, cb) => {
        // Sanitize the original name
        file.originalname = sanitizeFilename(file.originalname);
        
        // Check extension
        if (!validateExtension(file.originalname, category)) {
            return cb(new Error(`Invalid file type. Allowed: ${ALLOWED_EXTENSIONS[category].join(', ')}`), false);
        }
        
        // Check MIME type
        const mimeByExtension = { jpg:['image/jpeg'], jpeg:['image/jpeg'], png:['image/png'], gif:['image/gif'], webp:['image/webp'], pdf:['application/pdf'], mp4:['video/mp4'], mov:['video/quicktime'], avi:['video/avi','video/x-msvideo'], mkv:['video/x-matroska'], webm:['video/webm'] };
        if (!validateMimeType(file.mimetype, category) || !mimeByExtension[path.extname(file.originalname).slice(1).toLowerCase()]?.includes(file.mimetype)) {
            return cb(new Error(`Invalid MIME type. Allowed: ${ALLOWED_MIMES[category].join(', ')}`), false);
        }
        
        cb(null, true);
    };
};

/**
 * Post-upload validation middleware
 * Validates file content after upload
 * @param {string} category - File category for validation
 * @returns {Function} Express middleware
 */
const postUploadValidation = (category) => {
    return async (req, res, next) => {
        if (!req.file) {
            return next();
        }
        
        try {
            const ext = path.extname(req.file.originalname);
            const isValid = await validateFileContent(req.file.path, ext);
            
            if (!isValid) {
                // Delete the invalid file
                deleteFile(req.file.path);
                return res.status(400).json({ 
                    message: 'File content does not match expected type. File rejected.' 
                });
            }
            
            next();
        } catch (err) {
            require('../utils/safeLogging').logError('Upload validation failed', err);
            // Delete file on error to be safe
            if (req.file && req.file.path) {
                deleteFile(req.file.path);
            }
            return res.status(500).json({ message: 'Error validating file' });
        }
    };
};

module.exports = {
    generateSecureFilename,
    sanitizeFilename,
    validateExtension,
    validateMimeType,
    validateFileContent,
    deleteFile,
    createSecureFileFilter,
    postUploadValidation,
    ALLOWED_EXTENSIONS,
    ALLOWED_MIMES
};
