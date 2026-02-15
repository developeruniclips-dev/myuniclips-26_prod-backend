const { ScholarSubjectModel } = require("../models/scholarSubjects");

const requestSubject = async(req, res) => {
    try {
            const scholar_id = req.user.id;
            const { subject_id, degree, expertise } = req.body;

            const [exist] = await ScholarSubjectModel.checkExistingRequest(scholar_id, subject_id);

            if (exist.length > 0) {
                return res.status(400).json({ message: "Already requested" });
            }

            // Get subject name from subjects table
            const { pool } = require("../config/db");
            const [subjects] = await pool.query("SELECT name FROM subjects WHERE id = ?", [subject_id]);
            const subject_name = subjects[0]?.name || '';

            await ScholarSubjectModel.requestSubject(scholar_id, subject_id, subject_name, degree, expertise);

            res.json({ message: "Subject request sent" });
    } catch (error) {
        console.error("Error requesting subjects", error);
        res.status(500).json({message: "Server error requesting subjects", error});
    }
};

const approveSubject = async(req, res) => {
    try {
            const { scholar_id, subject_id } = req.body;

            await ScholarSubjectModel.approveSubject(scholar_id, subject_id);

            res.json({ message: "Subject approved" });
    } catch (error) {
        console.error("Error approving subject", error);
        res.status(500).json({message: "Server error approving subject", error});
    }
};

// Approve subject by ID (for admin)
const approveSubjectById = async(req, res) => {
    try {
        const { id } = req.params;
        const { pool } = require("../config/db");

        await pool.query("UPDATE scholar_subjects SET approved = 1 WHERE id = ?", [id]);

        res.json({ message: "Course application approved" });
    } catch (error) {
        console.error("Error approving course:", error);
        res.status(500).json({ message: "Server error approving course", error });
    }
};

// Reject/Delete subject application by ID (for admin)
const rejectSubjectById = async(req, res) => {
    try {
        const { id } = req.params;
        const { pool } = require("../config/db");

        await pool.query("DELETE FROM scholar_subjects WHERE id = ?", [id]);

        res.json({ message: "Course application rejected" });
    } catch (error) {
        console.error("Error rejecting course:", error);
        res.status(500).json({ message: "Server error rejecting course", error });
    }
};

// Delete subject by scholar (only their own)
const deleteSubjectByScholar = async(req, res) => {
    try {
        const { id } = req.params;
        const scholarId = req.user.id;
        const { pool } = require("../config/db");

        // First verify this subject belongs to the scholar
        const [existing] = await pool.query(
            "SELECT id FROM scholar_subjects WHERE id = ? AND scholar_user_id = ?", 
            [id, scholarId]
        );

        if (existing.length === 0) {
            return res.status(404).json({ message: "Course not found or not yours to delete" });
        }

        // Delete associated videos first
        const [subject] = await pool.query("SELECT subject_id FROM scholar_subjects WHERE id = ?", [id]);
        if (subject.length > 0) {
            await pool.query(
                "DELETE FROM videos WHERE subject_id = ? AND scholar_user_id = ?", 
                [subject[0].subject_id, scholarId]
            );
        }

        // Delete the subject
        await pool.query("DELETE FROM scholar_subjects WHERE id = ?", [id]);

        res.json({ message: "Course and associated videos deleted successfully" });
    } catch (error) {
        console.error("Error deleting course:", error);
        res.status(500).json({ message: "Server error deleting course", error });
    }
};

const getScholarSubjectsStatus = async (req, res) => {
  try {
    const scholar_id = req.user.id;

    const [subjects] = await ScholarSubjectModel.getScholarSubjectsStatus(scholar_id);

    res.json({ subjects });
  } catch (error) {
    console.error("Error fetching subject status", error);
    res.status(500).json({ message: "Server error fetching subject status", error });
  }
};

const getAllScholarSubjects = async (req, res) => {
    try {
        const scholar_id = req.user.id;

        const [rows] = await ScholarSubjectModel.getAllScholarSubjects(scholar_id);

        return res.json({
            message: "Subjects fetched successfully",
            subjects: rows
        });

    } catch (error) {
        console.error("Error fetching subjects", error);
        return res.status(500).json({
            message: "Server error fetching subjects",
            error
        });
    }
};

const getAllScholarSubjectsAdmin = async (req, res) => {
    try {
        const { pool } = require("../config/db");
        const [rows] = await pool.query(`
            SELECT 
                ss.id,
                ss.scholar_user_id,
                ss.subject_id,
                ss.subject_name,
                ss.degree,
                ss.expertise,
                ss.approved,
                ss.created_at,
                u.fname,
                u.lname,
                u.email,
                u.profile_image_url,
                (SELECT COUNT(*) FROM videos WHERE scholar_user_id = ss.scholar_user_id AND subject_id = ss.subject_id) as video_count,
                (SELECT COUNT(*) FROM videos WHERE scholar_user_id = ss.scholar_user_id AND subject_id = ss.subject_id AND approved = 1) as approved_video_count
            FROM scholar_subjects ss
            JOIN users u ON ss.scholar_user_id = u.id
            ORDER BY ss.created_at DESC
        `);

        return res.json({
            message: "All subjects fetched successfully",
            subjects: rows
        });

    } catch (error) {
        console.error("Error fetching all subjects", error);
        return res.status(500).json({
            message: "Server error fetching all subjects",
            error
        });
    }
};

module.exports = {
  requestSubject,
  approveSubject,
  approveSubjectById,
  rejectSubjectById,
  deleteSubjectByScholar,
  getScholarSubjectsStatus,
  getAllScholarSubjects,
  getAllScholarSubjectsAdmin
};
