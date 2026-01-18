const { UserModel } = require('../models/User');
const { pool } = require('../config/db');

//get all users
const getAllUsers = async(req, res) => {
    try {
        // Get users with their scholar status by joining with scholar_profile and user_roles
        const [rows] = await pool.query(`
            SELECT 
                u.id, 
                u.fname, 
                u.lname, 
                u.email, 
                u.created_at,
                CASE 
                    WHEN sp.id IS NOT NULL THEN 1
                    WHEN EXISTS (
                        SELECT 1 FROM user_roles ur 
                        JOIN roles r ON ur.role_id = r.id 
                        WHERE ur.user_id = u.id AND r.name = 'Scholar'
                    ) THEN 1 
                    ELSE 0 
                END as is_scholar
            FROM users u
            LEFT JOIN scholar_profile sp ON u.id = sp.user_id
            ORDER BY u.id ASC
        `);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

//get one user 
const getOneUser = async(req, res) => {
    try {
        const id = Number(req.params.id);
        if(!id) {
            return res.status(404).json({message: 'User ID not found'});
        }
        const [row] = await UserModel.findById(id);
        res.status(201).json(row);
    } catch (error) {
        console.error("Error fetching user", error);
        res.status(500).json({message: "Server error fetching user"});
    }
};

//update user
const updateUser = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { fname, lname, email } = req.body;

        const [existing] = await UserModel.findById(id);

        if (existing.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        await UserModel.update(id, fname, lname, email);

        res.json({ message: "User updated successfully" });
    } catch (error) {
        console.error("Error updating user:", error);
        res.status(500).json({ message: "Server error updating user" });
    }
};

const deleteUser = async(req, res) => {
    try {
        const id = Number(req.params.id);

        const [existing] = await UserModel.findById(id);
        if (existing.length === 0) return res.status(404).json({ message: "User not found" });

        await UserModel.delete(id);
        res.json({ message: "User deleted successfully" });
        
    } catch (error) {
        console.error("Error deleting the user:", error.message);
        console.error("Full error:", error);
        res.status(500).json({message: "Server Error deleting the user", error: error.message});
    }
};

// Get user profile with roles
const getUserProfile = async (req, res) => {
    try {
        console.log('getUserProfile called');
        console.log('req.user:', req.user);
        
        if (!req.user || !req.user.id) {
            console.error('No user ID in request');
            return res.status(400).json({ message: "Invalid token: user ID missing" });
        }
        
        const userId = req.user.id;
        console.log('Fetching profile for userId:', userId);
        
        const [userRows] = await UserModel.findById(userId);
        if (userRows.length === 0) {
            console.error('User not found:', userId);
            return res.status(404).json({ message: "User not found" });
        }
        
        const user = userRows[0];
        console.log('User found:', user.email);
        
        // Get user roles
        const [roleRows] = await pool.query(`
            SELECT r.name AS role_name
            FROM user_roles ur
            JOIN roles r ON ur.role_id = r.id
            WHERE ur.user_id = ?
        `, [userId]);
        
        const roles = roleRows.map(row => row.role_name);
        console.log('User roles:', roles);
        
        // Remove sensitive data
        delete user.password;
        
        res.json({
            ...user,
            roles
        });
    } catch (error) {
        console.error("Error fetching user profile:", error);
        console.error("Full error:", error);
        res.status(500).json({ message: "Server error fetching profile", error: error.message });
    }
};

// Update user profile with file upload
const updateUserProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            fname,
            lname,
            email,
            bio,
            favoriteSubject,
            favoriteFood,
            hobbies,
            iban
        } = req.body;
        
        let taxCardUrl = null;
        let profileImageUrl = null;
        
        // Handle multiple files from different fields
        if (req.files) {
            if (req.files.taxCard) {
                taxCardUrl = req.files.taxCard[0].path.replace(/\\/g, '/');
            }
            if (req.files.profileImage) {
                profileImageUrl = req.files.profileImage[0].path.replace(/\\/g, '/');
            }
        } else if (req.file) {
            // Single file upload
            if (req.file.fieldname === 'taxCard') {
                taxCardUrl = req.file.path.replace(/\\/g, '/');
            } else if (req.file.fieldname === 'profileImage') {
                profileImageUrl = req.file.path.replace(/\\/g, '/');
            }
        }
        
        const updateFields = {};
        if (fname) updateFields.fname = fname;
        if (lname) updateFields.lname = lname;
        if (email) updateFields.email = email;
        if (bio !== undefined) updateFields.bio = bio;
        if (favoriteSubject !== undefined) updateFields.favorite_subject = favoriteSubject;
        if (favoriteFood !== undefined) updateFields.favorite_food = favoriteFood;
        if (hobbies !== undefined) updateFields.hobbies = hobbies;
        if (iban !== undefined) updateFields.iban = iban;
        if (taxCardUrl) updateFields.tax_card_url = taxCardUrl;
        if (profileImageUrl) updateFields.profile_image_url = profileImageUrl;
        
        // Build dynamic update query
        const fields = Object.keys(updateFields);
        const values = Object.values(updateFields);
        
        if (fields.length === 0) {
            return res.status(400).json({ message: "No fields to update" });
        }
        
        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const query = `UPDATE users SET ${setClause} WHERE id = ?`;
        
        await pool.query(query, [...values, userId]);
        
        console.log('Profile updated successfully for user:', userId);
        res.json({ message: "Profile updated successfully", updatedFields: fields });
    } catch (error) {
        console.error("Error updating user profile:", error);
        console.error("Full error:", error);
        res.status(500).json({ message: "Server error updating profile", error: error.message });
    }
};

// Delete user account (SuperAdmin only - can delete any user including admins)
const deleteUserBySuperAdmin = async (req, res) => {
    try {
        const id = Number(req.params.id);
        const requestingUserRoles = req.user.roles || [];

        // Only SuperAdmin can use this endpoint
        if (!requestingUserRoles.includes('SuperAdmin')) {
            return res.status(403).json({ message: "Only SuperAdmin can delete accounts" });
        }

        const [existing] = await UserModel.findById(id);
        if (existing.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if target user is a SuperAdmin - prevent deleting other SuperAdmins
        const [targetRoles] = await pool.query(
            `SELECT r.name FROM roles r 
             JOIN user_roles ur ON r.id = ur.role_id 
             WHERE ur.user_id = ?`,
            [id]
        );
        const targetUserRoles = targetRoles.map(r => r.name);
        
        if (targetUserRoles.includes('SuperAdmin') && id !== req.user.id) {
            return res.status(403).json({ message: "Cannot delete another SuperAdmin account" });
        }

        await UserModel.delete(id);
        res.json({ message: "User account deleted successfully by SuperAdmin" });
    } catch (error) {
        console.error("Error deleting user by SuperAdmin:", error);
        res.status(500).json({ message: "Server error deleting user" });
    }
};

// Get all users with roles (for SuperAdmin view)
const getAllUsersWithRoles = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                u.id, 
                u.fname, 
                u.lname, 
                u.email, 
                u.created_at,
                GROUP_CONCAT(DISTINCT r.name) as roles,
                CASE 
                    WHEN sp.id IS NOT NULL THEN 1
                    ELSE 0 
                END as is_scholar
            FROM users u
            LEFT JOIN scholar_profile sp ON u.id = sp.user_id
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            GROUP BY u.id
            ORDER BY u.id ASC
        `);
        
        // Parse roles string to array
        const usersWithRoles = rows.map(user => ({
            ...user,
            roles: user.roles ? user.roles.split(',') : []
        }));
        
        res.status(200).json(usersWithRoles);
    } catch (error) {
        console.error("Error fetching users with roles:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

// Create SuperAdmin (can only be done by existing SuperAdmin or initial setup)
const createSuperAdmin = async (req, res) => {
    try {
        const { email, password, fname, lname, secretKey } = req.body;
        
        // Check if this is initial setup (no SuperAdmin exists) or authorized request
        const [existingSuperAdmins] = await pool.query(`
            SELECT u.id FROM users u
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE r.name = 'SuperAdmin'
        `);
        
        // If SuperAdmin exists, require either SuperAdmin role or secret key
        if (existingSuperAdmins.length > 0) {
            const requestingUserRoles = req.user?.roles || [];
            const isAuthorized = requestingUserRoles.includes('SuperAdmin') || 
                                 secretKey === process.env.SUPER_ADMIN_SECRET_KEY;
            
            if (!isAuthorized) {
                return res.status(403).json({ 
                    message: "Only existing SuperAdmin can create new SuperAdmin accounts" 
                });
            }
        }
        
        // Check if user already exists
        const [existing] = await UserModel.findByEmail(email);
        if (existing.length > 0) {
            return res.status(400).json({ message: "User with this email already exists" });
        }
        
        // Create the user
        const bcrypt = require('bcryptjs');
        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await UserModel.create(fname, lname, email, hashedPassword, 0);
        const userId = result.insertId;
        
        // Assign SuperAdmin role (role_id = 4)
        await pool.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, 4)", [userId]);
        // Also assign Admin role for backwards compatibility
        await pool.query("INSERT IGNORE INTO user_roles (user_id, role_id) VALUES (?, 1)", [userId]);
        
        res.status(201).json({ 
            message: "SuperAdmin created successfully",
            userId: userId
        });
    } catch (error) {
        console.error("Error creating SuperAdmin:", error);
        res.status(500).json({ message: "Server error creating SuperAdmin" });
    }
};

module.exports = { 
    getAllUsers, 
    getOneUser, 
    updateUser, 
    deleteUser, 
    getUserProfile, 
    updateUserProfile,
    deleteUserBySuperAdmin,
    getAllUsersWithRoles,
    createSuperAdmin
};
