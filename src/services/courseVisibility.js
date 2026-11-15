'use strict';
const {positiveId,fail,withCourseLock}=require('../utils/courseContent');
const {audit,actorFromDb}=require('./operations/common');

// Visibility is independent of approval, publication, paid access and media.
// No row means visible; only an explicit SuperAdmin action creates a row.
function publicVisibilitySql(alias='ss'){
 if(!/^[a-z][a-z0-9_]*$/.test(alias))throw Error('Invalid internal offering alias');
 return `NOT EXISTS (SELECT 1 FROM course_visibility cv WHERE cv.offering_id=${alias}.id AND cv.hidden=1)`;
}
async function setVisibility(pool,user,offeringValue,body={}){
 const offeringId=positiveId(offeringValue);
 if(Object.keys(body).sort().join(',')!=='hidden,revision'||typeof body.hidden!=='boolean'||!Number.isSafeInteger(body.revision)||body.revision<0)fail(400,'Provide the visibility and current revision');
 const actor=await actorFromDb(pool,user);if(!actor.roles.includes('SuperAdmin'))fail(403,'SuperAdmin required');
 const [[context]]=await pool.query('SELECT subject_id,scholar_user_id FROM scholar_subjects WHERE id=?',[offeringId]);if(!context)fail(404,'Course unavailable');
 return withCourseLock(pool,context.scholar_user_id,context.subject_id,async db=>{
  await db.beginTransaction();
  try{
   const currentActor=await actorFromDb(db,user);if(!currentActor.roles.includes('SuperAdmin'))fail(403,'SuperAdmin required');
   const [[offering]]=await db.query('SELECT id FROM scholar_subjects WHERE id=? AND subject_id=? AND scholar_user_id=?',[offeringId,context.subject_id,context.scholar_user_id]);
   if(!offering)fail(409,'Course changed; reload before acting');
   const [[uploaded]]=await db.query('SELECT COUNT(*) AS n FROM videos WHERE subject_id=? AND scholar_user_id=?',[context.subject_id,context.scholar_user_id]);if(!Number(uploaded.n))fail(409,'Only an uploaded course can be hidden or unhidden');
   const [[row]]=await db.query('SELECT hidden,revision FROM course_visibility WHERE offering_id=? FOR UPDATE',[offeringId]);
   const hidden=row?Number(row.hidden)===1:false,revision=row?Number(row.revision):0;
   if(row&&(![0,1].includes(Number(row.hidden))||!Number.isSafeInteger(revision)||revision<1))fail(503,'Course visibility is unavailable');
   if(revision!==body.revision||hidden===body.hidden)fail(409,'Course visibility changed; reload before acting');
   await db.query('INSERT INTO course_visibility (offering_id,hidden,revision,updated_by) VALUES (?,?,1,?) ON DUPLICATE KEY UPDATE hidden=VALUES(hidden),revision=revision+1,updated_by=VALUES(updated_by)',[offeringId,body.hidden?1:0,currentActor.id]);
   await audit(db,currentActor,body.hidden?'COURSE_HIDE':'COURSE_UNHIDE','course_visibility',offeringId,{previousHidden:hidden,hidden:body.hidden,revision:revision+1});
   await db.commit();return {success:true,hidden:body.hidden,revision:revision+1};
  }catch(error){await db.rollback();throw error;}
 });
}
module.exports={publicVisibilitySql,setVisibility};
