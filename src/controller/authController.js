const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { UserModel } = require("../models/User");
const { UserRoleModel } = require("../models/userRole");
const { ScholarProfileModel } = require("../models/scholarProfile");

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

        const hashedPassword = await bcrypt.hash(password, 10);

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
        const { email, password} = req.body;
        
        console.log('Login attempt for:', email);

        //find user
        const [userRows] = await UserModel.findByEmail(email);
        console.log('User found:', userRows.length > 0);
        
        if (userRows.length === 0) {
            return res.status(401).json({message: 'Invalid email or password'});
        }
        const user = userRows[0];

        //compare passwords
        const isPasswordValid = await bcrypt.compare(password, user.password);
        console.log('Password valid:', isPasswordValid);
        
        if(!isPasswordValid) {
            return res.status(401).json({message: 'Invalid email or password'});
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

        // generate the JWT token
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, roles },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        //remove password from the user object
        delete user.password;

        res.status(200).json({
            message: "Login successful",
            user,
            roles,
            scholarProfile,
            token
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

module.exports = { userRegister, login, becomeScholar };
