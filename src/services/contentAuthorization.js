// Content authorization uses the authenticated account ID and current database facts only.
// No provider calls, payment writes, schema mutation or client purchase/role flags.
const ACTIVE_ENTITLEMENT_SQL=`is_access_active=1 AND created_at IS NOT NULL AND created_at<=NOW()
 AND (renewed_at IS NULL OR (renewed_at>=created_at AND renewed_at<=NOW()))
 AND access_expires_at IS NOT NULL AND access_expires_at>NOW()
 AND access_expires_at>COALESCE(renewed_at,created_at)
 AND access_expires_at<=DATE_ADD(COALESCE(renewed_at,created_at), INTERVAL 5 MONTH)`;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function positiveId(value){
 if(!['number','string'].includes(typeof value)||!/^\d+$/.test(String(value)))fail(400,'Invalid content identifier');
 const id=Number(value);if(!Number.isSafeInteger(id)||id<1)fail(400,'Invalid content identifier');return id;
}
const publicFields=['id','subject_id','scholar_user_id','title','description','price','is_free','is_first_preview','approved','sequence_index','created_at','subject_name','degree_programme','university_id','bundle_price','scholar_fname','scholar_lname','scholar_university','scholar_degree','expertise'];
function publicLesson(row){return {...Object.fromEntries(publicFields.filter(f=>Object.hasOwn(row,f)).map(f=>[f,row[f]])),is_free:Number(row.is_first_preview)===1?1:0};}
const activeEntitlementSql=alias=>ACTIVE_ENTITLEMENT_SQL.replace(/\b(is_access_active|created_at|renewed_at|access_expires_at)\b/g,field=>alias+'.'+field);
function playerMetadata(value){
 let url;try{url=new URL(value);}catch{fail(503,'Playback is temporarily unavailable');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash)fail(503,'Playback is temporarily unavailable');
 let match;
 if(['vimeo.com','www.vimeo.com'].includes(url.hostname))match=url.pathname.match(/^\/(\d+)(?:\/([a-zA-Z0-9]{6,64}))?\/?$/);
 else if(url.hostname==='player.vimeo.com')match=url.pathname.match(/^\/video\/(\d+)\/?$/);
 if(!match||url.port)fail(503,'Playback is temporarily unavailable');
 const h=match[2]||url.searchParams.get('h');if(h&&!/^[a-zA-Z0-9]{6,64}$/.test(h))fail(503,'Playback is temporarily unavailable');
 return {player_url:`https://player.vimeo.com/video/${match[1]}${h?'?h='+h:''}`};
}
function createContentAuthorization(pool){
 async function currentRoles(db,userId){const [roles]=await db.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id JOIN users u ON u.id=ur.user_id WHERE ur.user_id=?',[userId]);return roles.map(r=>r.name);}
 async function readCourse(actor,subjectValue,scholarValue,videoValue){
  if(!actor?.id)fail(401,'Authentication required');
  const userId=positiveId(actor.id),videoId=videoValue===undefined?undefined:positiveId(videoValue);
  let subjectId=subjectValue===undefined?undefined:positiveId(subjectValue),scholarId=scholarValue===undefined?undefined:positiveId(scholarValue);
  const db=await pool.getConnection();let started=false;
  try{
   await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await db.query('START TRANSACTION READ ONLY');started=true;
   const roles=await currentRoles(db,userId);if(!roles.length)fail(403,'Content access denied');
   const staff=roles.includes('Admin')||roles.includes('SuperAdmin');
   if(videoId!==undefined){const [[row]]=await db.query('SELECT subject_id,scholar_user_id FROM videos WHERE id=?',[videoId]);if(!row)fail(404,'Content unavailable');
    if((subjectId!==undefined&&subjectId!==Number(row.subject_id))||(scholarId!==undefined&&scholarId!==Number(row.scholar_user_id)))fail(404,'Content unavailable');
    subjectId=positiveId(row.subject_id);scholarId=positiveId(row.scholar_user_id);
   }
   if(subjectId===undefined||scholarId===undefined)fail(400,'Course and Scholar identifiers are required');
   const [offerings]=await db.query(`SELECT s.id,s.name,s.bundle_price,ss.approved AS application_approved,sp.approved AS profile_approved,cw.state AS workflow_state,cw.legacy_published
    FROM subjects s LEFT JOIN scholar_subjects ss ON ss.subject_id=s.id AND ss.scholar_user_id=?
    LEFT JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id LEFT JOIN course_workflows cw ON cw.offering_id=ss.id WHERE s.id=?`,[scholarId,subjectId]);
   const offering=offerings.length===1?offerings[0]:null;
   if(!offering)fail(404,'Content unavailable');
   const own=roles.includes('Scholar')&&userId===scholarId&&Number(offering.application_approved)===1&&Number(offering.profile_approved)===1;
   const publication=Number(offering.application_approved)===1&&Number(offering.profile_approved)===1&&offering.workflow_state==='PUBLISHED';
   if(!staff&&!own&&!publication)fail(404,'Content unavailable');
   const [videos]=await db.query('SELECT * FROM videos WHERE subject_id=? AND scholar_user_id=? ORDER BY sequence_index,id',[subjectId,scholarId]);
   if(!videos.length)fail(404,'Content unavailable');
   const ordered=videos.every(v=>Number.isSafeInteger(Number(v.sequence_index))&&Number(v.sequence_index)>0)&&new Set(videos.map(v=>Number(v.sequence_index))).size===videos.length;
   if(!staff&&!own&&Number(offering.legacy_published)!==1&&videos.some(v=>Number(v.approved)!==1))fail(404,'Content unavailable');
   if(!staff&&!own&&(!ordered||!videos.some(v=>Number(v.approved)===1)))fail(404,'Content unavailable');
   let active=false;
   if(!staff&&!own){const [purchases]=await db.query(`SELECT id FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=? AND ${ACTIVE_ENTITLEMENT_SQL}`,[userId,subjectId,scholarId]);active=purchases.length>0;}
   const firstId=ordered?Number(videos[0].id):null;
   const visible=videos.filter(v=>staff||own||Number(v.approved)===1).map(v=>({...publicLesson(v),is_first_preview:Number(v.id)===firstId,is_free:Number(v.id)===firstId?1:0,can_access:staff||own||active||Number(v.id)===firstId}));
   let playback;
   if(videoId!==undefined){const video=videos.find(v=>Number(v.id)===videoId),meta=visible.find(v=>Number(v.id)===videoId);
    if(!video||!meta)fail(404,'Content unavailable');if(!meta.can_access)fail(403,'An active course purchase is required');
    playback={...meta,...playerMetadata(video.video_url),subject_name:offering.name,bundle_price:offering.bundle_price};
   }
   await db.commit();started=false;
   return {subject_id:subjectId,scholar_id:scholarId,hasPurchased:active,operationalAccess:staff,ownerAccess:own,videos:visible,...(playback?{video:playback}:{})};
  }finally{try{if(started)await db.rollback();}finally{db.release();}}
 }
 async function requireScholar(actor){if(!actor?.id)fail(401,'Authentication required');const roles=await currentRoles(pool,positiveId(actor.id));if(!roles.includes('Scholar'))fail(403,'Content access denied');}
 return {course:(actor,subject,scholar)=>readCourse(actor,subject,scholar),playback:(actor,video,subject,scholar)=>readCourse(actor,subject,scholar,video),requireScholar};
}
module.exports={createContentAuthorization,ACTIVE_ENTITLEMENT_SQL,activeEntitlementSql,publicLesson,positiveId,playerMetadata};
