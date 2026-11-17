'use strict';
const {Router}=require('express');
function createRouter({service,auth,origins,staffGuard=(req,res)=>res.sendStatus(403)}){
 const router=Router();
 router.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
  if(!['GET','HEAD'].includes(req.method)&&(!origins.includes(req.headers.origin)||!req.is('application/json')))
   return res.status(403).json({message:'Authenticated JSON requests from the UniClips website are required'});
  next();
 });
 router.use(auth); // Bearer only; no ambient cookie authentication.
 const handle=work=>async(req,res)=>{
  try{
   const s=service();
   if(!s){
    if(req.method==='GET'&&req.path==='/status')return res.json({enabled:false});
    return res.status(503).json({code:'BANK_FEATURE_UNAVAILABLE',message:'Bank details are not enabled yet. Earnings remain held.'});
   }
   res.json(await work(s,req));
  }catch(e){
   const status=Number.isInteger(e.status)?e.status:503,known=e.code?.startsWith('BANK_');
   res.status(status).json({code:known?e.code:'BANK_SERVICE_UNAVAILABLE',message:known?e.message:'Payout bank services are unavailable. Your existing account and earnings are unchanged.'});
  }
 };
 router.get('/status',handle((s,r)=>s.status(r.user)));
 router.get('/banks',handle((s,r)=>s.banks(r.user)));
 router.post('/reauthenticate',(req,res,next)=>req.body?.purpose==='reconcile'?staffGuard(req,res,next):next(),handle((s,r)=>s.reauthenticate(r.user,r.body)));
 router.post('/resolve',handle((s,r)=>s.resolve(r.user,r.body)));
 router.post('/confirm',handle((s,r)=>s.confirm(r.user,r.body)));
 // Initial-setup incident recovery only, not a bank-account change workflow.
 router.use('/admin',staffGuard);
 router.get('/admin/operations',handle((s,r)=>s.operations(r.user)));
 router.post('/admin/operations/:id/reconcile',handle((s,r)=>s.reconcile(r.user,r.params.id,r.body)));
 return router;
}
function productionRouter(){
 let runtime,busy=false;
 const env=process.env;
 const origins=(env.ALLOWED_ORIGINS||env.FRONTEND_URL||'https://myuniclips.com').split(',').map(v=>v.trim());
 const service=()=>{
  if(env.PAYSTACK_NG_BANK_DETAILS!=='enabled')return null;
  if(!runtime){
   runtime=require('../services/scholarBank/runtime').createRuntime({pool:require('../config/db').pool,env});
   const timer=setInterval(async()=>{
    if(busy)return;busy=true;
    try{await runtime.maintenance();}catch{/* Never log bank payloads; operations exposes delivery incidents. */}
    finally{busy=false;}
   },30000);
   timer.unref();
  }
  return runtime;
 };
 // Start recovery/erasure after process restart even before a Scholar visits.
 // Invalid optional configuration fails this feature closed, not other routes.
 if(env.PAYSTACK_NG_BANK_DETAILS==='enabled')setImmediate(()=>{try{service();}catch{}});
 return createRouter({service,auth:require('../middleware/auth').authMiddleware,origins,staffGuard:require('../middleware/ipWhitelist').adminIPWhitelist});
}
module.exports={createRouter,productionRouter};
