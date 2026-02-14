const { body, param, validationResult } = require('express-validator');

// ===== Helper: Check validation results =====
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            error: 'Validation failed',
            details: errors.array().map(e => ({ field: e.path, message: e.msg }))
        });
    }
    next();
};

// ===== Auth Validators =====
const registerValidation = [
    body('email')
        .isEmail().withMessage('Valid email is required')
        .normalizeEmail()
        .isLength({ max: 255 }).withMessage('Email too long'),
    body('password')
        .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
        .matches(/[A-Z]/).withMessage('Password must contain uppercase letter')
        .matches(/[a-z]/).withMessage('Password must contain lowercase letter')
        .matches(/[0-9]/).withMessage('Password must contain a number')
        .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain special character'),
    body('fname')
        .trim()
        .notEmpty().withMessage('First name is required')
        .isLength({ max: 100 }).withMessage('First name too long')
        .escape(), // Sanitize HTML
    body('lname')
        .trim()
        .notEmpty().withMessage('Last name is required')
        .isLength({ max: 100 }).withMessage('Last name too long')
        .escape(),
    validate
];

const loginValidation = [
    body('email')
        .isEmail().withMessage('Valid email is required')
        .normalizeEmail(),
    body('password')
        .notEmpty().withMessage('Password is required'),
    validate
];

// ===== Subject/Course Validators =====
const subjectIdValidation = [
    param('id')
        .isInt({ min: 1 }).withMessage('Valid subject ID is required'),
    validate
];

const bundlePriceValidation = [
    param('id')
        .isInt({ min: 1 }).withMessage('Valid subject ID is required'),
    body('bundlePrice')
        .isFloat({ min: 0 }).withMessage('Price must be a positive number'),
    validate
];

// ===== Video Validators =====
const videoValidation = [
    body('title')
        .trim()
        .notEmpty().withMessage('Title is required')
        .isLength({ max: 200 }).withMessage('Title too long')
        .escape(),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 2000 }).withMessage('Description too long')
        .escape(),
    validate
];

// ===== User Profile Validators =====
const profileValidation = [
    body('fname')
        .optional()
        .trim()
        .isLength({ max: 100 }).withMessage('First name too long')
        .escape(),
    body('lname')
        .optional()
        .trim()
        .isLength({ max: 100 }).withMessage('Last name too long')
        .escape(),
    body('bio')
        .optional()
        .trim()
        .isLength({ max: 1000 }).withMessage('Bio too long')
        .escape(),
    validate
];

// ===== Admin Validators =====
const userIdValidation = [
    param('userId')
        .isInt({ min: 1 }).withMessage('Valid user ID is required'),
    validate
];

const roleValidation = [
    param('userId')
        .isInt({ min: 1 }).withMessage('Valid user ID is required'),
    body('role')
        .isIn(['Learner', 'Scholar', 'Admin', 'SuperAdmin']).withMessage('Invalid role'),
    validate
];

// ===== Security Update Validators =====
const securityUpdateValidation = [
    body('title')
        .trim()
        .notEmpty().withMessage('Title is required')
        .isLength({ max: 200 }).withMessage('Title too long')
        .escape(),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 2000 }).withMessage('Description too long')
        .escape(),
    body('severity')
        .optional()
        .isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid severity'),
    validate
];

module.exports = {
    validate,
    registerValidation,
    loginValidation,
    subjectIdValidation,
    bundlePriceValidation,
    videoValidation,
    profileValidation,
    userIdValidation,
    roleValidation,
    securityUpdateValidation
};
