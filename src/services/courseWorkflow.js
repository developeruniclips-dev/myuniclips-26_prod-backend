const crypto=require('node:crypto');
const {fail,positiveId,ownedCourse,courseVideos,withCourseLock,validateMetadata,validateUpload}=require('../utils/courseContent');
const {audit}=require('./operations/common');
const EDITABLE=new Set(['DRAFT','CHANGES_REQUESTED']);
async function roles(db,userId){return (await db.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[positiveId(userId)]))[0].map(r=>r.name);}
async function workflow(db,offeringId){
 await db.query('INSERT IGNORE INTO course_workflows (offering_id) VALUES (?)',[offeringId]);
 const [[row]]=await db.query('SELECT * FROM course_workflows WHERE offering_id=?',[offeringId]);
 if(!row||!['DRAFT','CHANGES_REQUESTED','SUBMITTED_FOR_REVIEW','PUBLISHED'].includes(row.state))fail(503,'Course workflow is unavailable');return row;
}
async function editable(db,scholarId,subjectId){
 if(!(await roles(db,scholarId)).includes('Scholar'))fail(403,'Current Scholar permission required');
 const offering=await ownedCourse(db,scholarId,subjectId),state=await workflow(db,offering.id);
 if(!EDITABLE.has(state.state))fail(409,'This course is locked for review or publication');return {offering,state};
}
async function touch(db,offeringId){await db.query('UPDATE course_workflows SET revision=revision+1 WHERE offering_id=?',[offeringId]);}
async function noUploads(db,offeringId){const [[row]]=await db.query('SELECT COUNT(*) AS n FROM course_workflow_uploads WHERE offering_id=?',[offeringId]);if(Number(row.n))fail(409,'An upload is in progress or requires support reconciliation');}
const fingerprint=videos=>crypto.createHash('sha256').update(JSON.stringify(videos.map(v=>[v.id,v.subject_id,v.scholar_user_id,v.sequence_index,v.title,v.description,v.video_url,v.approved]))).digest('hex');
function validLessons(videos,subjectId,scholarId){
 if(!videos.length)fail(409,'Upload at least one lesson before submitting');
 validateUpload(videos.slice(0,-1),1);
 const positions=videos.map(v=>Number(v.sequence_index));
 if(positions.some(n=>!Number.isSafeInteger(n)||n<1)||new Set(positions).size!==videos.length)fail(409,'Arrange every lesson in a valid unique order');
 for(const v of videos){if(Number(v.subject_id)!==subjectId||Number(v.scholar_user_id)!==scholarId)fail(409,'Lesson relationship changed');validateMetadata(v);require('./contentAuthorization').playerMetadata(v.video_url);}
}
function createCourseWorkflow(pool,readiness){
 async function context(offeringId){const [[row]]=await pool.query('SELECT subject_id,scholar_user_id FROM scholar_subjects WHERE id=?',[positiveId(offeringId)]);if(!row)fail(404,'Course unavailable');return {subjectId:Number(row.subject_id),scholarId:Number(row.scholar_user_id)};}
 async function locked(ctx,work){return withCourseLock(pool,ctx.scholarId,ctx.subjectId,async db=>{await db.beginTransaction();try{const result=await work(db);await db.commit();return result;}catch(e){await db.rollback();throw e;}});}
 async function checkActor(db,actor,ctx,action){const current=await roles(db,actor.id);if(action==='submit'){if(Number(actor.id)!==ctx.scholarId||!current.includes('Scholar'))fail(403,'Course owner Scholar permission required');}else if(action==='reopen'){if(!current.includes('SuperAdmin'))fail(403,'SuperAdmin required');}else if(!current.some(r=>['Admin','SuperAdmin'].includes(r)))fail(403,'Current staff permission required');}
 async function transition(actor,offeringId,action,body={}){
  if(!['submit','publish','request-changes','reopen'].includes(action))fail(400,'Invalid course action');
  const ctx=await context(offeringId);let feedback=null;
  if(['request-changes','reopen'].includes(action)){feedback=typeof body.reason==='string'?body.reason.trim():'';if(feedback.length<8||feedback.length>2000)fail(400,'Provide meaningful feedback of 8–2000 characters');}
  const snapshot=await locked(ctx,async db=>{
   await checkActor(db,actor,ctx,action);const offering=await ownedCourse(db,ctx.scholarId,ctx.subjectId);
   if(Number(offering.id)!==Number(offeringId))fail(409,'Course relationship changed');
   const state=await workflow(db,offering.id);
   if(action==='submit'?!EDITABLE.has(state.state):state.state!=='SUBMITTED_FOR_REVIEW')fail(409,'Course state changed; reload before acting');
   await noUploads(db,offering.id);const videos=await courseVideos(db,ctx.scholarId,ctx.subjectId);
   if(['submit','publish'].includes(action))validLessons(videos,ctx.subjectId,ctx.scholarId);
   return {state,offering,videos,proof:fingerprint(videos)};
  });
  // No database connection/lock is retained during bounded provider metadata reads.
  if(['submit','publish'].includes(action))for(const v of snapshot.videos){const ready=await readiness.read(v.video_url,{fresh:true});if(ready.state!=='READY'||ready.policyVerified!==true)fail(409,ready.state==='PROCESSING'?'A lesson is still processing. Review and submit when ready.':'Lesson readiness is unavailable or failed; review before submitting');}
  return locked(ctx,async db=>{
   await checkActor(db,actor,ctx,action);const offering=await ownedCourse(db,ctx.scholarId,ctx.subjectId),state=await workflow(db,offering.id);
   await noUploads(db,offering.id);const videos=await courseVideos(db,ctx.scholarId,ctx.subjectId);
   if(Number(offering.id)!==Number(offeringId)||state.state!==snapshot.state.state||Number(state.revision)!==Number(snapshot.state.revision)||fingerprint(videos)!==snapshot.proof)fail(409,'Course changed during review; reload and retry');
   const next=action==='submit'?'SUBMITTED_FOR_REVIEW':action==='publish'?'PUBLISHED':'CHANGES_REQUESTED';
   if(action==='publish'){validLessons(videos,ctx.subjectId,ctx.scholarId);if(body.confirmation!==`PUBLISH COURSE ${offeringId}`||Number(body.count)!==videos.length)fail(400,'Confirm the exact course and complete lesson count');await db.query('UPDATE videos SET approved=1 WHERE subject_id=? AND scholar_user_id=?',[ctx.subjectId,ctx.scholarId]);}
   await db.query(`UPDATE course_workflows SET state=?,revision=revision+1,feedback=?,
    submitted_by=IF(?='SUBMITTED_FOR_REVIEW',?,submitted_by),submitted_at=IF(?='SUBMITTED_FOR_REVIEW',NOW(),submitted_at),
    reviewed_by=IF(?='SUBMITTED_FOR_REVIEW',reviewed_by,?),reviewed_at=IF(?='SUBMITTED_FOR_REVIEW',reviewed_at,NOW()) WHERE offering_id=?`,[next,feedback,next,actor.id,next,next,actor.id,next,offering.id]);
   await audit(db,actor,`COURSE_${action.toUpperCase().replaceAll('-','_')}`,'course_workflow',offering.id,{previous:state.state,next,lessonCount:videos.length,...(feedback?{reason:feedback}:{})});
   return {success:true,state:next};
  });
 }
 async function reserve(db,scholarId,subjectId,size){const {offering}=await editable(db,scholarId,subjectId);const videos=await courseVideos(db,scholarId,subjectId);await noUploads(db,offering.id);validateUpload(videos,size);const id=crypto.randomUUID();await db.query("INSERT INTO course_workflow_uploads (id,offering_id,state) VALUES (?,?,'UPLOADING')",[id,offering.id]);await touch(db,offering.id);return {id,offeringId:offering.id,sequence:Math.max(0,...videos.map(v=>Number(v.sequence_index)))+1};}
 async function finish(db,reservation){await db.query('DELETE FROM course_workflow_uploads WHERE id=?',[reservation.id]);await touch(db,reservation.offeringId);}
 async function ambiguous(reservation){if(reservation)await pool.query("UPDATE course_workflow_uploads SET state='RECONCILIATION_REQUIRED' WHERE id=?",[reservation.id]);}
 async function list(actor,query={}){
  if(!(await roles(pool,actor.id)).some(r=>['Admin','SuperAdmin'].includes(r)))fail(403,'Staff required');
  const args=[],filter=query.state&&query.state!=='ALL'?query.state:null;
  if(filter&&!['DRAFT','SUBMITTED_FOR_REVIEW','CHANGES_REQUESTED','PUBLISHED'].includes(filter))fail(400,'Invalid course status');
  if(filter)args.push(filter);
  return require('./operations/data').paginate(pool,`ss.id,ss.subject_id,ss.scholar_user_id,s.name AS course,u.fname,u.lname,COALESCE(cw.state,'DRAFT') AS state,cw.feedback,cw.submitted_at,cw.reviewed_at,
   (SELECT COUNT(*) FROM videos v WHERE v.subject_id=ss.subject_id AND v.scholar_user_id=ss.scholar_user_id) AS lesson_count`,
   `FROM scholar_subjects ss JOIN subjects s ON s.id=ss.subject_id JOIN users u ON u.id=ss.scholar_user_id LEFT JOIN course_workflows cw ON cw.offering_id=ss.id
   WHERE EXISTS (SELECT 1 FROM videos v WHERE v.subject_id=ss.subject_id AND v.scholar_user_id=ss.scholar_user_id)${filter?" AND COALESCE(cw.state,'DRAFT')=?":''}`,args,query,"COALESCE(cw.state,'DRAFT')='SUBMITTED_FOR_REVIEW' DESC,ss.id DESC");
 }
 return {transition,reserve,finish,ambiguous,list};
}
module.exports={createCourseWorkflow,workflow,editable,touch,noUploads,validLessons,EDITABLE};
