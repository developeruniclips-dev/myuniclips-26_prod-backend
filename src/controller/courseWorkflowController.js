const {pool}=require('../config/db');
const {createCourseWorkflow}=require('../services/courseWorkflow');
const readiness=require('../services/videoReadiness').sharedVideoReadiness(require('../config/vimeo'));
const workflow=createCourseWorkflow(pool,readiness);
const content=require('../services/contentAuthorization').createContentAuthorization(pool);
const failure=(res,error)=>res.status(error.status||503).json({message:error.status?error.message:'Course review is temporarily unavailable'});
exports.list=async(req,res)=>{try{res.json(await workflow.list(req.user,req.query));}catch(e){failure(res,e);}};
exports.detail=async(req,res)=>{try{
 const [[row]]=await pool.query('SELECT subject_id,scholar_user_id FROM scholar_subjects WHERE id=?',[require('../utils/courseContent').positiveId(req.params.id)]);
 if(!row)return res.status(404).json({message:'Course unavailable'});
 res.json(await content.course(req.user,row.subject_id,row.scholar_user_id));
}catch(e){failure(res,e);}};
exports.transition=async(req,res)=>{try{res.json(await workflow.transition(req.user,req.params.id,req.params.action,req.body));}catch(e){failure(res,e);}};
