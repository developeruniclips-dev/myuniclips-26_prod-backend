'use strict';
// Optional production composition. Absent PAYSTACK_NG_MODE=live this is inert.
const crypto=require('node:crypto'),L=require('./liveConfiguration');
const safeCodes=new Set(('PAYSTACK_LIVE_ISOLATION_REQUIRED PAYSTACK_ENVIRONMENT_CONFLICT PAYSTACK_CONTROL_INVALID PAYSTACK_LIVE_DATABASE_REQUIRED PAYSTACK_LIVE_ORIGIN_REQUIRED PAYSTACK_LIVE_OWNER_KEY_REQUIRED PAYSTACK_LIVE_DATABASE_IDENTITY_MISMATCH PAYSTACK_LIVE_DATABASE_GRANTS_UNSAFE PAYSTACK_LIVE_SANDBOX_DATABASE_FORBIDDEN PAYSTACK_LIVE_SCHEMA_REQUIRED SCHEMA_VERIFICATION_REQUIRED DB_SSL_INVALID DB_TLS_REQUIRED DB_TLS_HOSTNAME_REQUIRED DB_TLS_CA_REQUIRED DB_TLS_CA_UNREADABLE DB_TLS_CA_INVALID DB_TLS_NOT_NEGOTIATED ER_ACCESS_DENIED_ERROR ER_NO_SUCH_TABLE').split(' '));
const safeCode=e=>safeCodes.has(e?.code)?e.code:'PAYSTACK_LIVE_NOT_READY';
function createControl({env,pool,now=Date.now,collectMetadata=require('./liveReadiness').metadata,wrapPool=require('./liveReadiness').guardedPool,sourceDigest=require('../../sandbox/isolation').sourceDigest}={}){
 L.settings(env);
 const publicKey=L.ownerKey(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM,env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256);
 if(!/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE_ID||'')||!/^srv-[A-Za-z0-9_-]+$/.test(env.RENDER_INSTANCE_ID||''))L.deny('PAYSTACK_LIVE_ISOLATION_REQUIRED');
 const identity=Object.freeze({service:env.RENDER_SERVICE_ID,generation:crypto.randomUUID(),source:sourceDigest(),instance:env.RENDER_INSTANCE_ID});
 const guarded=wrapPool({pool,env});let receiver;
 return {
  async initialize(){if(receiver)L.deny('PAYSTACK_LIVE_ISOLATION_REQUIRED');const metadata=await collectMetadata(guarded);receiver=require('./liveApprovals').createReceiver({env,pool:guarded,identity,publicKey,metadata,now});},
  challenge(){if(!receiver)L.deny('PAYSTACK_LIVE_APPROVAL_REQUIRED');return receiver.status();},
  install(envelope){if(!receiver)L.deny('PAYSTACK_LIVE_APPROVAL_REQUIRED');return receiver.install(envelope);},
  runtime(){if(!receiver)L.deny('PAYSTACK_LIVE_APPROVAL_REQUIRED');return receiver.runtime();}
 };
}
function mount(app,{env=process.env,pool}={}){
 if(env.PAYSTACK_NG_MODE!=='live')return {initialize:async()=>undefined,runtime:()=>({enabled:false})};
 // Defer validation to the awaited startup path so failures use safe diagnostics.
 let control;
 const {authMiddleware}=require('../../middleware/auth'),{authorizeRoles}=require('../../middleware/roles');
 const limit=require('express-rate-limit').rateLimit({windowMs:60000,limit:10,standardHeaders:true,legacyHeaders:false});
 const handle=work=>(req,res)=>{try{res.json(work(req));}catch{res.status(503).json({code:'PAYSTACK_LIVE_APPROVAL_REFUSED'});}};
 const ready=()=>{if(!control)L.deny('PAYSTACK_LIVE_APPROVAL_REQUIRED');return control;};
 app.get('/api/paystack/live/challenge',limit,authMiddleware,authorizeRoles('SuperAdmin'),handle(()=>ready().challenge()));
 app.post('/api/paystack/live/approvals',limit,authMiddleware,authorizeRoles('SuperAdmin'),handle(req=>ready().install(req.body)));
 return {async initialize(){if(control)L.deny('PAYSTACK_LIVE_ISOLATION_REQUIRED');const candidate=createControl({env,pool});await candidate.initialize();control=candidate;},runtime(){return ready().runtime();}};
}
module.exports={mount,createControl,safeCode};
