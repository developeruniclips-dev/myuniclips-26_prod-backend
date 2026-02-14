/**
 * Secure File Upload Utilities
 * Provides secure file handling for all uploads
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// File type magic bytes signatures
const MAGIC_BYTES = {
    // Images
    'jpg': [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }],
    'jpeg': [{ offset: 0, bytes: [0xFF, 0xD8, 0xFF] }],
    'png': [{ offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }],
    'gif': [{ offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }],
    'webp': [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
    
    // Videos
    'mp4': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }], // ftyp
    'avi': [{ offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }],
    'mov': [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74] }],
    'webm': [{ offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] }],
    'mkv': [{ offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] }],
    
    // Documents
    'pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
};

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
 * Validate file content by checking magic bytes (file signature)
 * Should be called after file is saved to disk
 * @param {string} filepath - Path to the file
 * @param {string} expectedExt - Expected file extension
 * @returns {Promise<boolean>} Whether the file content matches expected type
 */
const validateFileContent = async (filepath, expectedExt) => {
    const ext = expectedExt.toLowerCase().replace('.', '');
    const signatures = MAGIC_BYTES[ext];
    
    if (!signatures) {
        // If we don't have a signature for this type, allow it (but log warning)
        console.warn(`No magic byte signature defined for extension: ${ext}`);
        return true;
    }
    
    return new Promise((resolve, reject) => {
        const buffer = Buffer.alloc(16);
        fs.open(filepath, 'r', (err, fd) => {
            if (err) {
                reject(err);
                return;
            }
            
            fs.read(fd, buffer, 0, 16, 0, (err, bytesRead) => {
                fs.close(fd, () => {});
                
                if (err) {
                    reject(err);
                    return;
                }
                
                // Check all signatures for this type
                for (const sig of signatures) {
                    let matches = true;
                    for (let i = 0; i < sig.bytes.length; i++) {
                        if (buffer[sig.offset + i] !== sig.bytes[i]) {
                            matches = false;
                            break;
                        }
                    }
                    if (matches) {
                        resolve(true);
                        return;
                    }
                }
                
                resolve(false);
            });
        });
    });
};

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
        console.error('Error deleting file:', err);
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
        if (!validateMimeType(file.mimetype, category)) {
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
            console.error('Error validating file content:', err);
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
