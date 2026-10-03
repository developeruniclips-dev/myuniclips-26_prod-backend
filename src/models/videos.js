const { pool } = require("../config/db");

const VideoModel = {
  create: (scholarUserId, subjectId, title, description, videoUrl, price, isFree, sequenceIndex) =>
    pool.query(
      `INSERT INTO videos (scholar_user_id, subject_id, title, description, video_url, price, is_free, sequence_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [scholarUserId, subjectId, title, description, videoUrl, price, isFree ? 1 : 0, sequenceIndex]
    ),

  findById: (id) => pool.query("SELECT * FROM videos WHERE id = ?", [id]),

  findByIdWithDetails: (id) => {
    return pool.query(
      `SELECT 
          v.*, 
          u.fname AS scholar_fname, 
          u.lname AS scholar_lname, 
          u.email AS scholar_email,
          s.name AS subject_name
       FROM videos v
       JOIN users u ON v.scholar_user_id = u.id
       JOIN subjects s ON v.subject_id = s.id
       WHERE v.id = ?`,
      [id]
    );
  },

  getAllVideos: () => pool.query(`
    SELECT 
      v.*, 
      u.fname AS scholar_fname, 
      u.lname AS scholar_lname, 
      s.name AS subject_name,
      s.degree_programmes AS degree_programme,
      s.university_id,
      s.bundle_price,
      sp.university AS scholar_university,
      sp.degree AS scholar_degree,
      ss.expertise
    FROM videos v 
    JOIN users u ON v.scholar_user_id = u.id 
    JOIN subjects s ON v.subject_id = s.id 
    LEFT JOIN scholar_profile sp ON v.scholar_user_id = sp.user_id
    LEFT JOIN scholar_subjects ss ON v.subject_id = ss.subject_id AND v.scholar_user_id = ss.scholar_user_id
    WHERE v.approved = 1
    ORDER BY v.created_at DESC
  `),

  // Get ALL videos for admin (including unapproved)
  getAllVideosAdmin: () => pool.query(`
    SELECT 
      v.*, 
      u.fname AS scholar_fname, 
      u.lname AS scholar_lname, 
      u.email AS scholar_email, 
      s.name AS subject_name,
      s.degree_programmes AS degree_programme,
      s.bundle_price,
      sp.university AS scholar_university,
      sp.degree AS scholar_degree,
      ss.expertise
    FROM videos v 
    JOIN users u ON v.scholar_user_id = u.id 
    JOIN subjects s ON v.subject_id = s.id 
    LEFT JOIN scholar_profile sp ON v.scholar_user_id = sp.user_id
    LEFT JOIN scholar_subjects ss ON v.subject_id = ss.subject_id AND v.scholar_user_id = ss.scholar_user_id
    ORDER BY v.approved ASC, v.created_at DESC
  `),

  findBySubjectWithDetails: (subjectId) => pool.query(`
    SELECT 
      v.*, 
      u.fname AS scholar_fname, 
      u.lname AS scholar_lname, 
      u.email AS scholar_email, 
      s.name AS subject_name,
      sp.university,
      sp.degree,
      ss.expertise
    FROM videos v 
    JOIN users u ON v.scholar_user_id = u.id 
    JOIN subjects s ON v.subject_id = s.id 
    LEFT JOIN scholar_profile sp ON v.scholar_user_id = sp.user_id
    LEFT JOIN scholar_subjects ss ON v.subject_id = ss.subject_id AND v.scholar_user_id = ss.scholar_user_id
    WHERE v.subject_id = ? AND v.approved = 1
    ORDER BY v.sequence_index ASC
  `, [subjectId]),

  findBySubject: (subjectId) => pool.query("SELECT * FROM videos WHERE subject_id = ? ORDER BY sequence_index", [subjectId]),

  findByScholar: (scholarId) => pool.query("SELECT * FROM videos WHERE scholar_user_id = ? ORDER BY created_at DESC", [scholarId]),

  countByScholarAndSubject: (scholarId, subjectId) => pool.query(
    "SELECT COUNT(*) as count FROM videos WHERE scholar_user_id = ? AND subject_id = ?",
    [scholarId, subjectId]
  ),

  approve: (id, price) => {
    const isFree = Number(price) === 0;
    return pool.query(
      "UPDATE videos SET approved = 1, price = ?, is_free = ? WHERE id = ?",
      [price, isFree ? 1 : 0, id]
    );
  },

  updatePrice: (id, price) => {
    const isFree = Number(price) === 0;
    return pool.query(
      "UPDATE videos SET price = ?, is_free = ? WHERE id = ?",
      [price, isFree ? 1 : 0, id]
    );
  },

  deleteById: (id) => pool.query("DELETE FROM videos WHERE id = ?", [id])
};

module.exports = { VideoModel };
