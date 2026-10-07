const { UserModel } = require("../models/User");
const { UserRoleModel } = require("../models/userRole");
const { ScholarProfileModel } = require("../models/scholarProfile");
const { hashPassword, verifyPassword } = require("../utils/passwordHasher");
const { userResponse, scholarProfileResponse } = require('../utils/userResponses');
const { logError } = require('../utils/safeLogging');

const { passwordErrors: validatePassword, normalizeEmail, passwordInput } = require('../utils/authSecurity');

const userRegister = async (req, res) => {
    try {
        const {fname, lname, password, isScholar, scholarData} = req.body;
        const email = await normalizeEmail(req.body.email);
        if (!email) return res.status(400).json({message:'Valid email is required'});

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

        const lifecycle = require('../services/authLifecycle');
        const issued = await lifecycle.transaction(async db => {
            const [[current]] = await db.query('SELECT * FROM users WHERE id=? FOR UPDATE',[userId]);
            const roles = await lifecycle.rolesFor(db,userId);
            return lifecycle.session(db,current,roles);
        });

        res.status(201).json({
            message: "User registered successfully",
            user: userResponse(user, scholarRow.length > 0 ? { scholarProfile: scholarRow[0] } : {}),
            ...issued
        });

    } catch (error) {
        logError("Error registering user:", error);
        res.status(500).json({ message: "Server error registering user" });
    }
};

const login = async (req, res) => {
    try {
        const email=await normalizeEmail(req.body.email),password=req.body.password;
        if(!email||!passwordInput(password))return res.status(401).json({message:'Invalid email or password'});
        const result=await require('../services/authLifecycle').passwordLogin(email,password);
        return res.status(result.status).json(result.body);
    } catch(error) {
        logError('Login failed',error);
        return res.status(503).json({message:'Unable to sign in. Please try again.'});
    }
};

// Apply to become a scholar (for existing users)
const becomeScholar = async (req, res) => {
    if (req.uploadState) req.uploadState.processing = true;
    try {
        const userId = req.user.id; // From auth middleware
        const { degree, year, universityId, countryId } = req.body;
        if (!Number.isInteger(Number(year)) || Number(year) < 2024 || Number(year) > 2035) return res.status(400).json({message:'Choose a graduation year between 2024 and 2035.'});
        const db = require('../config/db').pool;
        const { resolveUniversity, universityLabel } = require('../utils/academicContext');
        let selected;
        if (universityId) {
            const [[row]] = await db.query('SELECT * FROM universities WHERE id = ? AND country_id = ?', [universityId, countryId]);
            selected = row;
        } else {
            selected = await resolveUniversity(db, req.body.university || '');
        }
        if (!selected) return res.status(400).json({ message: 'Choose a valid university and country' });
        const [[programme]] = await db.query('SELECT id FROM subjects WHERE university_id = ? AND degree_programmes = ? LIMIT 1', [selected.id, degree || '']);
        if (!programme) return res.status(400).json({ message: 'Choose a programme at your selected university' });
        const university = universityLabel(selected);

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
            taskCardUrl = require('../middleware/uploadSecurity').storedReference('taskCard', req.file.filename);
        }

        // Make document reference, application and role persistence atomic.
        const connection = await db.getConnection();
        let committing = false;
        try {
            await connection.beginTransaction();
            const [[user]] = await connection.query('SELECT id FROM users WHERE id=? FOR UPDATE', [userId]);
            if (!user) throw new Error('Applicant no longer exists');
            const [duplicates] = await connection.query('SELECT id FROM scholar_profile WHERE user_id=?', [userId]);
            if (duplicates.length) { await connection.rollback(); return res.status(400).json({message:'You have already applied to become a scholar'}); }
            await connection.query('INSERT INTO scholar_profile (user_id, university, degree, year, task_card_url) VALUES (?, ?, ?, ?, ?)', [userId, university, degree, parseInt(year), taskCardUrl]);
            await connection.query('UPDATE users SET isScholar = 1 WHERE id = ?', [userId]);
            await connection.query('INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, 3]);
            committing = true;
            await connection.commit();
            if (req.file) req.uploadState?.retained.add(req.file.path);
        } catch (error) {
            if (committing && req.file) req.uploadState?.retained.add(req.file.path);
            await connection.rollback(); throw error;
        }
        finally { connection.release(); }

        res.status(201).json({
            message: "Scholar application submitted successfully. Awaiting admin approval."
        });

    } catch (error) {
        logError('Error submitting scholar application:', error);
        res.status(500).json({ 
            message: 'Server error submitting application'
        });
    } finally {
        if (req.uploadState) await req.uploadState.finish();
    }
};

// Rotation and revocation use the existing live account credential.
const refreshAccessToken = async (req,res) => {
    try {
        const result=await require('../services/authLifecycle').refresh(req.body.refreshToken);
        return res.status(result.status).json(result.body);
    } catch(error) { logError('Refresh failed',error);return res.status(503).json({message:'Unable to refresh session'}); }
};
const logout = async (req,res) => {
    try {
        const lifecycle=require('../services/authLifecycle');
        const result=await lifecycle.lockedSession(req.user,async(db,user)=>{
            await lifecycle.revoke(db,user);
            return{status:200,body:{message:'Logged out successfully'}};
        });
        return res.status(result.status).json(result.body);
    } catch(error) { logError('Logout failed',error);return res.status(503).json({message:'Unable to revoke session. Please try again.'}); }
};

module.exports = { userRegister, login, becomeScholar, refreshAccessToken, logout };
