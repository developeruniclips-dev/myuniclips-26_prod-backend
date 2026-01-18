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
    }
};

module.exports = { UserModel };
