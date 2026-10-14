'use strict';
const fs=require('node:fs'),path=require('node:path');
// Dedicated v2 namespace: never truncate or rotate inherited access.log, audit or receipt files.
function createBoundedAccessLog(folder,{maxBytes=5*1024*1024,backups=3,queueBytes=64*1024,lineBytes=2048,maxAgeMs=7*86400000,now=Date.now,io=fs.promises,onFault=()=>console.error('Access log storage unavailable'),schedule=(fn,ms)=>setInterval(fn,ms)}={}){
 let pending=[],queued=0,running=null,closed=false,dropped=0,fault=false,size=0,ready=false,day=0;
 const file=path.join(folder,'access-v2.log'),dayMs=86400000;
 async function safe(p){try{const s=await io.lstat(p);if(!s.isFile()||s.isSymbolicLink())throw Error('Invalid log file');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function expire(){
  for(let n=0;n<=backups;n++){const p=file+(n?'.'+n:''),s=await safe(p);if(s&&s.mtimeMs<now()-maxAgeMs){await io.unlink(p);if(n===0){size=0;day=Math.floor(now()/dayMs);}}}
 }
 async function prepare(){
  await io.mkdir(folder,{recursive:true,mode:0o700});const s=await io.lstat(folder);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Invalid log directory');
  for(let n=0;n<=backups;n++){const m=await safe(file+(n?'.'+n:''));if(m?.size>maxBytes)throw Error('Existing v2 logs require reviewed recovery');}
  const current=await safe(file);size=current?.size||0;day=Math.floor((current?.mtimeMs??now())/dayMs);ready=true;
 }
 async function rotate(){
  await safe(file+'.'+backups);await io.unlink(file+'.'+backups).catch(e=>{if(e.code!=='ENOENT')throw e;});
  for(let n=backups-1;n>=1;n--){if(await safe(file+'.'+n))await io.rename(file+'.'+n,file+'.'+(n+1));}
  if(await safe(file))await io.rename(file,file+'.1');size=0;day=Math.floor(now()/dayMs);
 }
 async function drain(){
  try{
   if(!ready)await prepare();await expire();
   while(pending.length){const line=pending.shift();queued-=line.length;if(size&&(size+line.length>maxBytes||Math.floor(now()/dayMs)!==day))await rotate();await io.appendFile(file,line,{mode:0o600,flag:'a'});size+=line.length;day=Math.floor(now()/dayMs);}
  }catch{dropped+=pending.length;pending=[];queued=0;if(!fault){fault=true;onFault();}}
 }
 function pump(){if(!running&&!fault){running=drain().finally(()=>{running=null;if(pending.length)pump();});}}
 // Expire idle segments as well; the timer cannot keep the serving process alive.
 const timer=schedule(()=>{if(!closed)pump();},3600000);timer?.unref?.();
 return{
  write(chunk){if(closed||fault){dropped++;return false;}const bytes=Buffer.from(String(chunk).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g,'?'));const line=bytes.length<=lineBytes?bytes:Buffer.concat([bytes.subarray(0,lineBytes-15),Buffer.from(' [truncated]\n')]);if(line.length>maxBytes||queued+line.length>queueBytes){dropped++;return false;}queued+=line.length;pending.push(line);pump();return true;},
  async end(){closed=true;clearInterval(timer);while(running)await running;},
  status:()=>({queuedBytes:queued,dropped,unavailable:fault,closed})
 };
}
module.exports={createBoundedAccessLog};
