const { ScholarSubjectModel } = require("../models/scholarSubjects");

const requestSubject = async(req, res) => {
    try {
            const scholar_id = req.user.id;
            const { subject_id, expertise } = req.body;
            const { pool } = require('../config/db');
            const { scholarContext, availableSubjects } = require('../utils/academicContext');
            const profile = await scholarContext(pool, scholar_id);
            if (!profile?.approved) return res.status(403).json({ message: 'Scholar approval is required' });
            const available = await availableSubjects(pool, profile);
            const subject = available.find(row => Number(row.id) === Number(subject_id));
            if (!subject) return res.status(403).json({ message: 'Choose a course from your approved university and programme' });
            const degree = profile.degree;

            const [exist] = await ScholarSubjectModel.checkExistingRequest(scholar_id, subject_id);

            if (exist.length > 0) {
                return res.status(400).json({ message: "Already requested" });
            }

            // Get subject name from subjects table
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

        const [[subject]] = await pool.query('SELECT subject_id FROM scholar_subjects WHERE id = ?', [id]);
        const { withCourseLock, fail } = require('../utils/courseContent');
        await withCourseLock(pool, scholarId, subject.subject_id, async db => {
            const wf=require('../services/courseWorkflow');
            const state=await wf.workflow(db,id);
            if(!wf.EDITABLE.has(state.state))fail(409,'This course is locked for review or publication');
            await wf.noUploads(db,id);
            const [[content]] = await db.query('SELECT COUNT(*) AS count FROM videos WHERE subject_id = ? AND scholar_user_id = ?', [subject.subject_id, scholarId]);
            const [[sales]] = await db.query('SELECT COUNT(*) AS count FROM subject_purchases WHERE subject_id = ? AND scholar_id = ?', [subject.subject_id, scholarId]);
            if (Number(content.count) || Number(sales.count)) fail(409, 'Courses with content or historical sales cannot be deleted here. Manage unapproved lessons individually.');
            await db.beginTransaction();try{
            await db.query('DELETE FROM course_workflows WHERE offering_id=?',[id]);
            await db.query('DELETE FROM scholar_subjects WHERE id = ? AND scholar_user_id = ?', [id, scholarId]);
            await db.commit();}catch(error){await db.rollback();throw error;}
        });

        res.json({ message: "Empty course application removed" });
    } catch (error) {
        console.error("Error deleting course:", error);
        res.status(error.status || 500).json({ message: error.status ? error.message : "Server error deleting course" });
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
