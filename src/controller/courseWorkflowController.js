const {pool}=require('../config/db');
const {createCourseWorkflow}=require('../services/courseWorkflow');
const readiness=require('../services/videoReadiness').sharedVideoReadiness(require('../config/vimeo'));
const workflow=createCourseWorkflow(pool,readiness);
const content=require('../services/contentAuthorization').createContentAuthorization(pool);
const failure=(res,error)=>res.status(error.status||503).json({message:error.status?error.message:'Course review is temporarily unavailable',...(/^LESSON_(?:PROCESSING|PROCESSING_FAILED|SECURITY_CHECK_FAILED|SECURITY_VERIFICATION_UNAVAILABLE|READINESS_UNAVAILABLE)$/.test(error.code||'')&&Number.isSafeInteger(error.lessonId)?{code:error.code,lessonId:error.lessonId,readinessState:error.readinessState}:{})});
exports.list=async(req,res)=>{try{res.json(await workflow.list(req.user,req.query));}catch(e){failure(res,e);}};
exports.detail=async(req,res)=>{try{
 const [[row]]=await pool.query('SELECT ss.subject_id,ss.scholar_user_id,s.name AS course_name,cw.state,cw.revision,cw.feedback FROM scholar_subjects ss JOIN subjects s ON s.id=ss.subject_id LEFT JOIN course_workflows cw ON cw.offering_id=ss.id WHERE ss.id=?',[require('../utils/courseContent').positiveId(req.params.id)]);
 if(!row)return res.status(404).json({message:'Course unavailable'});
 const detail=await content.course(req.user,row.subject_id,row.scholar_user_id);
 res.json({...detail,offeringId:Number(req.params.id),courseName:row.course_name,workflow:{state:row.state||'DRAFT',revision:row.revision,feedback:row.feedback}});
}catch(e){failure(res,e);}};
exports.transition=async(req,res)=>{try{res.json(await workflow.transition(req.user,req.params.id,req.params.action,req.body));}catch(e){failure(res,e);}};
