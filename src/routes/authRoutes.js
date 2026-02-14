const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
const { login, userRegister, becomeScholar } = require("../controller/authController");
const { authMiddleware } = require("../middleware/auth");
const { registerValidation, loginValidation } = require("../middleware/validators");

// ===== SECURITY: Strict rate limiting for auth endpoints =====
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per 15 minutes per IP
    message: { error: "Too many attempts, please try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

// Ensure upload directory exists
const taskCardDir = path.join(__dirname, '../../uploads/task-cards');
if (!fs.existsSync(taskCardDir)) {
    fs.mkdirSync(taskCardDir, { recursive: true });
}

// Configure multer for task card uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, taskCardDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'taskcard-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPG, PNG and PDF are allowed.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB max
});

const authRouter = Router();

// Test route
authRouter.get('/test', (req, res) => res.json({ message: 'Auth routes working!' }));

// Apply rate limiting and validation to sensitive auth endpoints
authRouter.post('/', authLimiter, registerValidation, userRegister);
authRouter.post('/login', authLimiter, loginValidation, login);
authRouter.post('/become-scholar', authMiddleware, upload.single('taskCard'), becomeScholar);

module.exports = authRouter;
