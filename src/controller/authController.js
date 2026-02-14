const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { UserModel } = require("../models/User");
const { UserRoleModel } = require("../models/userRole");
const { ScholarProfileModel } = require("../models/scholarProfile");
const { hashPassword, verifyPassword } = require("../utils/passwordHasher");

// Security constants
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

// Password validation helper
const validatePassword = (password) => {
    const errors = [];
    if (!password || password.length < 8) errors.push("at least 8 characters");
    if (!/[A-Z]/.test(password)) errors.push("one uppercase letter");
    if (!/[a-z]/.test(password)) errors.push("one lowercase letter");
    if (!/[0-9]/.test(password)) errors.push("one number");
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) errors.push("one special character");
    return errors;
};

const userRegister = async (req, res) => {
    try {
        const {fname, lname, email, password, isScholar, scholarData} = req.body;

        // Validate password strength
        const passwordErrors = validatePassword(password);
        if (passwordErrors.length > 0) {
            return res.status(400).json({
                message: `Password must contain: ${passwordErrors.join(", ")}`
            });
        }

        const [existing] = await UserModel.findByEmail(email);
        if (existing.length > 0) {
            return res.status(400).json({message: 'User already exists'});
        }

        // Use Argon2id for password hashing (more secure than bcrypt)
        const hashedPassword = await hashPassword(password);

        const [result] = await UserModel.create(fname, lname, email, hashedPassword, isScholar);

        const userId = result.insertId;

        // assign default role -> learner = 2
        await UserRoleModel.assignRole(userId, 2);

        // Add scholar role + profile if needed
        if (isScholar && scholarData) {
            await UserRoleModel.assignRole(userId, 3); 
            const { university, degree, year} = scholarData;
            await ScholarProfileModel.create(userId, university, degree, year);
        }

        // Fetch newly created user
        const [userRow] = await UserModel.findById(userId);
        const [scholarRow] = await ScholarProfileModel.findByUserId(userId);

        const user = userRow[0];
        if (scholarRow.length > 0) {
            user.scholarProfile = scholarRow[0];
        }
        delete user.password;

        // Generate JWT
        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.status(201).json({
            message: "User registered successfully",
            user,
            token
        });

    } catch (error) {
        console.error("Error registering user:", error);
        res.status(500).json({ message: "Server error registering user" });
    }
};

const login = async (req, res) => {
    try {
        const { email, password, twoFactorCode } = req.body;
        
        console.log('Login attempt for:', email);

        //find user
        const [userRows] = await UserModel.findByEmail(email);
        console.log('User found:', userRows.length > 0);
        
        if (userRows.length === 0) {
            return res.status(401).json({message: 'Invalid email or password'});
        }
        const user = userRows[0];

        // Check if account is locked
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            const remainingMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
            return res.status(423).json({
                message: `Account locked. Try again in ${remainingMinutes} minute(s).`,
                locked: true,
                remainingMinutes
            });
        }

        //compare passwords using Argon2/bcrypt auto-detection
        const { valid: isPasswordValid, needsRehash } = await verifyPassword(password, user.password);
        console.log('Password valid:', isPasswordValid);
        
        if(!isPasswordValid) {
            // Increment failed attempts
            const newAttempts = (user.failed_login_attempts || 0) + 1;
            await UserModel.incrementFailedAttempts(user.id);
            
            // Lock account if max attempts exceeded
            if (newAttempts >= MAX_FAILED_ATTEMPTS) {
                await UserModel.lockAccount(user.id, LOCKOUT_DURATION_MINUTES);
                return res.status(423).json({
                    message: `Account locked for ${LOCKOUT_DURATION_MINUTES} minutes due to too many failed attempts.`,
                    locked: true
                });
            }
            
            return res.status(401).json({
                message: 'Invalid email or password',
                remainingAttempts: MAX_FAILED_ATTEMPTS - newAttempts
            });
        }

        // Check if 2FA is enabled
        if (user.two_factor_enabled) {
            if (!twoFactorCode) {
                return res.status(200).json({
                    message: '2FA code required',
                    requires2FA: true,
                    userId: user.id
                });
            }
            
            // Validate 2FA code
            const speakeasy = require('speakeasy');
            const verified = speakeasy.totp.verify({
                secret: user.two_factor_secret,
                encoding: 'base32',
                token: twoFactorCode,
                window: 1
            });
            
            if (!verified) {
                // Check backup codes
                let backupCodes = [];
                try {
                    backupCodes = user.two_factor_backup_codes ? JSON.parse(user.two_factor_backup_codes) : [];
                } catch(e) {
                    backupCodes = [];
                }
                
                const backupIndex = backupCodes.indexOf(twoFactorCode);
                if (backupIndex === -1) {
                    return res.status(401).json({ message: 'Invalid 2FA code' });
                }
                
                // Remove used backup code
                backupCodes.splice(backupIndex, 1);
                await UserModel.update2FA(user.id, user.two_factor_secret, true, JSON.stringify(backupCodes));
            }
        }

        // Reset failed attempts on successful login
        await UserModel.resetFailedAttempts(user.id);
        await UserModel.updateLastLogin(user.id);

        // Upgrade password hash from bcrypt to Argon2 if needed
        if (needsRehash) {
            try {
                const newHash = await hashPassword(password);
                await require('../config/db').pool.query(
                    'UPDATE users SET password = ? WHERE id = ?',
                    [newHash, user.id]
                );
                console.log(`Upgraded password hash to Argon2 for user ${user.id}`);
            } catch (rehashError) {
                // Non-critical error, log and continue
                console.error('Failed to upgrade password hash:', rehashError.message);
            }
        }

        //fetch roles
        const [roleRows] = await UserRoleModel.getRolesById(user.id);
        const roles = roleRows.map(row => row.name);

        // If user has isScholar flag but doesn't have Scholar role, assign it
        if (user.isScholar === 1 && !roles.includes('Scholar')) {
            await UserRoleModel.assignRole(user.id, 3); // 3 = Scholar role
            roles.push('Scholar');
        }

        //fetch scholar profile if user is a scholar
        let scholarProfile = null;
        if (roles.includes('Scholar')) {
            const [scholarRows] = await ScholarProfileModel.findByUserId(user.id);
            if(scholarRows.length > 0) scholarProfile = scholarRows[0];
        }

        // generate the JWT token (short-lived access token)
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, roles },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }  // Changed from 7d to 1h for security
        );

        // Generate refresh token
        const refreshToken = crypto.randomBytes(64).toString('hex');
        const refreshTokenExpires = new Date();
        refreshTokenExpires.setDate(refreshTokenExpires.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
        await UserModel.updateRefreshToken(user.id, refreshToken, refreshTokenExpires);

        //remove password from the user object
        delete user.password;
        delete user.two_factor_secret;
        delete user.two_factor_backup_codes;
        delete user.refresh_token;

        res.status(200).json({
            message: "Login successful",
            user,
            roles,
            scholarProfile,
            token,
            refreshToken,
            expiresIn: 3600 // 1 hour in seconds
        });

    } catch (error) {
        console.error('Error login in user :', error);
        res.status(500).json({message: 'Server error logging in user'});
    }
};

// Apply to become a scholar (for existing users)
const becomeScholar = async (req, res) => {
    try {
        const userId = req.user.id; // From auth middleware
        const { university, degree, year } = req.body;

        if (!university || !degree || !year) {
            return res.status(400).json({ message: "All fields are required" });
        }

        // Check if user already has a scholar profile
        const [existing] = await ScholarProfileModel.findByUserId(userId);
        if (existing.length > 0) {
            return res.status(400).json({ message: "You have already applied to become a scholar" });
        }

        // Handle task card file upload
        let taskCardUrl = null;
        if (req.file) {
            taskCardUrl = `uploads/task-cards/${req.file.filename}`;
        }

        // Create scholar profile (unapproved by default)
        await ScholarProfileModel.create(userId, university, degree, parseInt(year), taskCardUrl);

        // Update user's isScholar flag
        const { pool } = require('../config/db');
        await pool.query('UPDATE users SET isScholar = 1 WHERE id = ?', [userId]);

        // Assign Scholar role (even though not approved yet)
        await UserRoleModel.assignRole(userId, 3); // 3 = Scholar role

        res.status(201).json({
            message: "Scholar application submitted successfully. Awaiting admin approval."
        });

    } catch (error) {
        console.error('Error submitting scholar application:', error);
        console.error('Error details:', error.message, error.stack);
        res.status(500).json({ 
            message: 'Server error submitting application',
            error: error.message 
        });
    }
};

// Refresh access token using refresh token
const refreshAccessToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        
        if (!refreshToken) {
            return res.status(400).json({ message: 'Refresh token required' });
        }
        
        // Find user with this refresh token
        const [users] = await require('../config/db').pool.query(
            "SELECT * FROM users WHERE refresh_token = ? AND refresh_token_expires > NOW()",
            [refreshToken]
        );
        
        if (users.length === 0) {
            return res.status(401).json({ message: 'Invalid or expired refresh token' });
        }
        
        const user = users[0];
        
        // Fetch roles
        const [roleRows] = await UserRoleModel.getRolesById(user.id);
        const roles = roleRows.map(row => row.name);
        
        // Generate new access token
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, roles },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );
        
        // Optionally rotate refresh token for better security
        const newRefreshToken = crypto.randomBytes(64).toString('hex');
        const refreshTokenExpires = new Date();
        refreshTokenExpires.setDate(refreshTokenExpires.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
        await UserModel.updateRefreshToken(user.id, newRefreshToken, refreshTokenExpires);
        
        // Update last activity
        await UserModel.updateLastActivity(user.id);
        
        res.status(200).json({
            token,
            refreshToken: newRefreshToken,
            expiresIn: 3600
        });
        
    } catch (error) {
        console.error('Error refreshing token:', error);
        res.status(500).json({ message: 'Server error refreshing token' });
    }
};

// Logout - invalidate refresh token
const logout = async (req, res) => {
    try {
        const userId = req.user?.id;
        
        if (userId) {
            await UserModel.clearRefreshToken(userId);
        }
        
        res.status(200).json({ message: 'Logged out successfully' });
        
    } catch (error) {
        console.error('Error logging out:', error);
        res.status(500).json({ message: 'Server error logging out' });
    }
};

module.exports = { userRegister, login, becomeScholar, refreshAccessToken, logout };
