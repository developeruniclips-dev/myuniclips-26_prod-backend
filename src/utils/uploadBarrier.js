'use strict';
const crypto=require('node:crypto');
const categories=Object.freeze(['image','taskCard','video']);
const ticketKey=Symbol('uploadLifecycleTicket');
function createUploadBarrier({generation=crypto.randomUUID(),commit=process.env.RENDER_GIT_COMMIT||'local'}={}) {
 let paused=true,shuttingDown=false,cleanupFailures=0,invariantFailures=0;
 const active=Object.fromEntries(categories.map(k=>[k,0]));
 function status(){return {paused,shuttingDown,generation,commit,activeTotal:Object.values(active).reduce((a,b)=>a+b,0),activeHandlers:{...active},observedCleanupFailures:cleanupFailures,lifecycleInvariantFailures:invariantFailures};}
 function pause(){paused=true;return status();}
 function shutdown(){shuttingDown=true;paused=true;return status();}
 function resume({acknowledgeCleanupFailures=false}={}){if(shuttingDown)throw Error('SHUTTING_DOWN');if(status().activeTotal!==0)throw Error('ACTIVE_UPLOADS');if(invariantFailures)throw Error('LIFECYCLE_UNKNOWN');if(cleanupFailures&&!acknowledgeCleanupFailures)throw Error('CLEANUP_RECONCILIATION_REQUIRED');paused=false;return status();}
 function begin(category){
  if(!categories.includes(category))throw Error('CATEGORY_INVALID');
  if(paused)return null;
  active[category]++;
  let pending=0,responseEnded=false,released=false;
  function releaseIfComplete(){if(!released&&responseEnded&&pending===0){released=true;active[category]--;}}
  return {
   category,
   hold(){if(released){paused=true;invariantFailures++;throw Error('LIFECYCLE_ALREADY_RELEASED');}pending++;let done=false;return()=>{if(!done){done=true;pending--;releaseIfComplete();}};},
   responseEnded(){responseEnded=true;releaseIfComplete();},
   cleanupFailed(){cleanupFailures++;},
   get released(){return released;}
  };
 }
 function ingress(category,{multipartOnly=false}={}){
  return (req,res,next)=>{
   if(multipartOnly&&!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type']||''))return next();
   if(req[ticketKey])return next();
   const ticket=begin(category);
   if(!ticket)return res.status(503).json({message:'Uploads are temporarily paused. Please try again later.',code:'UPLOADS_PAUSED'});
   req[ticketKey]=ticket;
   // The synchronous route dispatch itself is held until downstream middleware returns.
   const done=ticket.hold();
   res.once('finish',()=>ticket.responseEnded());res.once('close',()=>ticket.responseEnded());
   try{return next();}finally{done();}
  };
 }
 function wrap(fn){
  return function trackedMiddleware(req,res,next){
   const ticket=req[ticketKey];if(!ticket)return fn(req,res,next);
   const done=ticket.hold();
   let result;
   try{result=fn(req,res,next);}catch(e){done();return next(e);}
   // Retain the lease for async authorization/controller finally blocks even after disconnect.
   return Promise.resolve(result).then(()=>done(),e=>{done();next(e);});
  };
 }
 return {status,pause,shutdown,resume,begin,ingress,wrap};
}
const shared=createUploadBarrier();
module.exports={createUploadBarrier,shared,ticketKey,categories};
