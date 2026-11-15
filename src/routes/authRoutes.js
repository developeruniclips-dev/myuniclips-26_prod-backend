const { Router } = require("express");
const { createAuthRateLimits } = require('../middleware/authRateLimits');
const limits = createAuthRateLimits();
const { sharedAuthAdmission: admission } = require('../middleware/authAdmission');
const { login, userRegister, becomeScholar, refreshAccessToken, logout } = require("../controller/authController");
const { authMiddleware } = require("../middleware/auth");
const { registerValidation, loginValidation } = require("../middleware/validators");
const { createUpload } = require('../middleware/uploadSecurity');
const { applicantAdmission } = require('../middleware/uploadAdmission');

const uploadTaskCard = createUpload('taskCard');
const {shared:uploadBarrier}=require('../utils/uploadBarrier');

const authRouter = Router();

// Test route
authRouter.get('/test', (req, res) => res.json({ message: 'Auth routes working!' }));

// Apply rate limiting and validation to sensitive auth endpoints
authRouter.post('/', limits.registerNetwork, registerValidation, limits.registerAccount, admission.wrap(userRegister));
authRouter.post('/login', limits.loginNetwork, loginValidation, limits.loginFailures, admission.wrap(login));
authRouter.post('/become-scholar', uploadBarrier.ingress('taskCard',{multipartOnly:true}), ...[authMiddleware,applicantAdmission,uploadTaskCard,becomeScholar].map(uploadBarrier.wrap));

// Token refresh and logout
authRouter.post('/refresh-token', limits.refreshNetwork, admission.wrap(refreshAccessToken));
authRouter.post('/logout', authMiddleware, logout);

module.exports = authRouter;
