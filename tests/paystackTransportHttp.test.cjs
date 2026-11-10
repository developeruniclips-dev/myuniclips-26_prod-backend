'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),express=require('express');
const {fixture,signature,response}=require('./fixtures/paystackTransport.cjs');
function load(relative,overrides){const file=path.resolve(__dirname,'../src',relative),module={exports:{}},real=createRequire(file);vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:n=>overrides[n]??real(n),process:{env:{}},Buffer,console});return module.exports;}
test('mounted authenticated checkout/verification ignores buyer hints; raw Paystack endpoint preserves Stripe raw bytes',async()=>{
 const f=fixture();let stripe=0,country='NG';const body={subjectId:10,scholarId:20,contextVersion:'fixture',idempotencyKey:f.input.idempotencyKey};
 const routing={...require('../src/services/coursePayments/routing'),offering:async()=>({subjectId:10,scholarId:20,payment:{provider:country==='NG'?'paystack':'stripe',checkoutEnabled:country==='FI',contextVersion:'fixture',unavailableCode:country==='NG'?'PAYSTACK_CHECKOUT_DISABLED':null}})};
 const controller=load('controller/coursePaymentController.js',{'../config/db':{pool:{}},'../services/coursePayments/routing':routing,'../services/paystackNigeria/runtime':{paymentRuntime:()=>f.api},'../utils/safeLogging':{logError(){}},'../services/paymentRelease':{paymentRuntime:()=>({payments:{createOrder:async()=>{stripe++;return {provider:'stripe',url:'https://checkout.stripe.com/fixture'};}}})}});
 const router=load('routes/coursePaymentRoutes.js',{'../controller/coursePaymentController':controller,'../middleware/auth':{authMiddleware(req,res,next){if(!req.headers.authorization)return res.sendStatus(401);req.user={id:req.headers.authorization==='other'?2:1,roles:['Learner']};next();}}});
 const hook=load('controller/paystackWebhookController.js',{'../services/paystackNigeria/runtime':{paymentRuntime:()=>f.api}}).paystackWebhook;
 const app=express();let stripeRaw;app.post('/stripe',express.raw({type:'application/json'}),(req,res)=>{stripeRaw=req.body;res.sendStatus(200);});app.post('/paystack',express.raw({type:'application/json',limit:'256kb'}),hook);app.use(express.json());app.use('/course-payments',router);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const post=(route,data,auth='owner',headers={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:auth}:{}),...headers},body:typeof data==='string'?data:JSON.stringify(data)});
 try{
  assert.equal((await post('/course-payments/checkout',body,null)).status,401);assert.equal(f.calls.length,0);
  assert.equal((await post('/course-payments/checkout',{...body,provider:'stripe'})).status,400);assert.equal(f.calls.length,0);
  const init=await post('/course-payments/checkout',body);assert.equal(init.status,200);const o=await init.json();assert.equal(f.calls.length,1);
  assert.equal((await post('/course-payments/verify',{orderId:o.orderId},'other')).status,503);assert.equal(f.store.state().purchases.length,0);
  assert.equal((await post('/course-payments/verify',{orderId:o.orderId,amount:1})).status,400);
  const r=await post('/course-payments/verify',{orderId:o.orderId});assert.equal(r.status,200);assert.equal((await r.json()).success,true);assert.equal(f.store.state().purchases[0].buyerId,1);
  country='FI';assert.equal((await post('/course-payments/checkout',body)).status,200);assert.equal(stripe,1);
  const raw='{ "unchanged" : 1 }';await post('/stripe',raw,null);assert.equal(stripeRaw.toString(),raw);
  const event=JSON.stringify({event:'charge.success',data:response(f.store.state().orders[0]).data});assert.equal((await post('/paystack',event,null)).status,401);
  assert.equal((await post('/paystack',event,null,signature(Buffer.from(event),f.configInput))).status,200);assert.equal(f.store.state().purchases.length,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
 const index=fs.readFileSync(path.resolve(__dirname,'../src/index.js'),'utf8');assert(index.indexOf("app.post('/api/paystack/webhook'")<index.indexOf("app.use(express.json())"));assert.match(index,/\["\/webhook", "\/api\/purchases\/webhook"\]/);
});
