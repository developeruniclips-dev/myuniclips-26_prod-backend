const { pool } = require('../config/db');

/**
 * Get all countries
 */
const getAllCountries = async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, code FROM countries ORDER BY name'
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching countries:", error);
        res.status(500).json({ message: "Server error fetching countries", error: error.message });
    }
};

/**
 * Get universities by country
 */
const getUniversitiesByCountry = async (req, res) => {
    try {
        const { countryId } = req.params;
        
        if (!countryId) {
            return res.status(400).json({ message: "Country ID is required" });
        }
        
        const [rows] = await pool.query(
            'SELECT id, name, short_name FROM universities WHERE country_id = ? ORDER BY name',
            [countryId]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching universities:", error);
        res.status(500).json({ message: "Server error fetching universities", error: error.message });
    }
};

/**
 * Get all universities (for admin purposes)
 */
const getAllUniversities = async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT u.id, u.name, u.short_name, u.country_id, c.name as country_name, c.code as country_code
            FROM universities u
            JOIN countries c ON u.country_id = c.id
            ORDER BY c.name, u.name
        `);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching all universities:", error);
        res.status(500).json({ message: "Server error fetching universities", error: error.message });
    }
};

/**
 * Get degree programs by university
 * Returns all distinct degree programs that have subjects associated with this university
 */
const getProgramsByUniversity = async (req, res) => {
    try {
        const { universityId } = req.params;
        
        if (!universityId) {
            return res.status(400).json({ message: "University ID is required" });
        }
        
        // Filter programs by university_id
        const [rows] = await pool.query(`
            SELECT DISTINCT degree_programmes as program 
            FROM subjects 
            WHERE university_id = ? 
              AND degree_programmes IS NOT NULL 
              AND degree_programmes != ''
            ORDER BY degree_programmes
        `, [universityId]);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching programs by university:", error);
        res.status(500).json({ message: "Server error fetching programs", error: error.message });
    }
};

/**
 * Get subjects by program (and optionally university)
 */
const getSubjectsByUniversityAndProgram = async (req, res) => {
    try {
        const { universityId, program } = req.params;
        
        // For now, just filter by program
        // Later we can also filter by university_id when subjects are linked
        const [rows] = await pool.query(
            'SELECT id, name, degree_programmes FROM subjects WHERE degree_programmes = ? ORDER BY name',
            [decodeURIComponent(program)]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching subjects:", error);
        res.status(500).json({ message: "Server error fetching subjects", error: error.message });
    }
};

/**
 * Admin: Add a new country
 */
const addCountry = async (req, res) => {
    try {
        const { name, code } = req.body;
        
        if (!name || !code) {
            return res.status(400).json({ message: "Country name and code are required" });
        }
        
        const [result] = await pool.query(
            'INSERT INTO countries (name, code) VALUES (?, ?)',
            [name, code.toUpperCase()]
        );
        
        res.status(201).json({ 
            message: "Country added successfully",
            id: result.insertId,
            name,
            code: code.toUpperCase()
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: "Country already exists" });
        }
        console.error("Error adding country:", error);
        res.status(500).json({ message: "Server error adding country", error: error.message });
    }
};

/**
 * Admin: Add a new university
 */
const addUniversity = async (req, res) => {
    try {
        const { name, countryId, shortName } = req.body;
        
        if (!name || !countryId) {
            return res.status(400).json({ message: "University name and country are required" });
        }
        
        const [result] = await pool.query(
            'INSERT INTO universities (name, country_id, short_name) VALUES (?, ?, ?)',
            [name, countryId, shortName || null]
        );
        
        res.status(201).json({ 
            message: "University added successfully",
            id: result.insertId,
            name,
            countryId,
            shortName
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: "University already exists in this country" });
        }
        console.error("Error adding university:", error);
        res.status(500).json({ message: "Server error adding university", error: error.message });
    }
};

module.exports = {
    getAllCountries,
    getUniversitiesByCountry,
    getAllUniversities,
    getProgramsByUniversity,
    getSubjectsByUniversityAndProgram,
    addCountry,
    addUniversity
};
