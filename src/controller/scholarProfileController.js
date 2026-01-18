const { pool } = require("../config/db");

// Get all scholar profile applications for admin
const getAllScholarApplications = async (req, res) => {
  try {
    const [applications] = await pool.query(`
      SELECT 
        sp.id as application_id,
        sp.user_id,
        sp.university,
        sp.degree,
        sp.year,
        sp.approved,
        sp.created_at,
        sp.task_card_url,
        u.fname,
        u.lname,
        u.email,
        u.profile_image_url
      FROM scholar_profile sp
      JOIN users u ON sp.user_id = u.id
      ORDER BY sp.created_at DESC
    `);

    res.json({
      message: "Scholar applications fetched successfully",
      applications
    });

  } catch (error) {
    console.error("Error fetching scholar applications:", error);
    res.status(500).json({
      message: "Server error fetching scholar applications",
      error
    });
  }
};

// Approve scholar application
const approveScholarApplication = async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Update scholar_profile to approved
    await pool.query(
      "UPDATE scholar_profile SET approved = 1 WHERE user_id = ?",
      [user_id]
    );

    // Make sure user has Scholar role
    const [userRoles] = await pool.query(
      "SELECT * FROM user_roles WHERE user_id = ? AND role_id = 3",
      [user_id]
    );

    if (userRoles.length === 0) {
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES (?, 3)",
        [user_id]
      );
    }

    res.json({ message: "Scholar application approved successfully" });

  } catch (error) {
    console.error("Error approving scholar application:", error);
    res.status(500).json({
      message: "Server error approving scholar application",
      error
    });
  }
};

// Reject scholar application
const rejectScholarApplication = async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "User ID is required" });
    }

    // Delete the scholar profile application
    await pool.query(
      "DELETE FROM scholar_profile WHERE user_id = ?",
      [user_id]
    );

    // Remove Scholar role if exists
    await pool.query(
      "DELETE FROM user_roles WHERE user_id = ? AND role_id = 3",
      [user_id]
    );

    // Update isScholar flag
    await pool.query(
      "UPDATE users SET isScholar = 0 WHERE id = ?",
      [user_id]
    );

    res.json({ message: "Scholar application rejected" });

  } catch (error) {
    console.error("Error rejecting scholar application:", error);
    res.status(500).json({
      message: "Server error rejecting scholar application",
      error
    });
  }
};

// Get scholar profile status for logged-in user
const getScholarProfileStatus = async (req, res) => {
  try {
    const user_id = req.user.id;

    // First check if user registered as a scholar
    const [userRow] = await pool.query(
      "SELECT isScholar FROM users WHERE id = ?",
      [user_id]
    );

    if (userRow.length === 0 || !userRow[0].isScholar) {
      return res.json({ 
        message: "User is not a scholar applicant",
        isScholar: false,
        approved: false,
        profile: null
      });
    }

    const [profile] = await pool.query(
      "SELECT * FROM scholar_profile WHERE user_id = ?",
      [user_id]
    );

    if (profile.length === 0) {
      return res.json({ 
        message: "Scholar application pending - no profile created yet",
        isScholar: true,
        approved: false,
        profile: null
      });
    }

    res.json({
      isScholar: true,
      profile: profile[0],
      approved: profile[0].approved === 1
    });

  } catch (error) {
    console.error("Error fetching scholar profile status:", error);
    res.status(500).json({
      message: "Server error fetching scholar profile status",
      error
    });
  }
};

module.exports = {
  getAllScholarApplications,
  approveScholarApplication,
  rejectScholarApplication,
  getScholarProfileStatus
};
