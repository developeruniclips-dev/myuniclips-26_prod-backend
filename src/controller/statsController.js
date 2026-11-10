const { pool } = require("../config/db");
const {catalogueReads,readQuery,readFailure}=require('../utils/readCapacity');

// Get platform statistics
const getPlatformStats = async (req, res) => {
  try {
    await catalogueReads.run(null,async()=>{
    // Get total users (learners)
    const [usersResult] = await readQuery(pool,"SELECT COUNT(*) as count FROM users");
    
    // Get total approved scholars
    const [scholarsResult] = await readQuery(pool,
      "SELECT COUNT(*) as count FROM scholar_profile WHERE approved = 1"
    );
    
    // Get total distinct courses (subjects with approved videos)
    const [coursesResult] = await readQuery(pool,
      "SELECT COUNT(DISTINCT subject_id) as count FROM videos WHERE approved = 1"
    );
    
    // Get total approved videos
    const [videosResult] = await readQuery(pool,
      "SELECT COUNT(*) as count FROM videos WHERE approved = 1"
    );

    res.json({
      success: true,
      stats: {
        learners: usersResult[0].count,
        scholars: scholarsResult[0].count,
        courses: coursesResult[0].count,
        videos: videosResult[0].count
      }
    });
    });
  } catch (error) {
    require('../utils/safeLogging').logError("Error fetching platform stats:", error);
    readFailure(res,error,"Error fetching platform statistics",{success:false});
  }
};

module.exports = {
  getPlatformStats
};
