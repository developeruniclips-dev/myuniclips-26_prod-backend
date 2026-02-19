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
                u.id, 
                CONCAT(u.fname, ' ', u.lname) as username,
                u.email, 
                u.fname as firstname, 
                u.lname as lastname,
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
        
        // Update user's fname/lname
        await pool.query(
            'UPDATE users SET fname = ?, lname = ? WHERE id = ?',
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
                u.id, 
                u.fname, 
                u.lname,
                CONCAT(u.fname, ' ', u.lname) as username,
                u.email, 
                u.fname as firstname, 
                u.lname as lastname, 
                u.created_at,
                GROUP_CONCAT(r.name) as roles,
                (SELECT COUNT(*) FROM scholar_profile sp WHERE sp.user_id = u.id AND sp.approved = 1) as is_scholar
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
        
        if (!email || !password || !role) {
            return res.status(400).json({ message: "Email, password, and role are required" });
        }
        
        // Check if role is valid
        if (!['Admin', 'SuperAdmin'].includes(role)) {
            return res.status(400).json({ message: "Invalid role. Must be Admin or SuperAdmin" });
        }
        
        // Check if user exists
        const [existing] = await pool.query(
            'SELECT id FROM users WHERE email = ?',
            [email]
        );
        
        if (existing.length > 0) {
            return res.status(409).json({ message: "User with this email already exists" });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user with fname and lname (username is derived from firstname or email)
        const fname = firstname || username || email.split('@')[0];
        const lname = lastname || '';
        const [result] = await pool.query(
            'INSERT INTO users (fname, lname, email, password) VALUES (?, ?, ?, ?)',
            [fname, lname, email, hashedPassword]
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
 * Cleans up all related tables to prevent orphaned data
 */
const deleteUser = async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Don't allow deleting self
        if (parseInt(userId) === req.user.id) {
            return res.status(400).json({ message: "Cannot delete your own account" });
        }
        
        // Get user info for logging and protection check
        const [userRows] = await pool.query('SELECT email, fname, lname FROM users WHERE id = ?', [userId]);
        
        // Protect the original SuperAdmin (abdulsatar)
        if (userRows[0]?.email && userRows[0].email.toLowerCase().includes('abdulsatar')) {
            return res.status(403).json({ message: "Cannot delete the original SuperAdmin account" });
        }
        
        // Clean up all related tables (order matters for FK constraints)
        // Tables with ON DELETE CASCADE (user_library, video_progress, scholar_payouts) are auto-handled
        const cleanupTables = [
            'DELETE FROM admin_activity_log WHERE user_id = ?',
            'DELETE FROM admin_profiles WHERE user_id = ?',
            'DELETE FROM subject_purchases WHERE buyer_user_id = ?',
            'DELETE FROM videos WHERE scholar_user_id = ?',
            'DELETE FROM scholar_subjects WHERE scholar_user_id = ?',
            'DELETE FROM scholar_profile WHERE user_id = ?',
            'DELETE FROM user_roles WHERE user_id = ?',
        ];
        
        for (const query of cleanupTables) {
            try {
                await pool.query(query, [userId]);
            } catch (err) {
                // Table might not exist, skip silently
                console.warn(`Cleanup warning for user ${userId}:`, err.message);
            }
        }
        
        // Delete the user itself
        await pool.query('DELETE FROM users WHERE id = ?', [userId]);
        
        // Log activity
        await logActivity(req.user.id, 'DELETE_USER', 'user', userId, `Deleted user: ${userRows[0]?.email || 'unknown'}`);
        
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
                CONCAT(creator.fname, ' ', creator.lname) as created_by_name,
                CONCAT(resolver.fname, ' ', resolver.lname) as resolved_by_name
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
                CONCAT(u.fname, ' ', u.lname) as username, 
                u.email
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
        // Total users
        const [totalUsers] = await pool.query('SELECT COUNT(*) as total FROM users');
        
        // Users by role
        const [userStats] = await pool.query(`
            SELECT r.name as role, COUNT(ur.user_id) as count
            FROM roles r
            LEFT JOIN user_roles ur ON r.id = ur.role_id
            GROUP BY r.id, r.name
        `);
        
        // Total videos
        const [videoStats] = await pool.query('SELECT COUNT(*) as total, SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) as approved FROM videos');
        
        // Total revenue (from subject_purchases - the actual purchase table)
        const [revenueStats] = await pool.query('SELECT COALESCE(SUM(amount), 0) as total_revenue FROM subject_purchases');
        
        // Pending security updates
        let securityCount = 0;
        try {
            const [securityStats] = await pool.query('SELECT COUNT(*) as pending FROM security_updates WHERE status != "resolved"');
            securityCount = securityStats[0]?.pending || 0;
        } catch (err) {
            // Table might not exist yet
            console.warn('security_updates table may not exist:', err.message);
        }
        
        // Pending scholar applications
        const [pendingScholars] = await pool.query('SELECT COUNT(*) as pending FROM scholar_profile WHERE application_status = "pending"');
        
        // Recent activity count
        let activityCount = 0;
        try {
            const [activityStats] = await pool.query('SELECT COUNT(*) as recent FROM admin_activity_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)');
            activityCount = activityStats[0]?.recent || 0;
        } catch (err) {
            console.warn('admin_activity_log table may not exist:', err.message);
        }
        
        res.json({
            totalUsers: totalUsers[0]?.total || 0,
            users: userStats,
            videos: videoStats[0],
            revenue: revenueStats[0],
            security: { pending: securityCount },
            pendingScholars: pendingScholars[0]?.pending || 0,
            activity: { recent: activityCount }
        });
    } catch (error) {
        console.error("Error fetching superadmin stats:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Get orphaned/previous users — entries in user_roles, scholar_profile, etc.
 * where the user no longer exists in the users table.
 */
const getOrphanedUsers = async (req, res) => {
    try {
        // Find orphaned user_ids from user_roles
        let orphanedRoles = [];
        try {
            const [rows] = await pool.query(`
                SELECT 
                    ur.user_id,
                    GROUP_CONCAT(r.name) as roles
                FROM user_roles ur
                LEFT JOIN roles r ON ur.role_id = r.id
                WHERE ur.user_id NOT IN (SELECT id FROM users)
                GROUP BY ur.user_id
            `);
            orphanedRoles = rows;
        } catch (e) { console.warn('orphanedRoles query skipped:', e.message); }

        // Find orphaned user_ids from scholar_profile
        let orphanedScholars = [];
        try {
            const [rows] = await pool.query(`
                SELECT 
                    sp.user_id,
                    sp.university,
                    sp.approved,
                    sp.created_at
                FROM scholar_profile sp
                WHERE sp.user_id NOT IN (SELECT id FROM users)
            `);
            orphanedScholars = rows;
        } catch (e) { console.warn('orphanedScholars query skipped:', e.message); }

        // Find orphaned user_ids from scholar_subjects
        let orphanedSubjects = [];
        try {
            const [rows] = await pool.query(`
                SELECT 
                    ss.scholar_user_id as user_id,
                    ss.subject_id,
                    s.name as subject_name,
                    ss.approved
                FROM scholar_subjects ss
                LEFT JOIN subjects s ON ss.subject_id = s.id
                WHERE ss.scholar_user_id NOT IN (SELECT id FROM users)
            `);
            orphanedSubjects = rows;
        } catch (e) { console.warn('orphanedSubjects query skipped:', e.message); }

        // Find orphaned videos
        let orphanedVideos = [];
        try {
            const [rows] = await pool.query(`
                SELECT 
                    v.scholar_user_id as user_id,
                    COUNT(*) as video_count
                FROM videos v
                WHERE v.scholar_user_id NOT IN (SELECT id FROM users)
                GROUP BY v.scholar_user_id
            `);
            orphanedVideos = rows;
        } catch (e) { console.warn('orphanedVideos query skipped:', e.message); }

        // Merge all orphaned data by user_id
        const orphanedMap = {};
        
        orphanedRoles.forEach(r => {
            if (!orphanedMap[r.user_id]) orphanedMap[r.user_id] = { user_id: r.user_id };
            orphanedMap[r.user_id].roles = r.roles;
        });

        orphanedScholars.forEach(sp => {
            if (!orphanedMap[sp.user_id]) orphanedMap[sp.user_id] = { user_id: sp.user_id };
            orphanedMap[sp.user_id].university = sp.university;
            orphanedMap[sp.user_id].approved = sp.approved;
            orphanedMap[sp.user_id].scholar_created_at = sp.created_at;
        });

        orphanedSubjects.forEach(ss => {
            if (!orphanedMap[ss.user_id]) orphanedMap[ss.user_id] = { user_id: ss.user_id };
            if (!orphanedMap[ss.user_id].subjects) orphanedMap[ss.user_id].subjects = [];
            orphanedMap[ss.user_id].subjects.push({ subject_id: ss.subject_id, subject_name: ss.subject_name, approved: ss.approved });
        });

        orphanedVideos.forEach(v => {
            if (!orphanedMap[v.user_id]) orphanedMap[v.user_id] = { user_id: v.user_id };
            orphanedMap[v.user_id].video_count = v.video_count;
        });

        const orphanedUsers = Object.values(orphanedMap);

        res.json({ orphanedUsers });
    } catch (error) {
        console.error("Error fetching orphaned users:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

/**
 * Clean up orphaned data for a specific user_id
 */
const cleanupOrphanedUser = async (req, res) => {
    try {
        const { userId } = req.params;

        // Make sure this user truly doesn't exist in users table
        const [existing] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
        if (existing.length > 0) {
            return res.status(400).json({ message: "User still exists in the system. Use the regular delete function instead." });
        }

        const cleanupTables = [
            'DELETE FROM admin_activity_log WHERE user_id = ?',
            'DELETE FROM admin_profiles WHERE user_id = ?',
            'DELETE FROM subject_purchases WHERE buyer_user_id = ?',
            'DELETE FROM videos WHERE scholar_user_id = ?',
            'DELETE FROM scholar_subjects WHERE scholar_user_id = ?',
            'DELETE FROM scholar_profile WHERE user_id = ?',
            'DELETE FROM user_roles WHERE user_id = ?',
        ];

        let totalDeleted = 0;
        for (const query of cleanupTables) {
            try {
                const [result] = await pool.query(query, [userId]);
                totalDeleted += result.affectedRows || 0;
            } catch (err) {
                console.warn(`Cleanup warning for orphaned user ${userId}:`, err.message);
            }
        }

        // Log activity
        await logActivity(req.user.id, 'CLEANUP_ORPHANED', 'user', userId, `Cleaned up ${totalDeleted} orphaned records for user_id ${userId}`);

        res.json({ message: `Cleaned up ${totalDeleted} orphaned records for user #${userId}` });
    } catch (error) {
        console.error("Error cleaning up orphaned user:", error);
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
    getOrphanedUsers,
    cleanupOrphanedUser,
    getSecurityUpdates,
    createSecurityUpdate,
    updateSecurityStatus,
    getActivityLog,
    getSuperAdminStats
};
