const {pool}=require('../config/db');
const access=require('../services/contentAuthorization').createContentAuthorization(pool);

const canAccessVideo = async (req, res, next) => {
  try {
    req.authorizedContent=(await access.playback(req.user,req.params.id,req.query.subjectId,req.query.scholarId)).video;
    return next();
  } catch (err) {
    require('../utils/safeLogging').logError('Content authorization failed',err);
    res.status(err.status||503).json({message:err.status?err.message:'Content is temporarily unavailable'});
  }
};

module.exports = { canAccessVideo };
