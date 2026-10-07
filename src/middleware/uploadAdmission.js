const { pool } = require('../config/db');
const { ownedCourse, courseVideos, positiveId, validateUpload } = require('../utils/courseContent');
const { logError } = require('../utils/safeLogging');
async function videoAdmission(req,res,next) {
 try {
  const [roles]=await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[req.user.id]);
  if(!roles.some(r=>r.name==='Scholar'))return res.status(403).json({message:'Current Scholar permission is required'});
  let subjectId=req.query.subjectId;
  // Legacy file-first forms can be pre-authorized when the applicant has exactly
  // one approved course. Multiple-course clients must supply the query identifier.
  if(subjectId===undefined){
   const [courses]=await pool.query(`SELECT ss.subject_id FROM scholar_subjects ss JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id
     WHERE ss.scholar_user_id=? AND ss.approved=1 AND sp.approved=1`,[req.user.id]);
   if(courses.length!==1)return res.status(400).json({message:'Select the target course in the upload URL. Refresh the upload form.'});
   subjectId=courses[0].subject_id;
  }
  if(typeof subjectId!=='string'&&typeof subjectId!=='number')return res.status(400).json({message:'Invalid course identifier'});
  req.uploadSubjectId=positiveId(subjectId);
  await ownedCourse(pool,req.user.id,req.uploadSubjectId);
  validateUpload(await courseVideos(pool,req.user.id,req.uploadSubjectId),1);
  next();
 } catch(error){if(error.status)return res.status(error.status).json({message:error.message});logError('Upload admission failed',error);res.status(503).json({message:'Unable to verify upload permissions'});}
}
async function applicantAdmission(req,res,next) {
 try {const [rows]=await pool.query('SELECT id FROM scholar_profile WHERE user_id=?',[req.user.id]);if(rows.length)return res.status(400).json({message:'You have already applied to become a scholar'});next();}
 catch(error){logError('Application upload admission failed',error);res.status(503).json({message:'Unable to verify application eligibility'});}
}
module.exports={videoAdmission,applicantAdmission};
