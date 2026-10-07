const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { login, userRegister, becomeScholar, refreshAccessToken, logout } = require("../controller/authController");
const { authMiddleware } = require("../middleware/auth");
const { registerValidation, loginValidation } = require("../middleware/validators");
const { createUpload } = require('../middleware/uploadSecurity');
const { applicantAdmission } = require('../middleware/uploadAdmission');

// ===== SECURITY: Rate limiting for auth endpoints =====
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // 50 attempts per 15 minutes per IP
    message: { error: "Too many attempts, please try again in 15 minutes" },
    standardHeaders: true,
    legacyHeaders: false,
});

const uploadTaskCard = createUpload('taskCard');

const authRouter = Router();

// Test route
authRouter.get('/test', (req, res) => res.json({ message: 'Auth routes working!' }));

// Apply rate limiting and validation to sensitive auth endpoints
authRouter.post('/', authLimiter, registerValidation, userRegister);
authRouter.post('/login', authLimiter, loginValidation, login);
authRouter.post('/become-scholar', authMiddleware, applicantAdmission, uploadTaskCard, becomeScholar);

// Token refresh and logout
authRouter.post('/refresh-token', authLimiter, refreshAccessToken);
authRouter.post('/logout', authMiddleware, logout);

module.exports = authRouter;
