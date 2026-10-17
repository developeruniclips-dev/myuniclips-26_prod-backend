'use strict';
// Node 22 loopback tests only. All database/provider boundaries are doubles.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),zlib=require('node:zlib');
const {createRequire}=require('node:module');
const express=require('express'),morgan=require('morgan'),jwt=require('jsonwebtoken');
const expressRequire=createRequire(require.resolve('express/package.json'));
const parserRequire=createRequire(expressRequire.resolve('body-parser/package.json'));
const stripeRequire=createRequire(require.resolve('stripe'));
process.env.JWT_SECRET='P2H_SYNTHETIC_SESSION_SECRET';
process.env.STRIPE_WEBHOOK_SECRET='whsec_P2H_SYNTHETIC_ONLY';
const logs=[];
function load(file,overrides={}){
 const filename=path.resolve(__dirname,'../src',file),real=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,Buffer,URL,process,console:{log(){},warn(){},error(){}},require(name){
  if(Object.hasOwn(overrides,name))return overrides[name];
  if(name.includes('safeLogging'))return{...require('../src/utils/safeLogging'),logError:(event)=>logs.push(event)};
  return real(name);
 }});return module.exports;
}
const security=require('../src/utils/authSecurity');
const user={id:7,email:'synthetic@example.invalid',name:'Synthetic',password:'SYNTHETIC_HASH',refresh_token:'sha256:'+'a'.repeat(64),refresh_valid:1,idle_seconds:0,two_factor_enabled:0};
let missing=false,dbFailure=false,currentRole='Admin',idle=0,revoked=false,handled=[];
const pool={async query(sql){
 if(dbFailure)throw Error('SYNTHETIC_PRIVATE_DATABASE_ERROR');
 if(sql.startsWith('SELECT r.name'))return [[{name:currentRole}]];
 if(sql.startsWith('SELECT id,password'))return [missing?[]:[{...user,idle_seconds:idle,refresh_token:revoked?null:user.refresh_token}]];
 if(sql.startsWith('UPDATE users'))return [{affectedRows:1}];
 throw Error('Unexpected double query');
}};
const session=load('middleware/sessionTimeout.js',{'../config/db':{pool}});
const {authMiddleware}=load('middleware/auth.js',{'./sessionTimeout':session});
const {authorizeRoles}=load('middleware/roles.js',{'../config/db':{pool}});
const stripe=new (require('stripe'))('sk_test_P2H_SYNTHETIC_ONLY');
const {stripeWebhook}=load('controller/stripeWebhookController.js',{'../config/stripe':stripe,'../services/paymentRelease':{paymentRuntime:()=>({handleEvent:async event=>{handled.push(event.id);return{};}})}});
const {errorHandler}=load('middleware/publicErrors.js');
const {requestLogger}=require('../src/utils/safeLogging');
const {pageInput}=require('../src/utils/readCapacity');
const {createUploadBarrier}=require('../src/utils/uploadBarrier');
const barrier=createUploadBarrier({commit:'P2H_SYNTHETIC'});
const uploadSecurity=require('../src/middleware/uploadSecurity');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-p2h-'));
const imageRoot=path.join(temp,'image');fs.mkdirSync(imageRoot);
const app=express(),access=[];
app.use(requestLogger(morgan,{production:true,stream:{write:line=>access.push(line)}}));
// Preserve raw-body order and both aliases, before general JSON middleware.
app.post(['/webhook','/api/purchases/webhook'],express.raw({type:'application/json'}),stripeWebhook);
app.use('/api/videos/my/:id',express.json({limit:'256kb'}));app.use(express.json());
app.post('/json',(req,res)=>res.json({length:req.body.value?.length||0}));
app.post('/api/videos/my/:id',(req,res)=>res.json({id:req.params.id,length:req.body.value?.length||0}));
app.post('/form',express.urlencoded({extended:true,limit:'16kb',parameterLimit:30}),(req,res)=>res.json(req.body));
app.get('/records/limits',(req,res)=>res.json({literal:true}));
app.get('/records/:id',(req,res)=>res.json({id:req.params.id}));
const nested=express.Router({mergeParams:true});nested.get('/:item',(req,res)=>res.json(req.params));app.use('/parents/:parent',nested);
app.get('/query',(req,res)=>res.json(req.query));
app.get('/page',(req,res,next)=>{try{res.json(pageInput(req.query));}catch(e){next(e);}});
app.get('/protected',authMiddleware,(req,res)=>res.json({id:req.user.id}));
app.get('/admin',authMiddleware,authorizeRoles('Admin'),(req,res)=>res.json({ok:true}));
app.put('/image',barrier.ingress('image',{multipartOnly:true}),barrier.wrap(authMiddleware),barrier.wrap(uploadSecurity.createUpload('image',{root:imageRoot,barrier})),barrier.wrap(async(req,res)=>{
 req.uploadState.processing=true;try{res.json({received:!!req.file});}finally{await req.uploadState.finish();}
}));
app.use(errorHandler);
let server,base;
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(temp.startsWith(os.tmpdir()+path.sep));fs.rmSync(temp,{recursive:true,force:true});});
test.beforeEach(()=>{missing=false;dbFailure=false;currentRole='Admin';idle=0;revoked=false;});
const token=()=>security.signAccess(user,['Admin','Scholar']);
const call=(url,options={})=>fetch(base+url,options);
const signed=(url,bearer=token())=>call(url,{headers:{authorization:'Bearer '+bearer}});
test('actual installed versions and private dependency ancestry match the approved split',()=>{
 for(const [name,version]of Object.entries({express:'4.22.3','proxy-addr':'2.0.8','path-to-regexp':'0.1.13','express-validator':'7.3.2',lodash:'4.18.1',morgan:'1.12.1'}))assert.equal(require(name+'/package.json').version,version);
 assert.equal(expressRequire('body-parser/package.json').version,'1.20.8');
 assert.equal(expressRequire('qs/package.json').version,'6.16.1');assert.equal(parserRequire.resolve('qs'),expressRequire.resolve('qs'));
 assert.equal(stripeRequire('qs/package.json').version,'6.14.2');assert.notEqual(stripeRequire.resolve('qs'),expressRequire.resolve('qs'));
 const qsRequire=createRequire(expressRequire.resolve('qs/package.json')),channelRequire=createRequire(qsRequire.resolve('side-channel/package.json'));
 assert.equal(qsRequire('side-channel/package.json').version,'1.1.1');assert.equal(channelRequire('side-channel-list/package.json').version,'1.0.1');
 assert.equal(require('side-channel-list/package.json').version,'1.0.0');assert.equal(require('side-channel/package.json').version,'1.1.0');
});
test('Express 4 literal precedence, encoded params, nested routers, HEAD, OPTIONS and 404 remain compatible',async()=>{
 assert.deepEqual(await (await call('/records/limits')).json(),{literal:true});
 assert.deepEqual(await (await call('/records/a%20b')).json(),{id:'a b'});
 assert.deepEqual(await (await call('/parents/7/item')).json(),{parent:'7',item:'item'});
 const head=await call('/records/7',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const options=await call('/records/7',{method:'OPTIONS'});assert.equal(options.status,200);assert.match(options.headers.get('allow'),/GET/);
 assert.equal((await call('/not-a-route')).status,404);
});
test('patched query parser preserves repeated/indexed values and bounded application pagination',async()=>{
 const query=Array.from({length:25},(_,i)=>'tag='+i).join('&');
 const body=await (await call('/query?'+query+'&filter[name]=safe')).json();assert.equal(body.tag.length,25);assert.deepEqual(body.filter,{name:'safe'});
 assert.deepEqual(await (await call('/query?a[0]=x&a[1]=y')).json(),{a:['x','y']});
 assert.deepEqual(await (await call('/page?limit=2&before=42')).json(),{limit:2,before:42});
 for(const q of ['limit=1&limit=2','limit[x]=1','limit=101','before=-1'])assert.equal((await call('/page?'+q)).status,400);
});
test('prototype query keys and qs serialization do not pollute objects or invoke inherited isBuffer',async()=>{
 const r=await call('/query?__proto__[p2h]=yes&constructor[prototype][p2h]=yes&safe=ok');assert.equal(r.status,200);assert.equal(({}).p2h,undefined);
 const qs=expressRequire('qs');assert.equal(qs.stringify({a:[null,undefined,'x']},{arrayFormat:'comma',encodeValuesOnly:true}),'a=,,x');
 const inherited=Object.create({constructor:{isBuffer(){throw Error('inherited callback');}}});inherited.safe='ok';assert.equal(qs.stringify(inherited),'safe=ok');
});
test('urlencoded bodies retain nested forms and reject parameter overflow without private errors',async()=>{
 let r=await call('/form',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'profile[name]=Synthetic&tags=a&tags=b'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{profile:{name:'Synthetic'},tags:['a','b']});
 r=await call('/form',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:Array.from({length:31},(_,i)=>'x'+i+'=a').join('&')});assert.equal(r.status,413);assert.doesNotMatch(await r.text(),/stack|SYNTHETIC_PRIVATE|node_modules/);
});
test('JSON limits remain 100 KiB generally and 256 KiB for video metadata, with safe malformed errors',async()=>{
 const send=(route,value)=>call(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({value})});
 assert.equal((await send('/json','a'.repeat(1000))).status,200);
 let r=await send('/json','a'.repeat(110*1024));assert.equal(r.status,413);assert.equal((await r.json()).code,'REQUEST_TOO_LARGE');
 r=await send('/api/videos/my/7','a'.repeat(150*1024));assert.equal(r.status,200);assert.equal((await r.json()).length,150*1024);
 assert.equal((await send('/api/videos/my/7','a'.repeat(257*1024))).status,413);
 r=await call('/json',{method:'POST',headers:{'content-type':'application/json'},body:'{"value":'});assert.equal(r.status,400);assert.deepEqual(await r.json(),{error:'Invalid JSON body',code:'INVALID_JSON'});
});
test('compressed JSON is limited by decoded bytes rather than compressed length',async()=>{
 for(const [n,status]of [[1000,200],[110*1024,413]]){const r=await call('/json',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:zlib.gzipSync(JSON.stringify({value:'a'.repeat(n)}))});assert.equal(r.status,status);}
});
test('real access middleware accepts current bound sessions and denies missing, malformed and wrong-purpose JWTs',async()=>{
 assert.equal((await signed('/protected')).status,200);assert.equal((await call('/protected')).status,401);
 assert.equal((await signed('/protected','invalid')).status,403);
 assert.equal((await signed('/protected',jwt.sign({id:7,purpose:'challenge',session:'a'},process.env.JWT_SECRET))).status,401);
 assert.equal((await signed('/protected',jwt.sign({id:7,purpose:'access',session:'a'},process.env.JWT_SECRET,{algorithm:'HS384'}))).status,403);
 assert.equal((await signed('/protected',security.signAccess(user,['Admin'],-1))).status,401);
});
test('revoked, missing, idle and DB-failed sessions stay closed using in-memory SQL doubles',async()=>{
 revoked=true;assert.equal((await signed('/protected')).status,401);revoked=false;
 missing=true;assert.equal((await signed('/protected')).status,401);missing=false;
 idle=1801;assert.equal((await signed('/protected')).status,401);idle=0;
 dbFailure=true;const r=await signed('/protected');assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/SYNTHETIC_PRIVATE/);
});
test('privileged roles are refreshed from the double, not trusted from JWT role claims',async()=>{
 currentRole='Learner';assert.equal((await signed('/admin')).status,403);currentRole='Admin';assert.equal((await signed('/admin')).status,200);
 currentRole='SuperAdmin';assert.equal((await signed('/admin')).status,200);
 const middleware=authorizeRoles('Admin');dbFailure=true;let status;await middleware({user:{id:7,roles:['Admin']}},{status(n){status=n;return this;},json(){}},()=>assert.fail('must fail closed'));assert.equal(status,503);
});
test('express-validator preserves canonical bounded email and password-input contracts',async()=>{
 assert.equal(await security.normalizeEmail(' Test@EXAMPLE.INVALID '),'test@example.invalid');
 for(const value of [[],{},'not-an-email','x'.repeat(255)+'@example.invalid'])assert.equal(await security.normalizeEmail(value),null);
 assert.deepEqual(security.passwordErrors('Strong123!'),[]);assert.equal(security.passwordInput('x'.repeat(257)),false);
});
test('actual Stripe SDK verifies exact raw webhook bytes on both aliases without provider requests',async()=>{
 for(const route of ['/webhook','/api/purchases/webhook']){
  const payload=' {"id":"evt_P2H_SYNTHETIC","type":"p2h.test","data":{"object":{"note":"é"}}} \n';
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret:process.env.STRIPE_WEBHOOK_SECRET});
  const before=handled.length;let r=await call(route,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});assert.equal(r.status,200);assert.deepEqual(await r.json(),{received:true});assert.equal(handled.length,before+1);
  r=await call(route,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload+' '});assert.equal(r.status,400);assert.equal(handled.length,before+1);
  r=await call(route,{method:'POST',headers:{'content-type':'application/json'},body:payload});assert.equal(r.status,400);assert.equal(handled.length,before+1);
 }
});
test('actual upload parser retains pause, authentication, validation, cleanup and lifecycle boundaries',async()=>{
 const upload=async(field='profileImage',authorized=true)=>{const form=new FormData();form.append(field,new Blob([require('./fixtures/uploadFiles').png],{type:'image/png'}),'synthetic.png');return call('/image',{method:'PUT',headers:authorized?{authorization:'Bearer '+token()}:{},body:form});};
 assert.equal((await upload()).status,503);assert.deepEqual(fs.readdirSync(imageRoot),[]);
 barrier.resume(); // This test-local barrier is unrelated to any production operator.
 assert.equal((await upload('profileImage',false)).status,401);assert.equal((await upload()).status,200);
 assert.equal((await upload('unexpected')).status,400);
 for(let i=0;i<100&&(barrier.status().activeTotal||fs.readdirSync(imageRoot).length);i++)await new Promise(r=>setTimeout(r,10));
 assert.deepEqual(fs.readdirSync(imageRoot),[]);assert.equal(barrier.status().activeTotal,0);assert.equal(barrier.status().observedCleanupFailures,0);assert.equal(barrier.status().lifecycleInvariantFailures,0);
});
test('Morgan keeps accepted query redaction, control escaping and static/health log exclusions',async()=>{
 access.length=0;await call('/records/log?token=P2H_PRIVATE_TOKEN&email=synthetic@example.invalid');await new Promise(r=>setTimeout(r,10));
 assert.match(access.join(''),/GET \/records\/log 200/);assert.doesNotMatch(access.join(''),/P2H_PRIVATE_TOKEN|email=|token=/);
 const logging=require('../src/utils/safeLogging');assert.doesNotMatch(logging.requestPath({url:'/x\u2028y?token=hidden'}),/[\u2028\u2029]|hidden/);
 access.length=0;await call('/health');await call('/uploads/synthetic.png');await new Promise(r=>setTimeout(r,10));assert.equal(access.length,0);
});
