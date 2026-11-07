'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {settings,identity,DATABASE}=require('../src/sandbox/isolation');
const {createApprovalReceiver}=require('../src/sandbox/approvals');
const {createSandboxPool}=require('../src/sandbox/database');
const {inputs}=require('./fixtures/paystackTransport.cjs');
const {metadata}=require('./fixtures/paystackNigeriaMetadata.cjs');
const owner={approvalMode:'single-owner-v1',ownerAuthorized:true,evidenceDigest:'a'.repeat(64)};
const env=()=>({SANDBOX_APPROVAL_MODE:'single-owner-v1',UNICLIPS_SANDBOX:'paystack-test-v1',NODE_ENV:'test',DB_HOST:'mysql.sandbox.example.invalid',DB_NAME:DATABASE,DB_USER:'psngsandboxapp',DB_PASS:String(crypto.randomBytes(24).toString('hex')),DB_SSL:'true',DB_SSL_CA:'fixture',PAYMENT_ARCHITECTURE:'legacy_verified',FRONTEND_URL:'https://sandbox.example.invalid',ALLOWED_ORIGINS:'https://sandbox.example.invalid'});
const sign=(p,k)=>{const payload=JSON.stringify(p);return{payload,signature:crypto.sign(null,Buffer.from(payload),k).toString('base64')};};
test('sandbox isolation is explicit, exact-schema and refuses production/provider credentials',()=>{
 settings(env());for(const patch of [{NODE_ENV:'production'},{DB_NAME:'uniclips'},{DB_USER:'doadmin'},{DB_SSL:'false'},{PAYMENT_ARCHITECTURE:'phase2a'},{UNICLIPS_SANDBOX:''},{STRIPE_SECRET_KEY:String(crypto.randomBytes(24).toString('hex'))},{FRONTEND_URL:'https://myuniclips.com',ALLOWED_ORIGINS:'https://myuniclips.com'},{PAYSTACK_NG_LIVE_CHECKOUT:'enabled'}])assert.throws(()=>settings({...env(),...patch}));
});
test('every boot has a new identity even on the same Render instance; source is not a caller flag',()=>{
 const e={RENDER_SERVICE_ID:'srv-synthetic',RENDER_INSTANCE_ID:'synthetic-instance'};
 const a=identity(e),b=identity(e);assert.notEqual(a.generation,b.generation);assert.equal(a.source,b.source);assert.equal(a.source.length,64);assert.throws(()=>identity({}));
});
function fixture(){
 const f=inputs(),keys=crypto.generateKeyPairSync('ed25519');let clock=Date.now();
 const environment={...env(),...f.env,PAYSTACK_NG_SECRET_KEY:f.secret,PAYSTACK_NG_WEBHOOK_SECRET:f.webhookSecret};
 const id={...f.identity,instance:'synthetic-instance'};
 const md=typeof metadata==='function'?metadata():metadata;
 const r=createApprovalReceiver({env:environment,identity:id,publicKey:keys.publicKey,metadata:md,now:()=>clock});
 const status=r.status();
 function packet(patch={},writerPatch={}){
  const authorization=sign({...owner,version:1,environment:'test',entity:'UNICLIPS_NIGERIA_LIMITED',merchantAccount:'100043',...id,issuedAt:clock,expiresAt:clock+3600000,credentialDigest:require('../src/services/paystackNigeria/transportConfig').digest(f.secret),webhookCredentialDigest:require('../src/services/paystackNigeria/transportConfig').digest(f.webhookSecret),callbackOrigin:'https://ui.example.invalid',webhookScheme:'timestamped-v1',feesAbsorbed:true,noAutomaticSplits:true,controls:{TEST_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true},schemaDigest:status.schemaDigest,metadataDigest:status.metadataDigest},keys.privateKey);
  const writer=sign({...owner,version:1,mode:'legacy_verified',environment:'test',...id,issuedAt:clock,expiresAt:clock+300000,phase2aWriters:0,unknownWriters:0,entryPoints:require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS,...writerPatch},keys.privateKey);
  return sign({...owner,kind:'sandbox-owner-approvals-v1',version:1,identity:id,challenge:status.challenge,sequence:1,issuedAt:clock,expiresAt:clock+300000,authorization,writer,...patch},keys.privateKey);
 }
 return{f,r,packet,keys,environment,id,advance:n=>clock+=n,now:()=>clock};
}
test('signed packet installs private regular files, refuses exact/older replay and accepts only fresh writer refresh',t=>{
 const f=fixture();t.after(()=>f.r.close());const p=f.packet();assert.equal(f.r.install(p).sequence,1);assert(fs.lstatSync(f.r.files.writer).isFile());assert.throws(()=>f.r.install(p),{code:'SANDBOX_PACKET_REPLAY'});
 const outer=JSON.parse(p.payload);f.advance(1000);outer.sequence=2;outer.writer=sign({...JSON.parse(outer.writer.payload),issuedAt:f.now(),expiresAt:f.now()+300000},f.keys.privateKey);assert.equal(f.r.install(sign(outer,f.keys.privateKey)).sequence,2);
});
test('expired, invalid signature, mismatched scope, unreviewed schema and unsafe writer roster leave no approval files',t=>{
 const f=fixture();t.after(()=>f.r.close());
 for(const p of [f.packet({expiresAt:0}),{...f.packet(),signature:Buffer.from('invalid').toString('base64')},f.packet({challenge:'wrong'}),f.packet({}, {phase2aWriters:1}),f.packet({}, {unknownWriters:1}),f.packet({}, {entryPoints:[]}),f.packet({}, {expiresAt:f.now()+300001})])assert.throws(()=>f.r.install(p));
 assert(!fs.existsSync(f.r.files.writer));
 const valid=f.packet();f.advance(300001);assert.throws(()=>f.r.install(valid));
});
test('restarts invalidate deliveries; a duplicate reviewer key is rejected, never treated as independent',t=>{
 const a=fixture(),b=fixture();t.after(()=>{a.r.close();b.r.close();});assert.throws(()=>b.r.install(a.packet()));
 assert.throws(()=>createApprovalReceiver({env:a.environment,identity:a.id,publicKey:a.keys.publicKey,reviewerKey:a.keys.publicKey,metadata:typeof metadata==='function'?metadata():metadata}),{code:'SANDBOX_LEGACY_REVIEW_REJECTED'});
 const review=sign({kind:'sandbox-zero-review-v1',version:1,identity:a.id,challenge:a.r.status().challenge,issuedAt:a.now(),expiresAt:a.now()+300000},a.keys.privateKey);assert.throws(()=>a.r.zeroAuthorization(review));
});
test('UTC initializer runs before every lease, restricts pool size and destroys mismatched/unsafe connections',async()=>{
 // Use the existing synthetic CA fixture; no socket or DB driver is created.
 const {execFileSync}=require('node:child_process'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psng-sandbox-ca-'));
 try{
  const openssl=process.env.P1F_OPENSSL||(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key'),'-out',path.join(dir,'ca'),'-days','2','-subj','/CN=Synthetic Sandbox CA','-addext','basicConstraints=critical,CA:TRUE'],{stdio:'ignore',windowsHide:true});
  let config,calls=[],destroyed=0,bad=false,unsafe=false;
  const c={async query(sql){const s=typeof sql==='string'?sql:sql.sql;calls.push(s);if(s.startsWith('SELECT DATABASE'))return[[{db:bad?'production':DATABASE,account:'psngsandboxapp@%',zone:'+00:00'}]];if(s==='SHOW GRANTS')return[[{'Grants':unsafe?'GRANT SELECT ON *.* TO `psngsandboxapp`@`%`':'GRANT SELECT, INSERT, UPDATE, DELETE ON `uniclipspsngsandbox`.* TO `psngsandboxapp`@`%`'}]];if(s.includes('sandbox_manifest'))return[[{version:1}]];return[[]];},destroy(){destroyed++;},release(){}};
  const pool=createSandboxPool({env:env(),readCA:()=>fs.readFileSync(path.join(dir,'ca')),createPool:cfg=>{config=cfg;return{getConnection:async()=>c,end:async()=>{}};}});
  assert.equal(config.connectionLimit,2);assert.equal(config.queueLimit,4);assert.equal(config.ssl.verifyIdentity,true);
  await pool.getConnection();await pool.getConnection();assert.equal(calls.filter(s=>s.startsWith('SET SESSION time_zone')).length,2);assert(!calls.some(s=>/GLOBAL/.test(s)));
  bad=true;await assert.rejects(pool.getConnection());bad=false;unsafe=true;await assert.rejects(pool.getConnection());assert.equal(destroyed,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('bootstrap is preview-only by default and contains synthetic core plus all eleven payment definitions',()=>{
 const B=require('../src/sandbox/bootstrap');assert.equal(B.statements.filter(s=>s.startsWith('CREATE TABLE paystack_ng_')).length,9);assert(B.statements.some(s=>s.includes('CREATE TABLE users')));assert(B.statements.some(s=>s.includes('CREATE TABLE user_roles')));assert(!B.statements.some(s=>/CREATE DATABASE|DROP|GLOBAL|INSERT.*SELECT/.test(s)));
 const cp=require('node:child_process');const r=cp.spawnSync(process.execPath,['scripts/paystackSandboxBootstrap.cjs'],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},windowsHide:true});assert.equal(r.status,0);assert.match(r.stdout,/Preview only/);
});
test('issuer drafts require fresh complete roster evidence and retain exact existing TTLs',()=>{
 const {draft,signReviewed}=require('../scripts/paystackSandboxApproval.cjs'),now=Date.now();
 const challenge={approvalMode:owner.approvalMode,identity:{service:'srv-fixture',generation:'boot',source:'offline',instance:'fixture'},challenge:'synthetic',sequence:0,syntheticScope:{subjectId:401,scholarId:301,seedDigest:'a'.repeat(64)}};
 assert.throws(()=>draft('writer',{...owner,challenge,observations:[]},now));
 const observations=require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS.map(entryPoint=>({entryPoint,checkedAt:now,conclusion:'legacy-only-or-absent',evidenceDigest:'b'.repeat(64)}));
 const w=draft('writer',{...owner,challenge,observations},now);assert.equal(w.value.expiresAt-now,300000);assert.equal(w.value.phase2aWriters,0);
 assert.throws(()=>draft('writer',{...owner,challenge,observations:observations.map(o=>({...o,checkedAt:now-300000}))},now));
 assert.throws(()=>draft('zero-review',{challenge,audit:{}},now));
 const a=draft('zero-history',{...owner,challenge},now);assert.deepEqual(a.facts,[]);assert.equal(a.sourceRevision,challenge.syntheticScope.seedDigest);
 const keys=crypto.generateKeyPairSync('ed25519');assert.throws(()=>signReviewed({...w,value:{...w.value,unknownWriters:1}},keys.privateKey));
});
test('authorization issuer reads only external Test credential files and emits digests, never their values',t=>{
 const {draft}=require('../scripts/paystackSandboxApproval.cjs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'psng-issuer-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const f=inputs();fs.writeFileSync(path.join(dir,'test'),f.secret,{mode:0o600});fs.writeFileSync(path.join(dir,'hook'),f.webhookSecret,{mode:0o600});
 const i={...owner,challenge:{approvalMode:owner.approvalMode,identity:f.identity,schemaDigest:require('../src/services/paystackNigeria/runtime').schemaDigest(),metadataDigest:'a'.repeat(64)},merchantAccount:'100043',callbackOrigin:'https://ui.example.invalid',testSecretFile:path.join(dir,'test'),webhookSecretFile:path.join(dir,'hook')};
 const a=draft('authorization',i);assert.equal(a.value.expiresAt-a.value.issuedAt,86400000);assert(!JSON.stringify(a).includes(f.secret));assert(!JSON.stringify(a).includes(f.webhookSecret));assert.equal(a.value.credentialDigest,require('../src/services/paystackNigeria/transportConfig').digest(f.secret));
 assert.throws(()=>draft('authorization',{...i,testSecretFile:__filename}));
});
