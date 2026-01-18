const { Router } = require('express');
const {
    createConnectAccount,
    getAccountStatus,
    createDashboardLink,
    createPayout,
    getAllScholarsStripeStatus,
    getScholarEarnings,
    getPlatformBalance,
    sendVerificationEmail,
    getAccountRequirements
} = require('../controller/stripeConnectController');
const { authMiddleware } = require('../middleware/auth');
const { authorizeRoles } = require('../middleware/roles');

const stripeConnectRoutes = Router();

// Scholar routes - manage their own Stripe account
stripeConnectRoutes.post(
    '/create-account',
    authMiddleware,
    authorizeRoles('Scholar'),
    createConnectAccount
);

stripeConnectRoutes.get(
    '/account-status',
    authMiddleware,
    authorizeRoles('Scholar'),
    getAccountStatus
);

stripeConnectRoutes.post(
    '/dashboard-link',
    authMiddleware,
    authorizeRoles('Scholar'),
    createDashboardLink
);

// Scholar earnings route
stripeConnectRoutes.get(
    '/earnings',
    authMiddleware,
    authorizeRoles('Scholar'),
    getScholarEarnings
);

// Admin routes - manage payouts
stripeConnectRoutes.post(
    '/payout',
    authMiddleware,
    authorizeRoles('Admin'),
    createPayout
);

stripeConnectRoutes.get(
    '/scholars-status',
    authMiddleware,
    authorizeRoles('Admin'),
    getAllScholarsStripeStatus
);

stripeConnectRoutes.get(
    '/platform-balance',
    authMiddleware,
    authorizeRoles('Admin'),
    getPlatformBalance
);

// Scholar route to get their account requirements
stripeConnectRoutes.get(
    '/requirements',
    authMiddleware,
    authorizeRoles('Scholar'),
    getAccountRequirements
);

// Scholar route to send verification email
stripeConnectRoutes.post(
    '/send-verification-email',
    authMiddleware,
    authorizeRoles('Scholar'),
    sendVerificationEmail
);

module.exports = stripeConnectRoutes;
