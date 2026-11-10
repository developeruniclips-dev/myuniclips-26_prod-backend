'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module'),express=require('express');
if(process.env.P2I_ISOLATED_TEST!=='1')throw Error('Explicit isolated P2-I fixture required');
const C=require('../src/utils/readCapacity');
const response=()=>({statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function load(file,overrides={}){const filename=path.resolve(__dirname,'../src',file),real=createRequire(filename),module={exports:{}},logs=[];vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,console:{error(){},warn(){},log(){}},process:{env:{NODE_ENV:'test'}},require(n){if(n in overrides)return overrides[n];if(n.includes('safeLogging'))return{logError:(label)=>logs.push(label)};return real(n);},__dirname:path.dirname(filename),__filename:filename});return{exports:module.exports,logs};}
const privateError=()=>Object.assign(Error('SYNTHETIC_PRIVATE_SQL'),{sql:'SYNTHETIC_PRIVATE_SQL',parameters:['SYNTHETIC_PRIVATE_PARAMETER'],stack:'SYNTHETIC_PRIVATE_STACK',token:'SYNTHETIC_PRIVATE_TOKEN'});
const rejecting=()=>{throw privateError();};
const failedModel=new Proxy({},{get:()=>rejecting});
for(const handler of ['requestSubject','approveSubject','approveSubjectById','rejectSubjectById','deleteSubjectByScholar','getScholarSubjectsStatus','getAllScholarSubjects','getAllScholarSubjectsAdmin'])test('all Scholar catches sanitize '+handler,async()=>{
 const h=load('controller/scholarSubjectController.js',{'../models/scholarSubjects':{ScholarSubjectModel:failedModel},'../config/db':{pool:{query:rejecting}},'../utils/academicContext':{scholarContext:rejecting}}),res=response();
 await h.exports[handler]({user:{id:7},body:{},params:{id:1}},res);assert.equal(res.statusCode,500);assert.doesNotMatch(JSON.stringify([res.body,h.logs]),/SYNTHETIC_PRIVATE/);assert.equal('error' in res.body,false);
});
test('actual mounted Scholar aliases sanitize SQL fields and keep authorization',async()=>{
 const h=load('controller/scholarSubjectController.js',{'../models/scholarSubjects':{ScholarSubjectModel:failedModel},'../config/db':{pool:{query:rejecting}},'../utils/academicContext':{scholarContext:rejecting}});
 const auth=(req,res,next)=>req.headers.authorization==='Bearer fixture'?(req.user={id:7},next()):res.sendStatus(401);
 const route=load('routes/scholarSubjects.js',{'../controller/operationsController':{legacyReview:()=>auth},'../controller/scholarSubjectController':h.exports,'../middleware/auth':{authMiddleware:auth},'../middleware/roles':{authorizeRoles:()=> (_q,_r,n)=>n()}}).exports;
 const app=express();app.use(express.json());app.use('/api/scholar-subjects',route);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const suffix of ['/status','/by-user','/all','/STATUS/']){const url='http://127.0.0.1:'+server.address().port+'/api/scholar-subjects'+suffix;assert.equal((await fetch(url)).status,401);const res=await fetch(url,{headers:{authorization:'Bearer fixture'}});assert.equal(res.status,500);assert.doesNotMatch(await res.text(),/SYNTHETIC_PRIVATE|"error"/);}}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('controlled overflow and saturation have fixed 503 responses',()=>{for(const code of ['READ_RESULTS_UNAVAILABLE','READ_CAPACITY_UNAVAILABLE']){const res=response();C.readFailure(res,{code,message:'SYNTHETIC_PRIVATE'},'fallback');assert.equal(res.statusCode,503);assert.equal(res.body.code,code);assert.doesNotMatch(JSON.stringify(res.body),/SYNTHETIC_PRIVATE/);}});
test('complete reads preserve 10000 rows and reject the lookahead, including zero remaining merged capacity',async()=>{
 for(const n of [0,1,9999,10000,10001]){let options;const db={query:async o=>{options=o;return[Array.from({length:n},(_,id)=>({id}))];}};if(n>10000)await assert.rejects(C.readBounded(db,'SELECT id FROM synthetic;'),e=>e.code==='READ_RESULTS_UNAVAILABLE');else assert.equal((await C.readBounded(db,'SELECT id FROM synthetic;'))[0].length,n);assert.match(options.sql,/LIMIT 10001$/);assert.equal(options.timeout,10000);}
 assert.equal((await C.readBounded({query:async()=>[[]]},'SELECT id FROM synthetic',[],0))[0].length,0);await assert.rejects(C.readBounded({query:async()=>[[{id:1}]]},'SELECT id FROM synthetic',[],0),e=>e.status===503);
});
test('late acquisition keeps all eight read leases until actual query settlement',async()=>{
 const acquisition=deferred(),query=deferred();let released=0;const db={getConnection:()=>acquisition.promise};
 const active=Array.from({length:8},()=>C.admittedRead(db,'SELECT 1'));
 assert.equal(C.catalogueReads.status().active,8);await assert.rejects(C.admittedRead(db,'SELECT 1'),e=>e.status===503);
 acquisition.resolve({query:()=>query.promise,release(){released++;}});await new Promise(r=>setImmediate(r));assert.equal(C.catalogueReads.status().active,8);assert.equal(released,0);
 query.resolve([[{n:1}]]);await Promise.all(active);assert.equal(released,8);assert.equal(C.catalogueReads.status().active,0);
});
test('query timeout destroys owned lease and acquisition rejection never leaks capacity',async()=>{
 let destroyed=0,released=0;await assert.rejects(C.admittedRead({getConnection:async()=>({query:async()=>{throw Object.assign(Error('timeout'),{code:'PROTOCOL_SEQUENCE_TIMEOUT'});},destroy(){destroyed++;},release(){released++;}})},'SELECT 1'),e=>e.status===503);assert.equal(destroyed,1);assert.equal(released,0);
 await assert.rejects(C.admittedRead({getConnection:async()=>{throw Error('fixture acquisition failed');}},'SELECT 1'));assert.equal(C.catalogueReads.status().active,0);
});
test('HTTP disconnect does not release an admitted unfinished read',async()=>{
 const gate=deferred(),started=deferred();const app=express();app.get('/',async(_req,res)=>{await C.admittedRead({query:()=>{started.resolve();return gate.promise;}},'SELECT 1');res.end('done');});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const abort=new AbortController(),pending=fetch('http://127.0.0.1:'+server.address().port,{signal:abort.signal}).catch(()=>{});await started.promise;abort.abort();await pending;assert.equal(C.catalogueReads.status().active,1);gate.resolve([[]]);while(C.catalogueReads.status().active)await new Promise(r=>setImmediate(r));server.closeAllConnections();await new Promise(r=>server.close(r));
});
test('statistics positive, SQL failure and saturation retain response semantics',async()=>{
 const calls=[],h=load('controller/statsController.js',{'../config/db':{pool:{query:async o=>{calls.push(o);return[[{count:9}]];}}}}),res=response();await h.exports.getPlatformStats({},res);assert.equal(res.statusCode,200);assert.equal(res.body.success,true);assert.equal(res.body.stats.learners,9);assert.equal(calls.length,4);assert.ok(calls.every(o=>o.timeout===10000));
 const failed=load('controller/statsController.js',{'../config/db':{pool:{query:rejecting}}}),bad=response();await failed.exports.getPlatformStats({},bad);assert.equal(bad.statusCode,500);assert.equal(bad.body.success,false);assert.doesNotMatch(JSON.stringify(bad.body),/SYNTHETIC_PRIVATE/);
 const gate=deferred(),held=Array.from({length:8},()=>C.catalogueReads.run(null,()=>gate.promise));const busy=response();await h.exports.getPlatformStats({},busy);assert.equal(busy.statusCode,503);assert.equal(busy.body.success,false);gate.resolve();await Promise.all(held);
});
test('Operations offset is strict, finite and inclusive at 10000',()=>{
 const {page}=require('../src/services/operations/common');assert.equal(page({page:'201',limit:'50'}).offset,10000);assert.deepEqual(page({}),{limit:20,page:1,offset:0});
 for(const query of [{page:'202',limit:'50'},{page:'1 OR 1=1'},{page:[]},{page:'0'},{limit:'1.2'},{page:'1000000'}])assert.throws(()=>page(query),e=>e.status===400);
});
test('Operations page validation occurs before queries and query options are bounded',async()=>{
 const {paginate}=require('../src/services/operations/data'),calls=[],db={query:async(o,args)=>{calls.push([o,args]);return o.sql.includes('COUNT(*)')?[[{total:2}]]:[[{id:2},{id:1}]];}};
 await assert.rejects(paginate(db,'id','FROM synthetic',[],{limit:'50',page:'202'}),e=>e.status===400);assert.equal(calls.length,0);const p=await paginate(db,'id','FROM synthetic',[],{limit:'2',page:'1'});assert.equal(p.total,2);assert.equal(p.rows.length,2);assert.ok(calls.every(([o])=>o.timeout===10000));
});
test('both transaction datasets share one complete-list cap before returning financial records',async()=>{
 const calls=[],h=load('controller/purchaseController.js',{'../models/purchases':{PurchaseModel:{}},'../config/db':{pool:{query:async o=>{calls.push(o.sql);return calls.length===1?[Array.from({length:9999},(_,id)=>({id,transaction_date:'2026-01-01'}))]:[[{id:10000},{id:10001}]];}}},'../services/paymentRelease':{paymentRuntime(){assert.fail('No provider operation');}}}),res=response();await h.exports.getAllTransactions({user:{id:1}},res);assert.equal(res.statusCode,503);assert.equal(res.body.transactions,undefined);assert.match(calls[1],/LIMIT 2$/);
});
test('library course read retains entitlement and holds budget through both queries',async()=>{
 const calls=[],gate=deferred();let allowed=false;const h=load('controller/libraryController.js',{'../config/db':{pool:{query:async o=>{assert.equal(allowed,true);calls.push(o);return calls.length===1?[[{id:1},{id:2}]]:gate.promise;}}},'../services/contentAuthorization':{createContentAuthorization:()=>({course:async()=>{allowed=true;}})}}),res=response();
 const pending=h.exports.getCourseProgress({user:{id:7},query:{subjectId:1,scholarId:7}},res);while(calls.length<2)await new Promise(r=>setImmediate(r));assert.equal(C.libraryReads.status().active,1);gate.resolve([[{video_id:1,watched:1}]]);await pending;assert.equal(res.body.progressPercent,50);assert.ok(calls.every(o=>o.timeout===10000));assert.equal(C.libraryReads.status().active,0);
});
test('bounded earnings equals frozen arithmetic across financial histories and tiers',async()=>{
 const baseline=path.resolve(__dirname,'../tests/fixtures/p2iEarningsBaseline.cjs');
 const candidate=require('../src/services/payments/earningsService');
 // Baseline fixture is a frozen review oracle, never an executable financial adapter.
 const original=require(baseline);
 const sales=Array.from({length:105},(_,i)=>({id:i+1,subject_id:1,amount:'6.01',currency:'EUR',course_name:'fixture',kind:'bundle',transaction_id:'fixture-'+i,is_current_month:i>98?1:0}));sales.push({id:200,subject_id:2,amount:'7.01',currency:'USD',kind:'bundle',is_current_month:1});
 const authoritative=[{purchase_id:101,scholar_minor:301,currency:'EUR',transfer_state:'completed'},{purchase_id:102,scholar_minor:301,currency:'EUR',transfer_state:'pending',refund_state:'none',dispute_state:'none'},{purchase_id:103,scholar_minor:301,currency:'EUR',transfer_state:'uncertain'},{purchase_id:104,scholar_minor:301,currency:'EUR',transfer_state:'pending',refund_state:'full',dispute_state:'open'}];
 const history=[{id:1,currency:'EUR',status:'completed',amount:'4.21',description:JSON.stringify({kind:'uniclips_legacy_verified_v1',purchaseId:1,paymentId:'fixture-0',grossMinor:601,amountMinor:421,rate:70,ordinal:1})},{id:2,currency:'USD',status:'uncertain',amount:'1.00',description:'malformed'}];
 const datasets=[sales,[{id:1,name:'fixture',bundle_price:'6.00'}],authoritative,history];
 const pool=()=>{let i=0;return{query:async()=>[structuredClone(datasets[i++])]};};
 assert.deepEqual(await candidate.scholarEarnings(pool(),7),await original.scholarEarnings(pool(),7));
 for(let overflow=0;overflow<4;overflow++){let i=0;const db={query:async()=>{const index=i++;return[index===overflow?Array.from({length:10001},()=>({})):structuredClone(datasets[index])];}};await assert.rejects(require('../src/services/payments/earningsService').scholarEarnings(db,7),e=>e.status===503);}
 let i=0;const missing={query:async()=>{const index=i++;if(index===2)throw Object.assign(Error('fixture'),{code:'ER_NO_SUCH_TABLE'});return[structuredClone(datasets[index])];}};assert.ok((await require('../src/services/payments/earningsService').scholarEarnings(missing,7)).summary);
});
module.exports={load};
