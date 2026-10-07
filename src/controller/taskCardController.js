const fs=require('node:fs'),path=require('node:path');
const { pool }=require('../config/db');
const { roots }=require('../middleware/uploadSecurity');
const { logError }=require('../utils/safeLogging');
const mime={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',pdf:'application/pdf'};
function taskCardPath(reference){
 if(typeof reference!=='string')return null;
 const match=/^(private-task-cards|uploads\/task-cards)\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|pdf))$/i.exec(reference);
 if(!match)return null;
 const root=match[1]==='private-task-cards'?roots.taskCard:path.resolve(__dirname,'../../uploads/task-cards');
 return {root,file:path.join(root,match[2]),extension:path.extname(match[2]).slice(1).toLowerCase()};
}
async function getTaskCard(req,res){
 try{
  const owner=Number(req.params.userId);
  if(!Number.isSafeInteger(owner)||owner<1)return res.status(400).json({message:'Invalid applicant identifier'});
  if(owner!==Number(req.user.id)){
   const [roles]=await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[req.user.id]);
   if(!roles.some(r=>['Admin','SuperAdmin'].includes(r.name)))return res.status(403).json({message:'Access denied'});
  }
  const [[application]]=await pool.query('SELECT task_card_url FROM scholar_profile WHERE user_id=?',[owner]);
  const target=taskCardPath(application?.task_card_url);
  if(!target)return res.status(404).json({message:'Document unavailable'});
  // Refuse a symlink escaping the approved root, even for legacy stored names.
  const realRoot=await fs.promises.realpath(target.root),realFile=await fs.promises.realpath(target.file);
  const stat=await fs.promises.lstat(target.file);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>5*1024*1024||path.dirname(realFile)!==realRoot)return res.status(404).json({message:'Document unavailable'});
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Type',mime[target.extension]);
  res.setHeader('Content-Disposition',`attachment; filename="task-card.${target.extension}"`);
  res.sendFile(realFile,error=>{if(error&&!res.headersSent)res.status(404).json({message:'Document unavailable'});});
 }catch(error){logError('Private document retrieval failed',error);if(!res.headersSent)res.status(error.code==='ENOENT'?404:503).json({message:'Document unavailable'});}
}
function publicUploadBoundary(req,res,next){
 // Decode each segment once as express.static does. Deny the entire legacy folder,
 // including encoded separators/dot segments, before static file resolution.
 try{
  const pathname=decodeURIComponent(req.path).replaceAll('\\','/');
  if(/[\u0000-\u001f\u007f]/.test(pathname))return res.status(400).json({message:'Invalid file request'});
  const normalized=path.posix.normalize('/'+pathname);
  if(normalized.toLowerCase().split('/').includes('task-cards'))return res.status(404).json({message:'File unavailable'});
  next();
 }catch{return res.status(400).json({message:'Invalid file request'});}
}
module.exports={getTaskCard,taskCardPath,publicUploadBoundary};
