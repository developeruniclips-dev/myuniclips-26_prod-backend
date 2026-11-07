'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),express=require('express');
function load(relative,overrides){const file=path.resolve(__dirname,'../src',relative),module={exports:{}},real=createRequire(file);vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:n=>overrides[n]??real(n),process:{env:{}},Buffer,console});return module.exports;}
test('mounted neutral API authenticates ownership/roles and blocks Nigerian initiation before Stripe composition',async()=>{
 let country='NG',privateFailure=false,queries=0,initiations=0,owned=[];
 const row={id:123,scholar_id:7,university_id:55,country_id:9,university_country_code:'NG',country_occurrences:1,bundle_price:'7.00',application_approved:1,profile_approved:1,workflow_state:'PUBLISHED',has_content:1};
 const pool={query:async()=>{queries++;if(privateFailure)throw Object.assign(Error('PRIVATE_SQL_PROVIDER_TOKEN'),{sql:'PRIVATE'});return [[{...row,university_country_code:country}]];}};
 const actual=require('../src/services/coursePayments/routing'),routing={...actual,offering:(db,s,c)=>actual.offering(db,s,c,{stripeReady:true}),requireStripeOffering:(db,b)=>actual.requireStripeOffering(db,b,{stripeReady:true})};
 const controller=load('controller/coursePaymentController.js',{'../config/db':{pool},'../services/coursePayments/routing':routing,'../services/coursePayments/reporting':{history:async(p,id)=>{owned.push(id);return [{buyer_user_id:id}];},earnings:async()=>({breakdowns:[]})},'../services/payments/earningsService':{scholarEarnings:async()=>({summary:{currency:'EUR'}})},'../utils/safeLogging':{logError(){}},'../services/paymentRelease':{paymentRuntime(){initiations++;return {payments:{createOrder:async()=>({url:'https://checkout.stripe.com/fixture'})}};}}});
 const router=load('routes/coursePaymentRoutes.js',{'../controller/coursePaymentController':controller,'../middleware/auth':{authMiddleware(req,res,next){if(!req.headers.authorization)return res.sendStatus(401);req.user={id:11,roles:[req.headers.authorization==='Scholar'?'Scholar':'Learner']};next();}}});
 const app=express();app.use(express.json());app.use('/course-payments',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/course-payments';
 try{
  assert.equal((await fetch(base+'/history?buyerId=99')).status,401);assert.equal(queries,0);
  assert.equal((await fetch(base+'/earnings',{headers:{authorization:'Learner'}})).status,403);
  const h=await fetch(base+'/history?buyerId=99',{headers:{authorization:'Learner'}});assert.equal(h.status,200);assert.deepEqual(owned,[11]);
  const body={subjectId:123,scholarId:7},request=b=>fetch(base+'/checkout',{method:'POST',headers:{authorization:'Learner','content-type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await request(body)).status,409);assert.equal(initiations,0);
  assert.equal((await request({...body,provider:'stripe'})).status,400);assert.equal(initiations,0);
  country='FI';assert.equal((await request(body)).status,200);assert.equal(initiations,1);
  privateFailure=true;const bad=await fetch(base+'/offering?subjectId=123&scholarId=7');assert.equal(bad.status,503);assert.doesNotMatch(await bad.text(),/PRIVATE/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
