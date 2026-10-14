const { ScholarProfileModel } = require("../models/scholarProfile");

const scholarMustBeApproved = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await ScholarProfileModel.findByUserId(userId);
    if (rows.length === 0) return res.status(403).json({ message: "You are not a scholar" });

    const profile = rows[0];
    if (!profile.approved) return res.status(403).json({ message: "Scholar pending approval" });

    next();
  } catch (err) {
    require('../utils/safeLogging').logError('Permission lookup failed', err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = { scholarMustBeApproved };
