'use strict';
// Public still images only. Provider references, credentials and playback URLs
// never leave this service. No provider mutation or persistent storage.
const https=require('node:https');
const {readQuery,createReadBudget}=require('../utils/readCapacity');
const {sharedVimeoPrivacy,providerId}=require('./vimeoPrivacy');
const MAX_BYTES=1024*1024,MAX_CACHE_BYTES=8*MAX_BYTES;
const unavailable=()=>Object.assign(new Error('Course cover unavailable'),{code:'COURSE_COVER_UNAVAILABLE'});
function positive(value){return typeof value==='string'&&/^[1-9]\d{0,9}$/.test(value)&&Number(value)<=2147483647;}
function imageUrl(value){
 if(typeof value!=='string'||value.length>2048)throw unavailable();
 let url;try{url=new URL(value);}catch{throw unavailable();}
 if(url.protocol!=='https:'||url.hostname!=='i.vimeocdn.com'||url.port||url.username||url.password||url.hash||!/^\/video\/[A-Za-z0-9_.-]+$/.test(url.pathname))throw unavailable();
 return url;
}
function imageType(bytes){
 if(bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=12&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp';
 throw unavailable();
}
function downloadImage(value,{request=https.request,timeoutMs=5000}={}){
 const url=imageUrl(value);
 return new Promise((resolve,reject)=>{
  let req,res,timer,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error){res?.destroy();req?.destroy();reject(unavailable());}else resolve(value);};
  timer=setTimeout(()=>finish(true),timeoutMs);
  try{
   req=request(url,{method:'GET',rejectUnauthorized:true,headers:{Accept:'image/jpeg, image/png, image/webp','Accept-Encoding':'identity'}},response=>{
    res=response;res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
    const type=res.headers['content-type']?.split(';')[0].trim().toLowerCase(),length=res.headers['content-length'];
    if(res.statusCode!==200||!['image/jpeg','image/png','image/webp'].includes(type)||(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')||(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES))){finish(true);return;}
    const chunks=[];let size=0;
    res.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>MAX_BYTES){finish(true);return;}chunks.push(chunk);});
    res.on('end',()=>{if(done)return;try{const bytes=Buffer.concat(chunks);if(imageType(bytes)!==type||(length!==undefined&&Number(length)!==size))throw unavailable();finish(null,{bytes,type});}catch{finish(true);}});
   });
   req.on('error',()=>finish(true));req.end();
  }catch{finish(true);}
 });
}
function pictures(client,reference,timeoutMs=5000){
 const uri='/videos/'+providerId(reference);
 return new Promise((resolve,reject)=>{
  let done=false;const finish=(error,body,status)=>{if(done)return;done=true;clearTimeout(timer);
   try{
    if(error||status!==200||body?.uri!==uri||!Array.isArray(body?.pictures?.sizes)||body.pictures.sizes.length>30)throw unavailable();
    const sizes=body.pictures.sizes.filter(s=>Number.isInteger(s.width)&&s.width>=200&&s.width<=1280&&Number.isInteger(s.height)&&s.height>0&&s.height<=1280).sort((a,b)=>Math.abs(a.width-640)-Math.abs(b.width-640));
    if(!sizes.length)throw unavailable();resolve(imageUrl(sizes[0].link).href);
   }catch{reject(unavailable());}
  };
  const timer=setTimeout(()=>finish(true),timeoutMs);
  try{client.request({method:'GET',path:uri+'?fields=uri,pictures.sizes.width,pictures.sizes.height,pictures.sizes.link'},finish);}catch{finish(true);}
 });
}
const PUBLIC_FIRST=`SELECT v.id,v.video_url FROM scholar_subjects ss
 JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id AND sp.approved=1
 JOIN course_workflows cw ON cw.offering_id=ss.id AND cw.state='PUBLISHED'
 JOIN videos v ON v.subject_id=ss.subject_id AND v.scholar_user_id=ss.scholar_user_id
 WHERE ss.subject_id=? AND ss.scholar_user_id=? AND ss.approved=1
 AND (SELECT COUNT(*) FROM scholar_subjects context WHERE context.subject_id=ss.subject_id AND context.scholar_user_id=ss.scholar_user_id)=1
 AND NOT EXISTS (SELECT 1 FROM videos unapproved WHERE unapproved.subject_id=ss.subject_id AND unapproved.scholar_user_id=ss.scholar_user_id AND (unapproved.approved IS NULL OR unapproved.approved<>1))
 AND NOT EXISTS (SELECT 1 FROM videos invalid_order WHERE invalid_order.subject_id=ss.subject_id AND invalid_order.scholar_user_id=ss.scholar_user_id AND (invalid_order.sequence_index IS NULL OR invalid_order.sequence_index<1))
 AND NOT EXISTS (SELECT duplicate_order.sequence_index FROM videos duplicate_order WHERE duplicate_order.subject_id=ss.subject_id AND duplicate_order.scholar_user_id=ss.scholar_user_id GROUP BY duplicate_order.sequence_index HAVING COUNT(*)>1)
 ORDER BY v.sequence_index,v.id LIMIT 1`;
function createCourseCovers({pool,client,privacy=sharedVimeoPrivacy(client),download=downloadImage,now=Date.now}){
 const reads=createReadBudget({global:8}),cold=createReadBudget({global:4}),cache=new Map(),pending=new Map();let bytes=0,windowStart=now(),requests=0;
 function remove(key){const old=cache.get(key);if(old){bytes-=old.image?.bytes.length||0;cache.delete(key);}}
 function remember(key,image,ttl){remove(key);for(const [k,v]of cache)if(v.expires<=now())remove(k);while(cache.size>=32||bytes+(image?.bytes.length||0)>MAX_CACHE_BYTES)remove(cache.keys().next().value);cache.set(key,{image,expires:now()+ttl});bytes+=image?.bytes.length||0;}
 async function load(reference){
  if(now()-windowStart>=60000){windowStart=now();requests=0;}if(requests>=60)throw unavailable();requests++;
  const state=await privacy.verify(reference);if(state.state!=='READY'||state.policyVerified!==true)throw unavailable();
  return download(await pictures(client,reference));
 }
 return async function cover(req,res){
  res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  const {subjectId,scholarId}=req.params;
  if(!positive(subjectId)||!positive(scholarId)){res.status(404).end();return;}
  try{
   const image=await reads.run(null,async()=>{
    const [rows]=await readQuery(pool,PUBLIC_FIRST,[Number(subjectId),Number(scholarId)]);
    if(rows.length!==1)throw unavailable();const row=rows[0];
    // Gate every request, including cache hits, on current publication and first lesson.
    const key=subjectId+':'+scholarId+':'+row.id+':'+row.video_url;
    const hit=cache.get(key);if(hit&&hit.expires>now()){if(!hit.image)throw unavailable();return hit.image;}remove(key);
    if(!pending.has(key)){
     const work=cold.run(null,()=>load(row.video_url)).then(image=>{remember(key,image,300000);return image;},()=>{remember(key,null,15000);throw unavailable();}).finally(()=>pending.delete(key));pending.set(key,work);
    }
    return pending.get(key);
   });
   res.type(image.type).send(image.bytes);
  }catch{res.status(404).end();}
 };
}
module.exports={createCourseCovers,downloadImage,imageUrl,imageType,MAX_BYTES};
