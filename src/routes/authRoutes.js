const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { login, userRegister, becomeScholar, refreshAccessToken, logout } = require("../controller/authController");
const { authMiddleware } = require("../middleware/auth");
const { registerValidation, loginValidation } = require("../middleware/validators");
const { generateSecureFilename, createSecureFileFilter, postUploadValidation } = require("../middleware/secureUpload");

// ===== SECURITY: Rate limiting for auth endpoints =====
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // 50 attempts per 15 minutes per IP
    message: { error: "Too many attempts, please try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

// Ensure upload directory exists
const taskCardDir = path.join(__dirname, '../../uploads/task-cards');
if (!fs.existsSync(taskCardDir)) {
    fs.mkdirSync(taskCardDir, { recursive: true });
}

// Configure multer for task card uploads with secure filenames
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, taskCardDir);
    },
    filename: function (req, file, cb) {
        // Use cryptographically secure random filename
        const secureName = generateSecureFilename(file.originalname);
        cb(null, secureName);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: createSecureFileFilter('taskCard'),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

// Post-upload content validation
const validateTaskCardContent = postUploadValidation('taskCard');

const authRouter = Router();

// Test route
authRouter.get('/test', (req, res) => res.json({ message: 'Auth routes working!' }));

// Apply rate limiting and validation to sensitive auth endpoints
authRouter.post('/', authLimiter, registerValidation, userRegister);
authRouter.post('/login', authLimiter, loginValidation, login);
authRouter.post('/become-scholar', authMiddleware, upload.single('taskCard'), validateTaskCardContent, becomeScholar);

// Token refresh and logout
authRouter.post('/refresh-token', authLimiter, refreshAccessToken);
authRouter.post('/logout', authMiddleware, logout);

module.exports = authRouter;
