const { pool } = require('../config/db');
const bcrypt = require('bcryptjs');

/**
 * Get admin profile
 */
const getAdminProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const [rows] = await pool.query(`
            SELECT 
                u.id, u.username, u.email, u.firstname, u.lastname,
                ap.display_name, ap.phone, ap.avatar_url, ap.department, ap.bio,
                ap.created_at as profile_created_at, ap.updated_at as profile_updated_at
            FROM users u
            LEFT JOIN admin_profiles ap ON u.id = ap.user_id
            WHERE u.id = ?
        `, [userId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }
        
        res.json(rows[0]);
    } catch (error) {
        console.error("Error fetching admin profile:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Update admin profile
 */
const updateAdminProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { display_name, phone, department, bio, firstname, lastname } = req.body;
        
        // Update user's firstname/lastname
        await pool.query(
            'UPDATE users SET firstname = ?, lastname = ? WHERE id = ?',
            [firstname, lastname, userId]
        );
        
        // Upsert admin profile
        await pool.query(`
            INSERT INTO admin_profiles (user_id, display_name, phone, department, bio)
            VALUES (?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                display_name = VALUES(display_name),
                phone = VALUES(phone),
                department = VALUES(department),
                bio = VALUES(bio)
        `, [userId, display_name, phone, department, bio]);
        
        // Log activity
        await logActivity(userId, 'PROFILE_UPDATE', 'admin_profile', userId, 'Updated admin profile');
        
        res.json({ message: "Profile updated successfully" });
    } catch (error) {
        console.error("Error updating admin profile:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get all users (SuperAdmin only)
 */
const getAllUsers = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                u.id, u.username, u.email, u.firstname, u.lastname, u.created_at,
                GROUP_CONCAT(r.name) as roles
            FROM users u
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
        `);
        
        res.json(rows);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Create new admin (SuperAdmin only)
 */
const createAdmin = async (req, res) => {
    try {
        const { username, email, password, firstname, lastname, role } = req.body;
        
        if (!username || !email || !password || !role) {
            return res.status(400).json({ message: "Username, email, password, and role are required" });
        }
        
        // Check if role is valid
        if (!['Admin', 'SuperAdmin'].includes(role)) {
            return res.status(400).json({ message: "Invalid role. Must be Admin or SuperAdmin" });
        }
        
        // Check if user exists
        const [existing] = await pool.query(
            'SELECT id FROM users WHERE email = ? OR username = ?',
            [email, username]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ message: "User with this email or username already exists" });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const [result] = await pool.query(
            'INSERT INTO users (username, email, password, firstname, lastname) VALUES (?, ?, ?, ?, ?)',
            [username, email, hashedPassword, firstname || '', lastname || '']
        );
        
        const newUserId = result.insertId;
        
        // Get role ID
        const [roleRow] = await pool.query('SELECT id FROM roles WHERE name = ?', [role]);
        if (roleRow.length > 0) {
            await pool.query(
                'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
                [newUserId, roleRow[0].id]
            );
        }
        
        // Log activity
        await logActivity(req.user.id, 'CREATE_ADMIN', 'user', newUserId, `Created ${role}: ${email}`);
        
        res.status(201).json({ 
            message: `${role} created successfully`,
            userId: newUserId
        });
    } catch (error) {
        console.error("Error creating admin:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Update user role (SuperAdmin only)
 */
const updateUserRole = async (req, res) => {
    try {
        const { userId } = req.params;
        const { role } = req.body;
        
        if (!['Learner', 'Scholar', 'Admin', 'SuperAdmin'].includes(role)) {
            return res.status(400).json({ message: "Invalid role" });
        }
        
        // Don't allow changing own role
        if (parseInt(userId) === req.user.id) {
            return res.status(400).json({ message: "Cannot change your own role" });
        }
        
        // Remove existing roles
        await pool.query('DELETE FROM user_roles WHERE user_id = ?', [userId]);
        
        // Add new role
        const [roleRow] = await pool.query('SELECT id FROM roles WHERE name = ?', [role]);
        if (roleRow.length > 0) {
            await pool.query(
                'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
                [userId, roleRow[0].id]
            );
        }
        
        // Log activity
        await logActivity(req.user.id, 'UPDATE_ROLE', 'user', userId, `Changed role to ${role}`);
        
        res.json({ message: "User role updated successfully" });
    } catch (error) {
        console.error("Error updating user role:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Delete user (SuperAdmin only)
 */
const deleteUser = async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Don't allow deleting self
        if (parseInt(userId) === req.user.id) {
            return res.status(400).json({ message: "Cannot delete your own account" });
        }
        
        // Get user info for logging
        const [user] = await pool.query('SELECT email FROM users WHERE id = ?', [userId]);
        
        await pool.query('DELETE FROM users WHERE id = ?', [userId]);
        
        // Log activity
        await logActivity(req.user.id, 'DELETE_USER', 'user', userId, `Deleted user: ${user[0]?.email}`);
        
        res.json({ message: "User deleted successfully" });
    } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get security updates
 */
const getSecurityUpdates = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT 
                su.*,
                creator.username as created_by_name,
                resolver.username as resolved_by_name
            FROM security_updates su
            LEFT JOIN users creator ON su.created_by = creator.id
            LEFT JOIN users resolver ON su.resolved_by = resolver.id
            ORDER BY 
                CASE su.severity 
                    WHEN 'critical' THEN 1 
                    WHEN 'high' THEN 2 
                    WHEN 'medium' THEN 3 
                    WHEN 'low' THEN 4 
                END,
                su.created_at DESC
        `);
        
        res.json(rows);
    } catch (error) {
        console.error("Error fetching security updates:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Create security update
 */
const createSecurityUpdate = async (req, res) => {
    try {
        const { title, description, severity } = req.body;
        
        if (!title) {
            return res.status(400).json({ message: "Title is required" });
        }
        
        const [result] = await pool.query(
            'INSERT INTO security_updates (title, description, severity, created_by) VALUES (?, ?, ?, ?)',
            [title, description, severity || 'medium', req.user.id]
        );
        
        // Log activity
        await logActivity(req.user.id, 'CREATE_SECURITY_UPDATE', 'security_update', result.insertId, title);
        
        res.status(201).json({ 
            message: "Security update created",
            id: result.insertId
        });
    } catch (error) {
        console.error("Error creating security update:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Update security update status
 */
const updateSecurityStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (!['pending', 'in-progress', 'resolved'].includes(status)) {
            return res.status(400).json({ message: "Invalid status" });
        }
        
        const updates = { status };
        if (status === 'resolved') {
            updates.resolved_by = req.user.id;
            updates.resolved_at = new Date();
        }
        
        await pool.query(
            'UPDATE security_updates SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?',
            [status, updates.resolved_by || null, updates.resolved_at || null, id]
        );
        
        // Log activity
        await logActivity(req.user.id, 'UPDATE_SECURITY_STATUS', 'security_update', id, `Status: ${status}`);
        
        res.json({ message: "Security update status changed" });
    } catch (error) {
        console.error("Error updating security status:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get activity log
 */
const getActivityLog = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        
        const [rows] = await pool.query(`
            SELECT 
                al.*,
                u.username, u.email
            FROM admin_activity_log al
            JOIN users u ON al.user_id = u.id
            ORDER BY al.created_at DESC
            LIMIT ?
        `, [limit]);
        
        res.json(rows);
    } catch (error) {
        console.error("Error fetching activity log:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Helper: Log admin activity
 */
const logActivity = async (userId, action, targetType, targetId, details, ipAddress = null) => {
    try {
        await pool.query(
            'INSERT INTO admin_activity_log (user_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, action, targetType, targetId, details, ipAddress]
        );
    } catch (error) {
        console.error("Error logging activity:", error);
    }
};

/**
 * Get dashboard stats for SuperAdmin
 */
const getSuperAdminStats = async (req, res) => {
    try {
        // Total users by role
        const [userStats] = await pool.query(`
            SELECT r.name as role, COUNT(ur.user_id) as count
            FROM roles r
            LEFT JOIN user_roles ur ON r.id = ur.role_id
            GROUP BY r.id, r.name
        `);
        
        // Total videos
        const [videoStats] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved FROM videos');
        
        // Total revenue (from purchases)
        const [revenueStats] = await pool.query('SELECT COALESCE(SUM(price), 0) as total_revenue FROM purchases WHERE status = "completed"');
        
        // Pending security updates
        const [securityStats] = await pool.query('SELECT COUNT(*) as pending FROM security_updates WHERE status != "resolved"');
        
        // Recent activity count
        const [activityStats] = await pool.query('SELECT COUNT(*) as recent FROM admin_activity_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)');
        
        res.json({
            users: userStats,
            videos: videoStats[0],
            revenue: revenueStats[0],
            security: securityStats[0],
            activity: activityStats[0]
        });
    } catch (error) {
        console.error("Error fetching superadmin stats:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getAdminProfile,
    updateAdminProfile,
    getAllUsers,
    createAdmin,
    updateUserRole,
    deleteUser,
    getSecurityUpdates,
    createSecurityUpdate,
    updateSecurityStatus,
    getActivityLog,
    getSuperAdminStats
};
