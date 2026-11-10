'use strict';
// Ephemeral cryptographic doubles only. Never signs operational approvals.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const B=require('../src/sandbox/bootstrap'),O=require('../src/sandbox/ownerPolicy');
const {digest}=require('../src/services/paystackNigeria/transportConfig');
const {createApprovalReceiver}=require('../src/sandbox/approvals');
const {inputs}=require('./fixtures/paystackTransport.cjs');
const owner={approvalMode:O.MODE,ownerAuthorized:true,evidenceDigest:'c'.repeat(64)};
const keys=()=>crypto.generateKeyPairSync('ed25519');
const sign=(body,key)=>{const payload=JSON.stringify(body);return{payload,signature:crypto.sign(null,Buffer.from(payload),key).toString('base64')};};
function bootstrapFixture(){
 const key=keys(),seed={seedId:crypto.randomUUID(),merchantAccount:'100043',buyerEmail:'buyer@example.invalid',scholarEmail:'scholar@example.invalid',buyerHash:['$argon2id$','synthetic'].join(''),scholarHash:['$argon2id$','synthetic'].join('')};
 let connections=0,ddl=0,commits=0,rollbacks=0;
 const db={async query(sql){if(sql==='SELECT DATABASE() AS db')return[[{db:'uniclipspsngsandbox'}]];if(sql.includes('INFORMATION_SCHEMA.TABLES'))return[[]];if(sql.startsWith('CREATE TABLE'))ddl++;return[[]];},async beginTransaction(){},async commit(){commits++;},async rollback(){rollbacks++;},release(){},destroy(){}};
 const pool={config:{host:'mysql.example.invalid'},async getConnection(){connections++;return db;}};
 const clock=Date.now(),approval={...owner,kind:'sandbox-owner-bootstrap-v1',host:pool.config.host,database:'uniclipspsngsandbox',source:'frozen-source',seedDigest:digest(JSON.stringify(seed)),schemaDigest:B.schemaDigest(),issuedAt:clock,expiresAt:clock+300000};
 const run=(patch={},options={})=>B.bootstrap({pool,seed,publicKey:key.publicKey,envelope:sign({...approval,...patch},key.privateKey),now:()=>clock,source:approval.source,...options});
 return{key,seed,db,pool,clock,approval,run,state:()=>({connections,ddl,commits,rollbacks})};
}
test('one explicit owner bootstrap verifies all bindings before connecting; no second signature',async()=>{
 const f=bootstrapFixture();assert.equal((await f.run()).subjectId,401);assert.deepEqual(f.state(),{connections:1,ddl:26,commits:1,rollbacks:0});
});
test('bootstrap rejects old/duplicate review, missing consent, unsafe binding, TTL and invalid signature before DB work',async()=>{
 const f=bootstrapFixture();
 for(const patch of [{kind:'sandbox-bootstrap-v1'},{approvalMode:'dual-review'},{ownerAuthorized:false},{evidenceDigest:''},{database:'production'},{host:'other.invalid'},{source:'changed'},{schemaDigest:'0'.repeat(64)},{seedDigest:'0'.repeat(64)},{issuedAt:f.clock+1},{expiresAt:f.clock},{expiresAt:f.clock+300001}])await assert.rejects(f.run(patch));
 await assert.rejects(f.run({}, {review:sign(f.approval,f.key.privateKey),reviewerKey:f.key.publicKey}));
 await assert.rejects(f.run({}, {envelope:[sign(f.approval,f.key.privateKey),sign(f.approval,f.key.privateKey)]}));
 await assert.rejects(f.run({}, {envelope:sign(f.approval,keys().privateKey)}));assert.equal(f.state().connections,0);
});
test('bootstrap rolls back failed synthetic seed without claiming its preceding DDL was rolled back',async()=>{
 const f=bootstrapFixture(),query=f.db.query;f.db.query=async sql=>{if(sql.startsWith('INSERT INTO users'))throw Error('synthetic write failure');return query(sql);};
 await assert.rejects(f.run());assert.deepEqual(f.state(),{connections:1,ddl:26,commits:0,rollbacks:1});
});
test('owner mode requires explicit opt-in; production and old reviewer settings cannot satisfy it',()=>{
 const {settings}=require('../src/sandbox/isolation');for(const e of [{},{SANDBOX_APPROVAL_MODE:'dual-review'},{SANDBOX_APPROVAL_MODE:O.MODE,SANDBOX_REVIEWER_PUBLIC_KEY:'duplicate.pem'},{SANDBOX_APPROVAL_MODE:O.MODE,NODE_ENV:'production'}])assert.throws(()=>settings(e));
 assert.throws(()=>O.ownerKey(crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey),{code:'SANDBOX_OWNER_ED25519_REQUIRED'});
 assert.throws(()=>O.approval({...owner,independentlyReviewed:true}),{code:'SANDBOX_LEGACY_REVIEW_REJECTED'});
});
function receiverFixture(){
 const key=keys(),f=inputs();let clock=Date.now();const id={service:'srv-fixture',generation:crypto.randomUUID(),source:'synthetic-source',instance:'synthetic-instance'};
 const env={...f.env,SANDBOX_APPROVAL_MODE:O.MODE,UNICLIPS_SANDBOX:'paystack-test-v1',DB_NAME:'uniclipspsngsandbox',DB_USER:'psngsandboxapp',DB_HOST:'mysql.example.invalid',DB_PASS:String(crypto.randomBytes(24).toString('hex')),DB_SSL:'true',DB_SSL_CA:'synthetic',FRONTEND_URL:'https://ui.example.invalid',ALLOWED_ORIGINS:'https://ui.example.invalid',PAYMENT_ARCHITECTURE:'legacy_verified',PAYSTACK_NG_SECRET_KEY:f.secret,PAYSTACK_NG_WEBHOOK_SECRET:f.webhookSecret};
 const receiver=createApprovalReceiver({env,identity:id,publicKey:key.publicKey,metadata:require('./fixtures/paystackNigeriaMetadata.cjs').metadata(),now:()=>clock});
 const c=receiver.status(),bound={...owner,version:1,identity:id,challenge:c.challenge,issuedAt:clock,expiresAt:clock+300000};
 const authorization=sign({...owner,...JSON.parse(f.authorization.payload),...id,schemaDigest:c.schemaDigest,metadataDigest:c.metadataDigest,issuedAt:clock,expiresAt:clock+3600000},key.privateKey);
 const writer=sign({...owner,version:1,mode:'legacy_verified',environment:'test',...id,issuedAt:clock,expiresAt:clock+300000,phase2aWriters:0,unknownWriters:0,entryPoints:require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS},key.privateKey);
 const packet={...bound,kind:'sandbox-owner-approvals-v1',sequence:1,authorization,writer};
 const zero={...bound,kind:'sandbox-owner-zero-v1',seedDigest:'d'.repeat(64),subjectId:401,scholarId:301,reviewVersion:1,reviewId:crypto.randomUUID(),sourceRevision:'d'.repeat(64),writerMode:'legacy_verified',facts:[]};
 return{key,receiver,packet,zero,advance:n=>clock+=n};
}
test('zero approval requires installed owner authorization and fresh writer; old dual packets never substitute',t=>{
 const f=receiverFixture();t.after(()=>f.receiver.close());const z=sign(f.zero,f.key.privateKey);
 assert.throws(()=>f.receiver.zeroAuthorization(z),{code:'SANDBOX_ACTIVATION_APPROVAL_REQUIRED'});
 for(const patch of [{kind:'sandbox-approvals-v1'},{ownerAuthorized:false},{evidenceDigest:'bad'},{approvalMode:'dual-review'}])assert.throws(()=>f.receiver.install(sign({...f.packet,...patch},f.key.privateKey)));
 assert.throws(()=>f.receiver.install(sign({...f.packet,writer:f.packet.authorization},f.key.privateKey)),{code:'SANDBOX_DUPLICATE_APPROVAL'});
 for(const field of ['authorization','writer'])assert.throws(()=>f.receiver.install(sign({...f.packet,[field]:sign({...JSON.parse(f.packet[field].payload),ownerAuthorized:false},f.key.privateKey)},f.key.privateKey)));
 f.receiver.install(sign(f.packet,f.key.privateKey));assert.equal(f.receiver.zeroAuthorization(z).approvalMode,O.MODE);
 assert.throws(()=>f.receiver.zeroAuthorization(sign({...f.zero,challenge:'other'},f.key.privateKey)));
 const authBody=JSON.parse(f.packet.authorization.payload),expired=sign({...authBody,expiresAt:authBody.issuedAt-1},f.key.privateKey);
 require('node:fs').writeFileSync(f.receiver.files.authorization,JSON.stringify(expired));assert.throws(()=>f.receiver.zeroAuthorization(z),{code:'PAYSTACK_AUTHORIZATION_REQUIRED'});
 f.advance(300001);assert.throws(()=>f.receiver.zeroAuthorization(z));
});
test('atomic empty-state census refuses orders, counters, events or any other nonzero financial table',async()=>{
 let sql;await O.requireEmptyFinancialState({async query(s){sql=s;return[[{financial_rows:'0'}]];}});
 for(const name of ['paystack_ng_orders','paystack_ng_events','paystack_ng_sale_counters','course_sale_proofs','subject_purchases'])assert(sql.includes(name));
 for(const n of ['1','invalid',null])await assert.rejects(O.requireEmptyFinancialState({query:async()=>[[{financial_rows:n}]]}),{code:'SANDBOX_ZERO_NONEMPTY'});
});
test('scope validator executes after subject lock and before writes; refusal rolls back in the audit transaction',async()=>{
 const f=receiverFixture(),trace=[];const db={async query(sql){trace.push(sql);if(sql.includes('time_zone'))return[[{zone:'+00:00'}]];if(sql.includes('FROM subjects'))return[[{id:401}]];return[[]];},async beginTransaction(){trace.push('BEGIN');},async rollback(){trace.push('ROLLBACK');},release(){trace.push('RELEASE');}};
 try{const importer=require('../src/services/coursePayments/historicalResolver').createAuditImporter({pool:{getConnection:async()=>db},publicKey:f.key.publicKey,verifyProvenance:async()=>false,validateScope:async()=>{trace.push('OWNER_CENSUS');throw Error('nonempty');}});
 await assert.rejects(importer(sign(f.zero,f.key.privateKey)));assert(trace.findIndex(s=>s.includes('FROM subjects'))<trace.indexOf('OWNER_CENSUS'));assert(trace.includes('ROLLBACK'));assert(!trace.some(s=>s.startsWith('INSERT')));
 }finally{f.receiver.close();}
});
test('issuer refuses old zero-audit/reviewer commands and requires retained evidence before drafting',()=>{
 const {draft,signReviewed}=require('../scripts/paystackSandboxApproval.cjs');const f=bootstrapFixture();
 for(const kind of ['zero-audit','zero-review'])assert.throws(()=>draft(kind,{...owner}));
 assert.throws(()=>draft('bootstrap',{host:'mysql.example.invalid',prepared:{}}));
 const p=draft('bootstrap',{...owner,host:f.pool.config.host,prepared:{source:f.approval.source,seedDigest:f.approval.seedDigest,schemaDigest:B.schemaDigest()}});assert.equal(p.kind,'sandbox-owner-bootstrap-v1');
 assert.throws(()=>signReviewed({...p,kind:'sandbox-bootstrap-v1'},f.key.privateKey));
});
test('actual sandbox zero-history HTTP accepts one owner envelope once, preserves receipt evidence and rejects dual bodies',async()=>{
 const f=receiverFixture();let audited=0,commits=0,backup=0;
 const db={async query(sql){
  if(sql==='SELECT * FROM sandbox_manifest WHERE singleton=1')return[[{kind:'synthetic-paystack-test',subject_id:401,scholar_id:301,seed_digest:f.zero.seedDigest}]];
  if(sql.includes('time_zone'))return[[{zone:'+00:00'}]];
  if(sql.includes('FROM subjects'))return[[{id:401}]];
  if(sql.includes('AS financial_rows'))return[[{financial_rows:audited}]];
  if(sql.startsWith('INSERT INTO course_sale_audits')){audited++;return[{}];}
  return[[]];
 },async beginTransaction(){backup=audited;},async commit(){commits++;},async rollback(){audited=backup;},release(){}};
 const pool={query:(...a)=>db.query(...a),getConnection:async()=>db};
 const file=require.resolve('../src/config/db'),old=require.cache[file];require.cache[file]={id:file,filename:file,loaded:true,exports:{pool}};
 let server;
 try{
  f.receiver.install(sign(f.packet,f.key.privateKey));
  const app=require('../src/sandbox/app').createSandboxApp({pool,receiver:f.receiver,publicKey:f.key.publicKey,origin:'https://ui.example.invalid'});
  server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
  const post=async body=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/sandbox/zero-history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
  const authorization=sign(f.zero,f.key.privateKey);
  assert.equal((await post({audit:authorization,review:authorization})).status,503);
  assert.equal((await post({authorization:{...authorization,signature:'invalid'}})).status,503);assert.equal(audited,0);
  const result=await post({authorization});assert.equal(result.status,200);assert.equal(result.body.approvalMode,O.MODE);assert.equal(result.body.evidenceDigest,owner.evidenceDigest);assert.equal(result.body.approvalDigest,digest(JSON.stringify(authorization)));assert.equal(commits,1);
  assert.equal((await post({authorization})).status,503);assert.equal(audited,1);assert.equal(commits,1);
 }finally{if(server)await new Promise(r=>server.close(r));f.receiver.close();if(old)require.cache[file]=old;else delete require.cache[file];}
});
