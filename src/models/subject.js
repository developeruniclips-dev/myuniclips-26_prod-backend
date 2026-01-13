const { pool } = require('../config/db');

const SubjectModel = {
    findAll: () => pool.query("SELECT * FROM subjects"),

    findById: (id) => pool.query("SELECT * FROM subjects WHERE id = ?", [id]),

    create: (name, description) => 
        pool.query("INSERT INTO subjects (name, description) VALUES (?, ?)", [name, description]),

    update: (id, name, description) => {
        return pool.query("UPDATE subjects SET name = ?, description = ? WHERE id = ?", [name, description, id]);
    },

    delete: (id) => {
        return pool.query("DELETE FROM subjects WHERE id = ?", [id]);
    },

    // Update bundle price for a subject with timestamp (admin only)
    updateBundlePrice: (subjectId, bundlePrice) => {
        return pool.query(
            "UPDATE subjects SET bundle_price = ?, bundle_price_updated_at = NOW() WHERE id = ?", 
            [bundlePrice, subjectId]
        );
    },

    // Get subject with bundle price
    findByIdWithPrice: (id) => pool.query(
        "SELECT id, name, description, degree_programmes, bundle_price, bundle_price_updated_at FROM subjects WHERE id = ?", 
        [id]
    )
};

module.exports = { SubjectModel };
