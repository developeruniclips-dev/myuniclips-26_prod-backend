const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { login, userRegister, becomeScholar } = require("../controller/authController");
const { authMiddleware } = require("../middleware/auth");

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

authRouter.post('/', userRegister);
authRouter.post('/login', login);
authRouter.post('/become-scholar', authMiddleware, upload.single('taskCard'), becomeScholar);

module.exports = authRouter;
