// Upload-only admission, storage and lifecycle controls. No distributed queue/store.
const fs = require('node:fs'), path = require('node:path');
const multer = require('multer');
const { generateSecureFilename, createSecureFileFilter, validateFileContent } = require('./secureUpload');
const { logError } = require('../utils/safeLogging');
const roots = Object.freeze({ image: path.resolve(__dirname, '../../uploads/profile-images'), taskCard: path.resolve(__dirname, '../../private-uploads/task-cards'), video: path.resolve(__dirname, '../../private-uploads/videos') });
const policies = Object.freeze({
 image: { field:'profileImage', fields:['fname','lname','email','bio','favoriteSubject','favoriteFood','hobbies','avatarId','universityId','degreeProgramme'], fileSize:5*1024*1024, fieldSize:16*1024, concurrent:8, duration:120000 },
 taskCard: { field:'taskCard', fields:['countryId','universityId','university','degree','year'], fileSize:5*1024*1024, fieldSize:2048, concurrent:4, duration:120000 },
 video: { field:'video', fields:['subjectId','title','description','sequenceIndex'], fileSize:require('../config/courseLimits').maxVideoBytes, fieldSize:48*1024, concurrent:2, duration:4*60*60*1000 }
});
function createAdmission(max) {
 const active = new Set();
 return key => { if(active.size>=max || active.has(key)) return null; active.add(key); let released=false; return ()=>{if(!released){released=true;active.delete(key);}}; };
}
const admissions = Object.fromEntries(Object.entries(policies).map(([key,p])=>[key,createAdmission(p.concurrent)]));
function uploadError(res,error) {
 const message = error?.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload size limit' : 'Invalid or excessive multipart upload';
 if(!res.headersSent && !res.destroyed) res.status(400).json({message});
}
async function removeStored(file,root) {
 if(!file || path.dirname(path.resolve(file))!==path.resolve(root)) return false;
 try { await fs.promises.unlink(file); return true; } catch(error) { if(error.code!=='ENOENT')logError('Upload cleanup failed',error); return false; }
}
function storedReference(category,filename) {
 return category==='taskCard' ? `private-task-cards/${filename}` : `uploads/profile-images/${filename}`;
}
function profilePath(reference) {
 if(typeof reference!=='string'||!/^uploads\/profile-images\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(reference))return null;
 return path.join(roots.image,reference.split('/').at(-1));
}
function createUpload(category, { root=roots[category], beforeFile, admission=admissions[category] }={}) {
 const p=policies[category];
 const limits={files:1,fields:p.fields.length,parts:p.fields.length+1,fileSize:p.fileSize,fieldSize:p.fieldSize,fieldNameSize:64,fieldNestingDepth:0,fieldArrayIndexLimit:0};
 const storage=multer.diskStorage({
  destination(req,file,cb){fs.mkdir(root,{recursive:true},error=>cb(error,root));},
  filename(req,file,cb){const name=generateSecureFilename(file.originalname);req.uploadState.paths.add(path.join(root,name));cb(null,name);}
 });
 const parser=multer({storage,limits,fileFilter(req,file,cb){
  createSecureFileFilter(category)(req,file,(error,accept)=>{
   if(error||!accept)return cb(error,accept);
   Promise.resolve(beforeFile?.(req)).then(()=>cb(null,true),()=>cb(Object.assign(new Error('Upload denied'),{code:'UPLOAD_DENIED'})));
  });
 },streamHandler(req,busboy){
  let received=0;
  req.on('data',bytes=>{received+=bytes.length;if(received>p.fileSize+p.fields.length*p.fieldSize+65536) req.uploadState.rejectTransport(413,'Upload exceeds the request size limit');});
  req.pipe(busboy);
 }}).single(p.field);
 return function boundedUpload(req,res,next) {
  // JSON profile/application requests remain supported; file budgets apply to multipart.
  if(!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type']||''))return next();
  const release=admission(String(req.user?.id));
  if(!release)return res.status(429).json({message:'An upload is already active, or upload capacity is busy. Please try again shortly.'});
  const maxBytes=p.fileSize+p.fields.length*p.fieldSize+65536;
  if(Number(req.headers['content-length'])>maxBytes){release();return res.status(413).json({message:'Upload exceeds the request size limit'});}
  const state=req.uploadState={paths:new Set(),retained:new Set(),processing:false,done:false};
  const json=res.json;
  // The browser/deadline can close the response during provider or DB work.
  // Complete reconciliation/cleanup without throwing on a second response.
  res.json=function(body){if(this.headersSent||this.writableEnded||this.destroyed)return this;return json.call(this,body);};
  state.rejectTransport=(status,message)=>{
   if(state.rejected)return;
   state.rejected=true;
   if(!res.headersSent&&!res.destroyed){
    // Flush the controlled response before closing an oversized chunked request.
    // An immediate socket reset can discard the response on some networks.
    res.once('finish',()=>{req.socket.end();const close=setTimeout(()=>req.destroy(),1000);close.unref();});
    res.status(status).json({message});
   }
   else req.destroy();
  };
  const timer=setTimeout(()=>state.rejectTransport(408,'Upload timed out. Contact support before retrying if the transfer began.'),p.duration);timer.unref();
  state.finish=async()=>{if(state.done)return;state.done=true;clearTimeout(timer);try{for(const file of state.paths)if(!state.retained.has(file))await removeStored(file,root);}finally{release();}};
  res.once('finish',()=>{if(!state.processing)void state.finish();});
  res.once('close',()=>{if(!state.processing)void state.finish();});
  parser(req,res,async error=>{
   if(error){await state.finish();return uploadError(res,error);}
   try {
    if(Object.entries(req.body||{}).some(([key,value])=>!p.fields.includes(key)||typeof value!=='string'))throw new Error('Invalid fields');
    if(req.file&&!await validateFileContent(req.file.path,path.extname(req.file.filename)))throw new Error('Invalid content');
    if(req.aborted||res.destroyed){await state.finish();return;}
    next();
   }catch(error){await state.finish();uploadError(res,error);}
  });
 };
}
module.exports={roots,policies,createUpload,createAdmission,removeStored,storedReference,profilePath};
