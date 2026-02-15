/**
 * Session Timeout Middleware
 * Automatically invalidates sessions after period of inactivity
 */
const { pool } = require('../config/db');
const { UserModel } = require('../models/User');

// Session timeout in minutes
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.SESSION_TIMEOUT_MINUTES) || 30;

/**
 * Middleware to check and update session activity
 * Should be applied after authMiddleware
 */
const sessionTimeoutMiddleware = async (req, res, next) => {
    try {
        // Only check for authenticated users
        if (!req.user || !req.user.id) {
            return next();
        }

        // Check if last_activity column exists (skip if migration not run)
        try {
            // Get user's last activity
            const [users] = await pool.query(
                'SELECT last_activity FROM users WHERE id = ?',
                [req.user.id]
            );

            if (users.length === 0) {
                return next();
            }

            const lastActivity = users[0].last_activity;

            // Check if session has expired
            if (lastActivity) {
                const lastActivityTime = new Date(lastActivity);
                const now = new Date();
                const minutesSinceLastActivity = (now - lastActivityTime) / (1000 * 60);

                if (minutesSinceLastActivity > SESSION_TIMEOUT_MINUTES) {
                    // Session expired - clear refresh token
                    try {
                        await UserModel.clearRefreshToken(req.user.id);
                    } catch (e) {
                        // Ignore if column doesn't exist
                    }
                    
                    return res.status(401).json({
                        message: 'Session expired due to inactivity. Please log in again.',
                        sessionExpired: true,
                        code: 'SESSION_TIMEOUT'
                    });
                }
            }

            // Update last activity timestamp
            try {
                await UserModel.updateLastActivity(req.user.id);
            } catch (e) {
                // Ignore if column doesn't exist
            }
        } catch (columnError) {
            // Column doesn't exist yet - skip session timeout check
            console.log('Session timeout check skipped - last_activity column may not exist');
        }

        next();
    } catch (error) {
        console.error('Session timeout middleware error:', error);
        // Don't block the request on session check errors
        next();
    }
};

/**
 * Optional: Lightweight activity tracker
 * Updates activity only for important endpoints (not every API call)
 */
const trackActivity = async (req, res, next) => {
    if (req.user && req.user.id) {
        // Fire and forget - don't wait for update
        UserModel.updateLastActivity(req.user.id).catch(err => {
            console.error('Failed to update activity:', err.message);
        });
    }
    next();
};

module.exports = {
    sessionTimeoutMiddleware,
    trackActivity,
    SESSION_TIMEOUT_MINUTES
};
