const { SubjectModel } = require('../models/subject');

//get all subjects
const getAllSubjects = async(req, res) => {
    try {
        const [rows] = await SubjectModel.findAll();
        res.status(201).json(rows);
    } catch (error) {
        console.error("Error fetching subjects:", error);
        res.status(500).json({message: "Internal server error", error});
    }
};

//get one subject
const getOneSubject = async(req, res) => {
    try {
        const id = Number(req.params.id);
        if(!id) {
            return res.status(404).json({message: "Subject ID not found"});
        }
        const [row] = await SubjectModel.findById(id);
        res.status(201).json(row);
    } catch (error) {
        console.error("Error fetching subjects: ", error);
        res.status(500).json({message: "Internal server error", error});
    }
};

//create subject
const createSubject = async(req, res) => {
    try {
        const { name, description} = req.body;

        const [result] = await SubjectModel.create(name, description);
        const newSubjectId = result.insertId;
        const [row] = await SubjectModel.findById(newSubjectId);

        res.status(201).json({
            message: "Subject created successfully",
            subject: row[0]
        });
    } catch (error) {
        console.error("Error creating subject: ", error);
        res.status(500).json({message: "Internal server error", error});
    }
};

// Get distinct programs (degree programs)
const getAllPrograms = async (req, res) => {
    try {
        const { pool } = require('../config/db');
        const [rows] = await pool.query(`
            SELECT DISTINCT degree_programmes as program, COUNT(*) as subject_count 
            FROM subjects 
            WHERE degree_programmes IS NOT NULL AND degree_programmes != ''
            GROUP BY degree_programmes 
            ORDER BY degree_programmes
        `);
        res.json(rows);
    } catch (error) {
        console.error("Error fetching programs:", error);
        res.status(500).json({ message: "Server error fetching programs", error });
    }
};

// Get subjects by program
const getSubjectsByProgram = async (req, res) => {
    try {
        const { program } = req.params;
        const { pool } = require('../config/db');
        const [rows] = await pool.query(
            'SELECT * FROM subjects WHERE degree_programmes = ? ORDER BY name',
            [program]
        );
        res.json(rows);
    } catch (error) {
        console.error("Error fetching subjects by program:", error);
        res.status(500).json({ message: "Server error fetching subjects", error });
    }
};

// Admin: Update bundle price for a subject
const updateBundlePrice = async (req, res) => {
    try {
        const { id } = req.params;
        const { bundlePrice } = req.body;

        if (!id) {
            return res.status(400).json({ message: "Subject ID is required" });
        }

        if (bundlePrice === undefined || bundlePrice < 0) {
            return res.status(400).json({ message: "Valid bundle price is required (must be >= 0)" });
        }

        // Check if subject exists
        const [existing] = await SubjectModel.findById(id);
        if (existing.length === 0) {
            return res.status(404).json({ message: "Subject not found" });
        }

        await SubjectModel.updateBundlePrice(id, bundlePrice);

        res.json({ 
            message: "Bundle price updated successfully",
            subjectId: id,
            newPrice: bundlePrice,
            updatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error("Error updating bundle price:", error);
        res.status(500).json({ message: "Server error updating bundle price", error });
    }
};

// Get subject bundle price
const getSubjectBundlePrice = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await SubjectModel.findByIdWithPrice(id);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: "Subject not found" });
        }

        res.json({
            subjectId: rows[0].id,
            name: rows[0].name,
            bundlePrice: rows[0].bundle_price || 6.00,
            priceUpdatedAt: rows[0].bundle_price_updated_at || null
        });
    } catch (error) {
        console.error("Error fetching bundle price:", error);
        res.status(500).json({ message: "Server error", error });
    }
};

module.exports = { 
    getAllSubjects, 
    getOneSubject, 
    createSubject, 
    getAllPrograms, 
    getSubjectsByProgram,
    updateBundlePrice,
    getSubjectBundlePrice
};
