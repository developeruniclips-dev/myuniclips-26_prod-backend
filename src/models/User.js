const { pool } = require('../config/db');

const UserModel = {
    
    findAll: () => {
        return pool.query("SELECT * FROM users");
    },

    findById: (id) => {
        return pool.query("SELECT * FROM users WHERE id= ?", [id]);
    },

    create: (fname, lname, email, password = null, isScholar = 0) => {
        return pool.query(
            "INSERT INTO users (fname, lname, email, password, isScholar) VALUES (?, ?, ?, ?, ?)",
            [fname, lname, email, password, isScholar]
        );
    },

    update: (id, fname, lname, email) => {
        return pool.query(
            "UPDATE users SET fname = ?, lname = ?, email = ? WHERE id = ?",
            [fname, lname, email, id]
        );
    },

    delete: async (id) => {
        // Delete in order to respect foreign key constraints
        // Use try-catch for each to handle tables that might not exist
        try { await pool.query("DELETE FROM subject_purchases WHERE buyer_user_id = ? OR scholar_id = ?", [id, id]); } catch(e) { console.log('subject_purchases delete skipped:', e.message); }
        try { await pool.query("DELETE FROM user_library WHERE user_id = ?", [id]); } catch(e) { console.log('user_library delete skipped:', e.message); }
        try { await pool.query("DELETE FROM videos WHERE scholar_user_id = ?", [id]); } catch(e) { console.log('videos delete skipped:', e.message); }
        try { await pool.query("DELETE FROM scholar_subjects WHERE scholar_user_id = ?", [id]); } catch(e) { console.log('scholar_subjects delete skipped:', e.message); }
        try { await pool.query("DELETE FROM scholar_profile WHERE user_id = ?", [id]); } catch(e) { console.log('scholar_profile delete skipped:', e.message); }
        try { await pool.query("DELETE FROM user_roles WHERE user_id = ?", [id]); } catch(e) { console.log('user_roles delete skipped:', e.message); }
        try { await pool.query("DELETE FROM purchases WHERE user_id = ?", [id]); } catch(e) { console.log('purchases delete skipped:', e.message); }
        return pool.query("DELETE FROM users WHERE id = ?", [id]);
    },

    findByEmail: (email) => {
        return pool.query("SELECT * FROM users WHERE email = ?", [email]);
    },

    // Security methods
    incrementFailedAttempts: (id) => {
        return pool.query(
            "UPDATE users SET failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1, last_failed_login = NOW() WHERE id = ?",
            [id]
        );
    },

    lockAccount: (id, minutes = 15) => {
        return pool.query(
            "UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?",
            [minutes, id]
        );
    },

    resetFailedAttempts: (id) => {
        return pool.query(
            "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
            [id]
        );
    },

    updateLastLogin: (id) => {
        return pool.query(
            "UPDATE users SET last_login = NOW(), last_activity = NOW() WHERE id = ?",
            [id]
        );
    },

    updateRefreshToken: (id, token, expiresAt) => {
        return pool.query(
            "UPDATE users SET refresh_token = ?, refresh_token_expires = ? WHERE id = ?",
            [token, expiresAt, id]
        );
    },

    clearRefreshToken: (id) => {
        return pool.query(
            "UPDATE users SET refresh_token = NULL, refresh_token_expires = NULL WHERE id = ?",
            [id]
        );
    },

    updateLastActivity: (id) => {
        return pool.query(
            "UPDATE users SET last_activity = NOW() WHERE id = ?",
            [id]
        );
    },

    update2FA: (id, secret, enabled, backupCodes = null) => {
        return pool.query(
            "UPDATE users SET two_factor_secret = ?, two_factor_enabled = ?, two_factor_backup_codes = ? WHERE id = ?",
            [secret, enabled ? 1 : 0, backupCodes, id]
        );
    }
};

module.exports = { UserModel };
