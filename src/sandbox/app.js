'use strict';
const {fail}=require('./isolation');
const {digest}=require('../services/paystackNigeria/transportConfig');
// Intentionally does not import the production router, Stripe, mail, Vimeo,
// uploads, registrations or administration. Existing session checks are reused.
function createSandboxApp({pool,receiver,publicKey,origin}={}){
 const express=require('express'),app=express();
 app.disable('x-powered-by');app.set('trust proxy',1);
 app.use(require('helmet')());app.use(require('cors')({origin,credentials:true}));
 app.use(require('express-rate-limit').rateLimit({windowMs:60000,limit:30,standardHeaders:true,legacyHeaders:false}));
 const wrap=f=>async(req,res,next)=>{try{await f(req,res);}catch(e){next(e);}};
 app.get('/health',(_q,r)=>r.json({status:'ok',sandbox:true}));
 app.get('/sandbox/challenge',(_q,r)=>{r.set('Cache-Control','no-store');r.json(receiver.status());});
 app.post('/sandbox/approvals',express.json({limit:'96kb'}),wrap(async(q,r)=>r.json(receiver.install(q.body))));
 let importing=false;
 app.post('/sandbox/zero-history',express.json({limit:'96kb'}),wrap(async(q,r)=>{
  if(importing)fail('SANDBOX_REVIEW_BUSY');importing=true;
  try{
   if(Object.keys(q.body||{}).join(',')!=='authorization')fail('SANDBOX_SINGLE_OWNER_ENVELOPE_REQUIRED');
   const audit=receiver.zeroAuthorization(q.body.authorization);
   const [[manifest]]=await pool.query('SELECT * FROM sandbox_manifest WHERE singleton=1');
   if(!manifest||audit.seedDigest!==manifest.seed_digest||manifest.kind!=='synthetic-paystack-test'||
      audit.subjectId!==manifest.subject_id||audit.scholarId!==manifest.scholar_id||audit.sourceRevision!==manifest.seed_digest||
      !Array.isArray(audit.facts)||audit.facts.length||audit.reviewVersion!==1)fail('SANDBOX_ZERO_REVIEW_REQUIRED');
   // The existing importer locks the subject; its additional sandbox validator
   // checks empty financial state before writing the audit in one transaction. Nonzero import is
   // never accepted by this sandbox operator surface.
   const result=await require('../services/coursePayments/historicalResolver').createAuditImporter({pool,publicKey,verifyProvenance:async()=>false,validateScope:require('./ownerPolicy').requireEmptyFinancialState})(q.body.authorization);
   r.json({...result,approvalMode:audit.approvalMode,evidenceDigest:audit.evidenceDigest,approvalDigest:digest(JSON.stringify(q.body.authorization))});
  }finally{importing=false;}
 }));
 app.post('/api/paystack/webhook',express.raw({type:'application/json',limit:'256kb'}),require('../controller/paystackWebhookController').paystackWebhook);
 app.use(express.json({limit:'16kb'}));
 const lifecycle=require('../services/authLifecycle'),{authMiddleware}=require('../middleware/auth');
 const loginLimit=require('express-rate-limit').rateLimit({windowMs:900000,limit:5,standardHeaders:true,legacyHeaders:false});
 app.post('/api/auth/login',loginLimit,wrap(async(q,r)=>{
  const security=require('../utils/authSecurity'),email=await security.normalizeEmail(q.body.email);
  if(!email||!security.passwordInput(q.body.password))return r.status(401).json({message:'Invalid credentials'});
  const result=await lifecycle.passwordLogin(email,q.body.password);r.status(result.status).json(result.body);
 }));
 app.post('/api/auth/refresh',wrap(async(q,r)=>{const v=await lifecycle.refresh(q.body.refreshToken);r.status(v.status).json(v.body);}));
 app.post('/api/auth/logout',authMiddleware,wrap(async(q,r)=>{const v=await lifecycle.lockedSession(q.user,async(db,u)=>{await lifecycle.revoke(db,u);return{status:200,body:{message:'Signed out'}};});r.status(v.status).json(v.body);}));
 const routing=require('../services/coursePayments/routing');
 const ngOnly=async q=>{
  const route=decodeURIComponent(q.path);
  if(route.startsWith('/status/')&&!/^\/status\/paystack:[A-Za-z0-9_-]{1,100}\/?$/.test(route))fail('SANDBOX_STRIPE_FORBIDDEN');
  const subject=q.body?.subjectId??q.query.subjectId,scholar=q.body?.scholarId??q.query.scholarId;
  if(subject!=null||scholar!=null){const o=await routing.offering(pool,subject,scholar,{stripeReady:false});if(o.payment.provider!=='paystack')fail('SANDBOX_STRIPE_FORBIDDEN');}
 };
 // Scope every exposed payment route. No Stripe controller can be reached.
 app.use('/api/course-payments',async(q,r,next)=>{try{await ngOnly(q);next();}catch(e){next(e);}},require('../routes/coursePaymentRoutes'));
 app.get('/api/videos/all-videos',wrap(async(_q,r)=>{
  const [rows]=await pool.query(`SELECT v.*,s.name AS subject_name,s.university_id,s.degree_programmes AS degree_programme,s.bundle_price,u.fname AS scholar_fname,u.lname AS scholar_lname,p.university AS scholar_university,p.degree AS scholar_degree FROM videos v JOIN subjects s ON s.id=v.subject_id JOIN users u ON u.id=v.scholar_user_id JOIN scholar_profile p ON p.user_id=u.id WHERE v.approved=1 ORDER BY v.sequence_index LIMIT 3`);
  r.json({videos:await routing.attachPayments(pool,rows,{stripeReady:false})});
 }));
 const content=require('../services/contentAuthorization').createContentAuthorization(pool);
 app.get('/api/videos/courses/:subject/:scholar',authMiddleware,wrap(async(q,r)=>r.json(await content.course(q.user,q.params.subject,q.params.scholar))));
 app.get('/api/purchases/subject/check',authMiddleware,wrap(async(q,r)=>{
  const c=await content.course(q.user,q.query.subjectId,q.query.scholarId);r.json({hasPurchased:c.hasPurchased,hasAccess:c.hasPurchased});
 }));
 app.get('/api/library/check',authMiddleware,(_q,r)=>r.json({inLibrary:false}));
 app.get('/api/library/video-progress',authMiddleware,(_q,r)=>r.json({progress:0}));
 app.use((_q,r)=>r.status(404).json({message:'Not available in the payment sandbox'}));
 app.use((e,_q,r,_n)=>r.status(e.status||503).json({message:'Sandbox operation unavailable',code:e.code||'SANDBOX_UNAVAILABLE'}));
 return app;
}
module.exports={createSandboxApp};
