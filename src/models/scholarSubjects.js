const {readBounded}=require('../utils/readCapacity');
const { pool } = require("../config/db");

const ScholarSubjectModel = {

    requestSubject: (scholar_id, subject_id, subject_name, degree, expertise) => {
        return pool.query(
            "INSERT INTO scholar_subjects (scholar_user_id, subject_id, subject_name, degree, expertise, approved) VALUES (?, ?, ?, ?, ?, 0)",
            [scholar_id, subject_id, subject_name, degree, expertise]
        );
    },

    checkExistingRequest: (scholar_user_id, subject_id) => {
        return pool.query(
            "SELECT * FROM scholar_subjects WHERE scholar_user_id = ? AND subject_id = ?",
            [scholar_user_id, subject_id]
        );
    },

    approveSubject: (scholar_user_id, subject_id) => {
        return pool.query(
            "UPDATE scholar_subjects SET approved = 1 WHERE scholar_user_id = ? AND subject_id = ?",
            [scholar_user_id, subject_id]
        );
    },

    isApproved: (scholar_user_id, subject_id) => {
        return pool.query(
            "SELECT approved FROM scholar_subjects WHERE scholar_user_id = ? AND subject_id = ?",
            [scholar_user_id, subject_id]
        );
    }, 

    getScholarSubjectsStatus: (scholar_user_id) => {
        return readBounded(pool,
            `SELECT 
                ss.id,
                ss.subject_id, 
                ss.subject_name, 
                ss.degree, 
                ss.expertise, 
                ss.approved,
                COALESCE(cw.state,'DRAFT') AS workflow_state,
                s.bundle_price,
                COALESCE(sp_stats.sales_count, 0) as sales_count,
                COALESCE(sp_stats.total_revenue, 0) as total_revenue,
                COALESCE(sp_stats.ngn_revenue,0) AS ngn_revenue,
                sp_stats.revenue_by_currency,
                'EUR' AS total_revenue_currency
            FROM scholar_subjects ss
            LEFT JOIN subjects s ON ss.subject_id = s.id
            LEFT JOIN course_workflows cw ON cw.offering_id=ss.id
            LEFT JOIN (
                SELECT subject_id, scholar_id, SUM(sales_count) as sales_count,
                    SUM(CASE WHEN currency='EUR' THEN revenue ELSE 0 END) as total_revenue,
                    SUM(CASE WHEN currency='NGN' THEN revenue ELSE 0 END) AS ngn_revenue,
                    JSON_OBJECTAGG(currency,revenue) AS revenue_by_currency
                FROM (SELECT subject_id,scholar_id,currency,COUNT(*) AS sales_count,SUM(amount) AS revenue
                    FROM subject_purchases WHERE scholar_id = ? GROUP BY subject_id,scholar_id,currency) currency_sales
                GROUP BY subject_id, scholar_id
            ) sp_stats ON ss.subject_id = sp_stats.subject_id AND ss.scholar_user_id = sp_stats.scholar_id
            WHERE ss.scholar_user_id = ?`,
            [scholar_user_id,scholar_user_id]
        );
    },

    getAllScholarSubjects: (scholar_user_id) => {
        return readBounded(pool,
            "SELECT * FROM scholar_subjects WHERE scholar_user_id = ? ORDER BY created_at DESC",
            [scholar_user_id]
        );
    }   
};

module.exports = { ScholarSubjectModel };
