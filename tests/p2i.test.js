'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),http=require('node:http');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
if(process.env.P2I_ISOLATED_TEST!=='1')throw Error('Isolated P2I test flag required');
const {pageInput,pageRows,createReadBudget,mapBounded,readQuery}=require('../src/utils/readCapacity');
const {publicError,errorHandler}=require('../src/middleware/publicErrors');
const {createBoundedAccessLog}=require('../src/utils/boundedAccessLog');
const {logError,requestPath}=require('../src/utils/safeLogging');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
function load(file,overrides={}){
 const filename=path.resolve(__dirname,'../src',file),real=createRequire(filename),logs=[],module={exports:{}};
 const logger={log(){},warn:(...a)=>logs.push(a),error:(...a)=>logs.push(a)};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,console:logger,Buffer,URL,process:Object.assign(new EventEmitter(),{env:{NODE_ENV:'production',STRIPE_WEBHOOK_SECRET:'whsec_P2I_SYNTHETIC'}}),__dirname:path.dirname(filename),require(n){if(n in overrides)return overrides[n];if(n.includes('safeLogging'))return{...require('../src/utils/safeLogging'),logError:(event,error)=>logError(event,error,logger)};return real(n);}});
 return{exports:module.exports,logs};
}
test('pagination rejects arrays, SQL payloads, overflow, negative and unbounded inputs',()=>{
 for(const limit of ['0','-1','101','1e2','1 OR 1=1',[],{},'2147483648'])assert.throws(()=>pageInput({limit}));
 for(const before of ['0','-1','1.5','x','2147483648'])assert.throws(()=>pageInput({before}));
 assert.deepEqual(pageInput({limit:'2',before:'42'}),{limit:2,before:42});
 const p=pageRows([{id:42},{id:41},{id:40}],{limit:2});
 assert.deepEqual(p,{items:[{id:42},{id:41}],pagination:{limit:2,hasMore:true,nextBefore:41}});
});
test('read budget retains capacity while a disconnected request still has work',async()=>{
 const slot=deferred(),budget=createReadBudget({global:1,perUser:1});
 const pending=budget.run(7,()=>slot.promise);await assert.rejects(budget.run(8,async()=>1),e=>e.status===503);
 // Response/socket state does not release an unfinished operation.
 assert.deepEqual(budget.status(),{active:1,trackedUsers:1});
 slot.resolve();await pending;assert.deepEqual(budget.status(),{active:0,trackedUsers:0});
 assert.equal(await budget.run(8,async()=>42),42);
});
test('read budgets isolate accounts and release after exceptions',async()=>{
 const a=deferred(),b=deferred(),budget=createReadBudget({global:3,perUser:1});
 const pa=budget.run(7,()=>a.promise),pb=budget.run(8,()=>b.promise);
 await assert.rejects(budget.run(7,async()=>1));a.reject(Error('synthetic'));await assert.rejects(pa);b.resolve();await pb;
 assert.equal(budget.status().trackedUsers,0);
});
test('bounded fanout preserves order and settles active siblings before rejection',async()=>{
 const later=deferred(),budget=createReadBudget({global:1}),started=[];
 const work=budget.run(1,()=>mapBounded([0,1,2,3],2,async n=>{started.push(n);if(n===0)throw Error('synthetic');if(n===1)await later.promise;return n;}));
 await new Promise(r=>setImmediate(r));assert.equal(budget.status().active,1);
 later.resolve();await assert.rejects(work);assert.deepEqual(started,[0,1]);assert.equal(budget.status().active,0);
 assert.deepEqual(await mapBounded([3,2,1],2,async n=>n*2),[6,4,2]);
});
test('read query releases success and destroys timed-out connections instead of reusing them',async()=>{
 let released=0,destroyed=0,options;
 const c={query:async o=>{options=o;return[[{id:1}]];},release(){released++;},destroy(){destroyed++;}};
 const pool={getConnection:async()=>c};
 await readQuery(pool,'SELECT id FROM fixture',[7]);assert.equal(options.timeout,10000);assert.equal(released,1);
 c.query=async()=>{throw Object.assign(Error('PRIVATE_SQL'),{code:'PROTOCOL_SEQUENCE_TIMEOUT'});};
 await assert.rejects(readQuery(pool,'SELECT fixture'),e=>e.status===503&&e.code==='READ_CAPACITY_UNAVAILABLE');
 assert.equal(destroyed,1);assert.equal(released,1);
 await assert.rejects(readQuery({getConnection:async()=>{throw Error('Queue limit reached.');}},'SELECT fixture'),e=>e.status===503);
});
test('actual pinned driver queue rejects overflow and recovers on a freed slot',()=>{
 const mysql=require('mysql2'),p=mysql.createPool({host:'127.0.0.1',connectionLimit:1,queueLimit:2,waitForConnections:true});
 p._allConnections.push({});let overflow;
 p.getConnection(()=>{});p.getConnection(()=>{});p.getConnection(e=>{overflow=e;});
 assert.equal(p._connectionQueue.length,2);assert.equal(overflow.message,'Queue limit reached.');
 p._connectionQueue.clear();p._allConnections.clear();p.end();
});
test('production pool keeps strict TLS builder and uses the finite queue budget',()=>{
 let cfg;const expected={ssl:{rejectUnauthorized:true,verifyIdentity:true,ca:'synthetic'},connectionLimit:10,queueLimit:0};
 const h=load('config/db.js',{'mysql2/promise':{createPool(c){cfg=c;return{};}},dotenv:{config(){}},'./databaseTls':{buildPoolConfig:()=>expected,verifyDatabaseConnection:async()=>{}}});
 assert.equal(cfg.queueLimit,20);assert.equal(cfg.connectionLimit,10);assert.equal(cfg.ssl,expected.ssl);assert.ok(h.exports.pool);
});
test('global production errors clamp statuses and never disclose raw parser bodies or driver errors',()=>{
 const marker='SYNTHETIC_PRIVATE_BEARER_SQL';
 for(const status of [200,302,NaN,'400',400,503,599,600]){
  const safe=publicError({status,message:marker,stack:marker,sql:marker});
  assert.ok(safe.status>=400&&safe.status<=599);assert.doesNotMatch(JSON.stringify(safe),new RegExp(marker));
 }
 for(const type of ['entity.parse.failed','entity.too.large','request.aborted','encoding.unsupported'])assert.doesNotMatch(JSON.stringify(publicError({type,body:marker,message:marker})),new RegExp(marker));
 assert.equal(publicError({type:'entity.too.large'}).status,413);
 const res=response();errorHandler({message:marker},{},res,()=>assert.fail());assert.equal(res.statusCode,500);
});
test('already-started error responses delegate instead of writing a second response',()=>{
 let next=0;errorHandler(Error('synthetic'),{},{headersSent:true},()=>next++);assert.equal(next,1);
});
for(const [file,method,req]of [
 ['controller/adminController.js','getAdminProfile',{user:{id:7}}],
 ['controller/locationController.js','getAllCountries',{query:{}}],
 ['controller/subjectController.js','getAllSubjects',{}],
 ['controller/statsController.js','getPlatformStats',{}]
])test(file+' masks raw DB failures in response and log',async()=>{
 const marker='SYNTHETIC_PRIVATE_SQL_PASSWORD';const err=Object.assign(Error(marker),{code:marker,sql:marker});
 const h=load(file,{'../config/db':{pool:{query:async()=>{throw err;}}},'../models/subject':{SubjectModel:{findAll:async()=>{throw err;}}}}),res=response();
 assert.equal(typeof h.exports[method],'function');await h.exports[method](req,res);
 assert.equal(res.statusCode,500);assert.doesNotMatch(JSON.stringify([res.body,h.logs]),new RegExp(marker));
});
test('catalogue SQL keeps approval/publication/preview predicates and parameterizes cursor and limit',async()=>{
 const calls=[],h=load('models/videos.js',{'../config/db':{pool:{query:async(...a)=>{calls.push(a);return[[]];}}}});
 await h.exports.VideoModel.getAllVideos({before:123,limit:2});
 const [options,args]=calls[0];assert.match(options.sql,/v\.approved = 1 AND sp\.approved = 1 AND ss\.approved = 1/);
 assert.match(options.sql,/cw\.state='PUBLISHED'/);assert.match(options.sql,/created_at.*DESC, v\.id DESC LIMIT \?/);assert.deepEqual(Array.from(args),[123,3]);assert.equal(options.timeout,10000);
});
test('catalogue response has a real cursor and no provider/security fields',async()=>{
 const rows=[{id:9,subject_id:10,is_first_preview:1,video_url:'SYNTHETIC_PRIVATE',password:'SYNTHETIC_PRIVATE'},{id:8,subject_id:10,is_first_preview:0},{id:7}];
 const h=load('controller/videoController.js',{
 '../models/videos':{VideoModel:{getAllVideos:async()=>[rows]}},'../config/vimeo':{},'../config/db':{pool:{}},
 '../utils/generalCourses':{annotateCourses:async(_db,items)=>items},'../services/videoReadiness':{sharedVideoReadiness:()=>({})},
 '../services/vimeoPrivacy':{INITIAL_PRIVACY:{},sharedVimeoPrivacy:()=>({})},'../services/courseWorkflow':{createCourseWorkflow:()=>({})}
 }),res=response();await h.exports.getAllVideos({query:{limit:'2'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.videos.length,2);assert.equal(res.body.pagination.nextBefore,8);
 assert.doesNotMatch(JSON.stringify(res.body),/SYNTHETIC_PRIVATE|video_url|password/);
});
test('library reads use a finite page and no more than two course-query workers',async()=>{
 let active=0,peak=0;const calls=[],pool={async query(options,args){
  const sql=typeof options==='string'?options:options.sql;calls.push({sql,args,timeout:options.timeout});active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,3));active--;
  if(sql.includes('FROM user_library ul'))return[[{id:8,subject_id:1,scholar_id:7},{id:7,subject_id:2,scholar_id:7},{id:6,subject_id:3,scholar_id:7}]];
  if(sql.includes('FROM videos v'))return[[{id:10,title:'Synthetic',sequence_index:1,is_free:1}]];
  if(sql.includes('FROM video_progress'))return[[{video_id:10,watched:true}]];
  throw Error('Unexpected read');
 }};
 const h=load('controller/libraryController.js',{'../config/db':{pool},'../utils/generalCourses':{annotateCourses:async(_db,items)=>items}}),res=response();
 await h.exports.getMyLibrary({user:{id:7},query:{limit:'2'}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.library.length,2);assert.equal(res.body.pagination.nextBefore,7);
 assert.ok(peak<=2);assert.equal(calls[0].timeout,10000);assert.deepEqual(Array.from(calls[0].args),[7,2147483647,3]);
 assert.equal(calls.some(c=>/INSERT|UPDATE|DELETE/.test(c.sql)),false);
});
test('bounded access log rotates within disk limit and strips line separators',async()=>{
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uniclips-p2i-log-'));
 try{
  const stream=createBoundedAccessLog(folder,{maxBytes:100,backups:2,queueBytes:4096,lineBytes:80});
  for(let i=0;i<10;i++)stream.write('entry '+i+' '+'.'.repeat(42)+'\u2028\n');await stream.end();
  const names=await fs.promises.readdir(folder);assert.ok(names.length<=3);
  for(const n of names){const bytes=await fs.promises.readFile(path.join(folder,n));assert.ok(bytes.length<=100);assert.doesNotMatch(bytes.toString(),/\u2028/);}
 }finally{assert.ok(folder.startsWith(path.join(os.tmpdir(),'uniclips-p2i-log-')));await fs.promises.rm(folder,{recursive:true});}
});
test('log backpressure drops without growing a request-blocking queue',async()=>{
 const held=deferred(),io={...fs.promises,mkdir:()=>held.promise,lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false})};
 const stream=createBoundedAccessLog('unused',{queueBytes:100,lineBytes:50,io});
 for(let n=0;n<20;n++)stream.write('x'.repeat(49)+'\n');
 assert.ok(stream.status().queuedBytes<=100);assert.ok(stream.status().dropped>0);
 held.reject(Error('SYNTHETIC_PRIVATE_FILE'));await stream.end();assert.equal(stream.status().unavailable,true);
});
test('storage failures produce one fixed diagnostic without filesystem/private errors',async()=>{
 let faults=0;const stream=createBoundedAccessLog('unused',{io:{mkdir:async()=>{throw Error('PRIVATE');}},onFault:()=>faults++});
 stream.write('safe');await stream.end();stream.write('later');assert.equal(faults,1);assert.equal(stream.status().unavailable,true);
});
test('oversized path logging is bounded and query credentials remain absent',()=>{
 assert.ok(requestPath({url:'/'+ 'x'.repeat(10000)+'?token=SYNTHETIC_PRIVATE'}).length<=512);
 assert.doesNotMatch(requestPath({url:'/path?reset_token=SYNTHETIC_PRIVATE'}),/SYNTHETIC_PRIVATE/);
});

test('hashing/verification failures keep accepted costs and do not log password or provider errors',async()=>{
 const marker='SYNTHETIC_PRIVATE_PASSWORD';let options;const h=load('utils/passwordHasher.js',{'argon2':{argon2id:2,hash:async(_p,o)=>{options=o;throw Error(marker);},verify:async()=>{throw Error(marker);}},'bcryptjs':{compare:async()=>{throw Error(marker);}}});
 await assert.rejects(h.exports.hashPassword(marker));assert.equal(options.memoryCost,65536);await h.exports.verifyPassword(marker,'$argon2id$synthetic');await h.exports.verifyPassword(marker,'$2b$synthetic');assert.doesNotMatch(JSON.stringify(h.logs),new RegExp(marker));
});
test('new access logs leave inherited oversized logs and independent evidence untouched',async()=>{
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uniclips-p2i-log-'));try{const inherited=['access.log','access.log.1','financial-audit.log','receipt.json'];for(const n of inherited)await fs.promises.writeFile(path.join(folder,n),'x'.repeat(1000));const stream=createBoundedAccessLog(folder,{maxBytes:100,backups:2,lineBytes:80});stream.write('new entry\n');await stream.end();for(const n of inherited)assert.equal((await fs.promises.stat(path.join(folder,n))).size,1000);assert.equal((await fs.promises.readFile(path.join(folder,'access-v2.log'),'utf8')),'new entry\n');}finally{assert.ok(folder.startsWith(path.join(os.tmpdir(),'uniclips-p2i-log-')));await fs.promises.rm(folder,{recursive:true});}
});

test('actual startup route order preserves raw Stripe signatures on both webhook aliases',async()=>{
 const express=require('express'),stripe=require('stripe')('sk_test_P2I_SYNTHETIC');let handled=0;
 const webhook=load('controller/stripeWebhookController.js',{'../config/stripe':stripe,'../services/paymentRelease':{paymentRuntime:()=>({handleEvent:async()=>{handled++;return{};}})}}).exports.stripeWebhook;
 const router=express.Router();router.post('/echo-json',(req,res)=>res.json({parsed:typeof req.body==='object'}));router.get('/private-failure',(_req,_res,next)=>next(Object.assign(Error('SYNTHETIC_PRIVATE_SQL'),{statusCode:400})));
 const h=load('index.js',{'dotenv':{config(){}},'./routes':router,'./routes/purchaseRoutes':express.Router(),'./controller/stripeWebhookController':{stripeWebhook:webhook},'./controller/taskCardController':{publicUploadBoundary:(_req,_res,next)=>next()},'./config/db':{pool:{},initializeDatabase:()=>new Promise(()=>{})},'./utils/uploadBarrier':{shared:{}},'./utils/uploadOperator':{startUploadOperator:async()=>{}},'./utils/gracefulShutdown':{createGracefulShutdown:()=>({admit:(_req,_res,next)=>next(),instrument(){}})},'./utils/boundedAccessLog':{createBoundedAccessLog:()=>({write(){},end:async()=>{}})}});
 const server=h.exports.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{const payload=JSON.stringify({id:'evt_P2I_SYNTHETIC',type:'fixture.event',data:{object:{}}}),timestamp=Math.floor(Date.now()/1000),signature='t='+timestamp+',v1='+require('node:crypto').createHmac('sha256','whsec_P2I_SYNTHETIC').update(timestamp+'.'+payload).digest('hex');
 for(const route of ['/webhook','/api/purchases/webhook']){const valid=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});assert.equal(valid.status,200);const invalid=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json','stripe-signature':'bad'},body:payload});assert.equal(invalid.status,400);}assert.equal(handled,2);
 const badJson=await fetch(base+'/api/echo-json',{method:'POST',headers:{'content-type':'application/json'},body:'{"private":"SYNTHETIC_PRIVATE_SQL"'});assert.equal(badJson.status,400);assert.doesNotMatch(await badJson.text(),/SYNTHETIC_PRIVATE_SQL/);
 const failure=await fetch(base+'/api/private-failure');assert.equal(failure.status,400);assert.doesNotMatch(await failure.text(),/SYNTHETIC_PRIVATE_SQL/);assert.doesNotMatch(JSON.stringify(h.logs),/SYNTHETIC_PRIVATE_SQL/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('legacy discovery/list boundaries cap rows and fail rather than silently truncate',async()=>{
 const {readBounded}=require('../src/utils/readCapacity');let options;const bounded={query:async o=>{options=o;return[[{id:1},{id:2}]];}};await assert.rejects(readBounded(bounded,'SELECT id FROM fixture;  ',[],1),e=>e.status===503&&e.code==='READ_RESULTS_UNAVAILABLE');assert.match(options.sql,/LIMIT 2$/);assert.equal(options.timeout,10000);const good=await readBounded({query:async()=>[[{id:1}]]},'SELECT id FROM fixture',[],1);assert.equal(good[0].length,1);
});

test('legacy purchase read failure hides the full driver object without changing payment business logic',async()=>{
 const marker='SYNTHETIC_PRIVATE_PAYMENT_SQL',err=Object.assign(Error(marker),{code:marker,sql:marker});const h=load('controller/purchaseController.js',{'../models/purchases':{PurchaseModel:{findByUser:async()=>{throw err;}}},'../config/db':{pool:{query:async()=>{throw err;}}},'../services/paymentRelease':{paymentRuntime:()=>{throw Error('Provider forbidden');}}}),res=response();await h.exports.getUserPurchases({user:{id:7}},res);assert.equal(res.statusCode,500);assert.doesNotMatch(JSON.stringify([res.body,h.logs]),new RegExp(marker));assert.equal('error' in res.body,false);
});

test('legacy clients cannot silently receive only the first page of a larger collection',()=>{const {requireExplicitPage}=require('../src/utils/readCapacity');assert.throws(()=>requireExplicitPage({}, {hasMore:true}),e=>e.status===409&&e.code==='COLLECTION_UPDATE_REQUIRED');assert.doesNotThrow(()=>requireExplicitPage({limit:'100'},{hasMore:true}));assert.doesNotThrow(()=>requireExplicitPage({}, {hasMore:false}));});

test('headers-sent delegation cannot leak the original error through Express default logging',()=>{const privateError=Object.assign(Error('SYNTHETIC_PRIVATE_ALREADY_SENT'),{sql:'SYNTHETIC_PRIVATE_ALREADY_SENT'});let forwarded;errorHandler(privateError,{}, {headersSent:true},e=>forwarded=e);assert.notEqual(forwarded,privateError);assert.equal(forwarded.stack,undefined);assert.doesNotMatch(String(forwarded),/SYNTHETIC_PRIVATE_ALREADY_SENT/);assert.equal(forwarded.sql,undefined);});

test('ordered cursors validate route kind, reject mixed controls and hide internal SQL sort fields',()=>{
 const {orderedPageInput,orderedClause}=require('../src/utils/readCapacity');
 const r=pageRows([{id:10,created_at:'2026-01-01',_page_time:'2026-01-01 00:00:00.000000'},{id:20}],orderedPageInput({limit:'1'}));
 assert.equal('_page_time' in r.items[0],false);
 const next=orderedPageInput({limit:'1',cursor:r.pagination.nextCursor});
 assert.deepEqual(orderedClause(next,'v').args,['2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000',10]);
 assert.throws(()=>orderedPageInput({cursor:r.pagination.nextCursor},'review'),e=>e.status===400);
 assert.throws(()=>orderedPageInput({cursor:r.pagination.nextCursor,before:'1'}),e=>e.status===400);
 for(const cursor of [[],{},'!','x'.repeat(241),Buffer.from(JSON.stringify({v:1,k:'created',i:1,t:"x' OR 1=1"})).toString('base64url')])assert.throws(()=>orderedPageInput({cursor}),e=>e.status===400);
});
test('idle new access-log segments expire while legacy and financial evidence are retained',async()=>{
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uniclips-p2i-log-'));let tick;
 try{
  const ancient=new Date(Date.now()-9*86400000);
  for(const name of ['access-v2.log.1','access.log','receipt.json','financial-audit.log']){await fs.promises.writeFile(path.join(folder,name),'old');await fs.promises.utimes(path.join(folder,name),ancient,ancient);}
  const stream=createBoundedAccessLog(folder,{schedule(fn){tick=fn;return{unref(){}};}});
  tick();await stream.end();assert.equal(fs.existsSync(path.join(folder,'access-v2.log.1')),false);
  for(const name of ['access.log','receipt.json','financial-audit.log'])assert.equal(await fs.promises.readFile(path.join(folder,name),'utf8'),'old');
 }finally{assert.ok(folder.startsWith(path.join(os.tmpdir(),'uniclips-p2i-log-')));await fs.promises.rm(folder,{recursive:true});}
});
test('oversized v2 files require explicit recovery instead of silent evidence deletion',async()=>{
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uniclips-p2i-log-'));
 try{await fs.promises.writeFile(path.join(folder,'access-v2.log'),'x'.repeat(200));let faults=0;const stream=createBoundedAccessLog(folder,{maxBytes:100,onFault:()=>faults++});stream.write('new');await stream.end();assert.equal(faults,1);assert.equal((await fs.promises.stat(path.join(folder,'access-v2.log'))).size,200);}
 finally{assert.ok(folder.startsWith(path.join(os.tmpdir(),'uniclips-p2i-log-')));await fs.promises.rm(folder,{recursive:true});}
});
test('new access-log segments rotate on UTC-day change without unbounded history',async()=>{
 const folder=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uniclips-p2i-log-'));
 try{let clock=Date.now();const stream=createBoundedAccessLog(folder,{now:()=>clock});stream.write('first\n');while(stream.status().queuedBytes)await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,10));clock+=86400000;stream.write('second\n');await stream.end();assert.equal(await fs.promises.readFile(path.join(folder,'access-v2.log.1'),'utf8'),'first\n');assert.equal(await fs.promises.readFile(path.join(folder,'access-v2.log'),'utf8'),'second\n');}
 finally{assert.ok(folder.startsWith(path.join(os.tmpdir(),'uniclips-p2i-log-')));await fs.promises.rm(folder,{recursive:true});}
});
