'use strict';
// Only the existing nonce-labelled, network-none disposable runner may invoke.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net'),dns=require('node:dns');
assert(process.argv.includes('--owned-phase2d'));
const input=JSON.parse(fs.readFileSync(0,'utf8'));assert.equal(input.database,'uniclipspsngsandbox');assert(/^[a-f0-9]{12}$/.test(input.nonce));assert(/^[a-f0-9]{64}$/.test(input.container));assert.equal(process.version,'v22.23.3');
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0],host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';if(!['localhost','127.0.0.1','::1'].includes(host))throw Error('EXTERNAL_SOCKET_FORBIDDEN');return connect.apply(this,args);};
dns.lookup=function(h,o,c){if(typeof o==='function')c=o;if(!['localhost','127.0.0.1','::1'].includes(h))throw Error('EXTERNAL_DNS_FORBIDDEN');queueMicrotask(()=>c(null,'127.0.0.1',4));};
process.env.NODE_PATH='/deps/node_modules';require('node:module').Module._initPaths();
const mysql=require('/deps/node_modules/mysql2/promise'),B=require('../src/sandbox/bootstrap'),{createSandboxPool}=require('../src/sandbox/database'),{createApprovalReceiver}=require('../src/sandbox/approvals'),{digest}=require('../src/services/paystackNigeria/transportConfig');
assert.equal(require('/deps/node_modules/mysql2/package.json').version,'3.24.6');
const cert=new crypto.X509Certificate(input.certificate);assert.equal(cert.fingerprint256,input.fingerprint);
const host=cert.subject.match(/(?:^|\n)CN=(.+)/)[1];
const tls=require('../src/config/databaseTls').buildPoolConfig({NODE_ENV:'test',DB_HOST:host,DB_PORT:'3306',DB_USER:'root',DB_PASS:String(input.password),DB_NAME:input.database,DB_SSL:'true',DB_SSL_CA:'synthetic'},()=>Buffer.from(input.ca.replace(/\0+$/,'')));
const admin=mysql.createPool({...tls,connectionLimit:2,stream:()=>net.connect(3306,'127.0.0.1')});
const authority=crypto.generateKeyPairSync('ed25519');
const owner={approvalMode:'single-owner-v1',ownerAuthorized:true,evidenceDigest:'a'.repeat(64)};
const publicKey=authority.publicKey.export({type:'spki',format:'pem'});
const sign=(p,k=authority.privateKey)=>{const payload=JSON.stringify(p);return{payload,signature:crypto.sign(null,Buffer.from(payload),k).toString('base64')};};
const f=require('./fixtures/paystackTransport.cjs').inputs();
const pwd=crypto.randomBytes(32).toString('hex');
const environment={SANDBOX_APPROVAL_MODE:'single-owner-v1',UNICLIPS_SANDBOX:'paystack-test-v1',NODE_ENV:'test',DB_HOST:host,DB_PORT:'3306',DB_USER:'psngsandboxmigrator',DB_PASS:pwd,DB_NAME:input.database,DB_SSL:'true',DB_SSL_CA:'synthetic',FRONTEND_URL:'https://ui.example.invalid',ALLOWED_ORIGINS:'https://ui.example.invalid',PAYMENT_ARCHITECTURE:'legacy_verified',...f.env,PAYSTACK_NG_SECRET_KEY:f.secret,PAYSTACK_NG_WEBHOOK_SECRET:f.webhookSecret,JWT_SECRET:String(crypto.randomBytes(48).toString('hex'))};
const createPool=cfg=>mysql.createPool({...cfg,stream:()=>net.connect(3306,'127.0.0.1')});
const report={started:new Date().toISOString(),tests:[],inputs:{node:process.version,mysql2:'3.24.6'}};
async function test(name,work){try{await work();report.tests.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){report.tests.push({name,status:'FAIL',code:e.code,message:e.message,stack:e.stack});console.log('FAIL '+name+' '+e.code+' '+e.message);}}
let migrator,pool,receiver,server;
(async()=>{
 await admin.query('CREATE USER ? IDENTIFIED BY ?',['psngsandboxmigrator',pwd]);await admin.query('CREATE USER ? IDENTIFIED BY ?',['psngsandboxapp',pwd]);
 await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,ALTER,INDEX,REFERENCES,DROP ON uniclipspsngsandbox.* TO psngsandboxmigrator');
 await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON uniclipspsngsandbox.* TO psngsandboxapp');
 migrator=createSandboxPool({env:environment,createPool,readCA:()=>Buffer.from(input.ca.replace(/\0+$/,'')),requireMarker:false});
 const password=crypto.randomBytes(24).toString('hex'),passwordHash=await require('../src/utils/passwordHasher').hashPassword(password);
 const seed={seedId:crypto.randomUUID(),merchantAccount:'100043',buyerEmail:'synthetic-buyer@example.invalid',scholarEmail:'synthetic-scholar@example.invalid',buyerHash:passwordHash,scholarHash:passwordHash};
 const seedDigest=digest(JSON.stringify(seed)),source=require('../src/sandbox/isolation').sourceDigest();
 const approval={...owner,kind:'sandbox-owner-bootstrap-v1',host,database:input.database,source,seedDigest,schemaDigest:B.schemaDigest(),issuedAt:Date.now(),expiresAt:Date.now()+300000};
 await test('approved synthetic empty-database bootstrap creates all core and eleven payment tables; no zero audit is invented',async()=>{
  await assert.rejects(B.bootstrap({pool:migrator,seed,publicKey,envelope:sign({...approval,database:'production'}),source}));
  const result=await B.bootstrap({pool:migrator,seed,publicKey,envelope:sign(approval),source});assert.equal(result.subjectId,401);
  const [[n]]=await admin.query('SELECT COUNT(*) AS n FROM course_sale_audits');assert.equal(Number(n.n),0);
  await assert.rejects(B.bootstrap({pool:migrator,seed,publicKey,envelope:sign(approval),source}),{code:'SANDBOX_BOOTSTRAP_EMPTY_DATABASE_REQUIRED'});
 });
 environment.DB_USER='psngsandboxapp';Object.assign(process.env,environment);
 pool=createSandboxPool({env:process.env,createPool,readCA:()=>Buffer.from(input.ca.replace(/\0+$/,''))});
 await test('two-connection pool initializes UTC on reused leases, preserves server global zone and denies other schemas/DDL',async()=>{
  const [[before]]=await admin.query('SELECT @@GLOBAL.time_zone AS z');let c=await pool.getConnection();await c.query("SET SESSION time_zone='+01:00'");c.release();c=await pool.getConnection();const [[r]]=await c.query('SELECT @@session.time_zone AS z');assert.equal(r.z,'+00:00');c.release();const [[after]]=await admin.query('SELECT @@GLOBAL.time_zone AS z');assert.equal(after.z,before.z);
  await admin.query('CREATE DATABASE forbiddenfixture');await admin.query('CREATE TABLE forbiddenfixture.private_data(id INT PRIMARY KEY)');await assert.rejects(pool.query('SELECT * FROM forbiddenfixture.private_data'));await assert.rejects(pool.query('CREATE TABLE forbidden(id INT)'));assert.equal(pool.config.connectionLimit,2);
 });
 const id={service:'srv-synthetic',generation:crypto.randomUUID(),source,instance:'synthetic-instance'};
 const metadata=await B.metadata(pool);
 receiver=createApprovalReceiver({env:process.env,identity:id,publicKey,metadata});
 const file=require.resolve('../src/config/db');require.cache[file]={id:file,filename:file,loaded:true,exports:{pool}};
 const app=require('../src/sandbox/app').createSandboxApp({pool,receiver,publicKey,origin:environment.FRONTEND_URL});
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base='http://127.0.0.1:'+server.address().port;
 const request=async(p,body,token)=>{const r=await fetch(base+p,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
 await test('sandbox startup composition authenticates with existing password/session checks without importing Stripe',async()=>{
  assert.equal((await request('/api/course-payments/history')).status,401);assert.equal((await request('/api/purchases/create-checkout-session',{})).status,404);assert.equal((await request('/webhook',{})).status,404);
  const login=await request('/api/auth/login',{email:seed.buyerEmail,password});assert.equal(login.status,200);assert(login.body.token);report.token=login.body.token;
  assert(!Object.keys(require.cache).some(p=>/config[\\/]stripe\.js$/.test(p)));
  assert.equal((await request('/api/course-payments/status/stripe:abc',undefined,report.token)).status,503);
  assert.equal((await request('/api/course-payments/status/stripe%3Aabc',undefined,report.token)).status,503);
 });
 let auth,writer,packet;
 await test('post-boot signed packets install without restart; replay, invalid signatures and rosters fail closed',async()=>{
  const challenge=receiver.status();auth=sign({...owner,...JSON.parse(f.authorization.payload),...id,schemaDigest:challenge.schemaDigest,metadataDigest:challenge.metadataDigest});
  writer=sign({...owner,version:1,mode:'legacy_verified',environment:'test',...id,issuedAt:Date.now(),expiresAt:Date.now()+300000,phase2aWriters:0,unknownWriters:0,entryPoints:require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS});
  packet={...owner,kind:'sandbox-owner-approvals-v1',version:1,identity:id,challenge:challenge.challenge,sequence:1,issuedAt:Date.now(),expiresAt:Date.now()+300000,authorization:auth,writer};
  assert.equal((await request('/sandbox/approvals',sign({...packet,writer:sign({...JSON.parse(writer.payload),phase2aWriters:1})}))).status,503);
  assert.equal((await request('/sandbox/approvals',sign(packet))).status,200);assert.equal((await request('/sandbox/approvals',sign(packet))).status,503);
 });
 await test('zero history requires one explicit owner authorization and exact seed; atomic empty-state guard refuses replay',async()=>{
  const p={...owner,kind:'sandbox-owner-zero-v1',version:1,identity:id,challenge:receiver.status().challenge,issuedAt:Date.now(),expiresAt:Date.now()+300000,seedDigest,subjectId:401,scholarId:301,reviewVersion:1,reviewId:crypto.randomUUID(),sourceRevision:seedDigest,writerMode:'legacy_verified',facts:[]};
  assert.equal((await request('/sandbox/zero-history',{authorization:sign({...p,ownerAuthorized:false})})).status,503);
  assert.equal((await request('/sandbox/zero-history',{authorization:sign(p)})).status,200);
  assert.notEqual((await request('/sandbox/zero-history',{authorization:sign(p)})).status,200);
 });
 await test('synthetic browser course/catalogue and authenticated access checks use NG policy without Stripe or video provider',async()=>{
  const catalogue=await request('/api/videos/all-videos');assert.equal(catalogue.status,200);assert.equal(catalogue.body.videos.length,2);assert.equal(catalogue.body.videos[0].payment.currency,'NGN');
  assert.equal((await request('/api/videos/courses/401/301',undefined,report.token)).status,200);
 });
 // Direct inert transport, with the SAME signed files/real store/pool as HTTP.
 await test('verified synthetic transaction grants one five-month entitlement, ordinal 1 and held 105000-kobo allocation; duplicate/replay safe',async()=>{
  const config=require('../src/services/paystackNigeria/transportConfig').configuration({env:process.env,secret:f.secret,webhookSecret:f.webhookSecret,publicKey,authorization:auth,identity:id});
  const writerPolicy=require('../src/services/coursePayments/writerPolicy').createWriterPolicy({publicKey,identity:id,mode:()=>environment.PAYMENT_ARCHITECTURE,readAttestation:()=>JSON.parse(fs.readFileSync(receiver.files.writer,'utf8'))});
  const store=require('../src/services/paystackNigeria/store').createMysqlStore({pool,schemaMetadata:metadata,resolveHistoricalSales:require('../src/services/coursePayments/historicalResolver').resolveHistoricalSales});
  let posts=0;
  const transport=async(method,_path,_auth,body)=>{if(method==='POST'){posts++;return{data:{status:true,data:{authorization_url:'https://checkout.paystack.com/synthetic',access_code:'synthetic',reference:body.reference}},digest:digest('synthetic-init')};}const [rows]=await pool.query('SELECT id FROM paystack_ng_orders');const o=await store.readOrder(rows[0].id);return{data:require('./fixtures/paystackTransport.cjs').response(o,seed.buyerEmail),digest:digest('synthetic-verified')};};
  const api=require('../src/services/paystackNigeria/checkoutService').createCheckoutService({config,pool,ledgerStore:store,writerPolicy,transport});
  const requestKey=crypto.randomUUID(),o=await api.checkout({subjectId:401,scholarId:301,buyerId:302,idempotencyKey:requestKey});assert.equal((await api.verify(o.orderId,302)).state,'fulfilled');await api.verify(o.orderId,302);await api.checkout({subjectId:401,scholarId:301,buyerId:302,idempotencyKey:requestKey});
  const [[a]]=await pool.query('SELECT * FROM paystack_ng_allocations');assert.equal(Number(a.sale_ordinal),1);assert.equal(Number(a.scholar_minor),105000);assert.equal(a.payout_state,'held');assert.equal(posts,1);
  const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM subject_purchases');assert.equal(Number(n.n),1);await assert.rejects(api.checkout({subjectId:401,scholarId:301,buyerId:302,idempotencyKey:crypto.randomUUID()}));
  const [[p]]=await pool.query('SELECT *,access_expires_at=DATE_ADD(created_at, INTERVAL 5 MONTH) AS five_months FROM subject_purchases');assert.equal(Number(p.five_months),1);
  const [[payout]]=await pool.query('SELECT COUNT(*) AS n FROM scholar_payouts');assert.equal(Number(payout.n),0);
 });
 await test('actual separate start command performs TLS/database bootstrap checks and resets stale approval paths on every boot',async()=>{
  fs.writeFileSync('/tmp/sandbox-ca.pem',input.ca.replace(/\0+$/,''));fs.writeFileSync('/tmp/sandbox-public.pem',publicKey);
  Object.assign(process.env,{DB_SSL_CA:'/tmp/sandbox-ca.pem',PAYSTACK_NG_AUTHORITY_PUBLIC_KEY:'/tmp/sandbox-public.pem',RENDER_SERVICE_ID:'srv-synthetic',RENDER_INSTANCE_ID:'fixture-instance',PORT:'0'});
  const original=mysql.createPool;mysql.createPool=cfg=>original({...cfg,stream:()=>net.connect(3306,'127.0.0.1')});
  let started;
  try{started=await require('../src/sandbox/start.cjs').start();assert.notEqual(started.receiver.status().identity.generation,id.generation);assert(!fs.existsSync(process.env.PAYSTACK_NG_AUTHORIZATION));assert.equal(started.pool.config.connectionLimit,2);assert(!Object.keys(require.cache).some(p=>/config[\\/]stripe\.js$/.test(p)));}
  finally{mysql.createPool=original;if(started)await started.close();}
 });
 delete report.token;
})().catch(e=>{report.fatal={code:e.code,message:e.message,stack:e.stack};process.exitCode=1;}).finally(async()=>{
 if(server)await new Promise(r=>server.close(r));receiver?.close();for(const p of [pool,migrator,admin])if(p)await p.end();delete report.token;
 report.completed=new Date().toISOString();report.passed=report.tests.filter(t=>t.status==='PASS').length;report.failed=report.tests.filter(t=>t.status==='FAIL').length;
 fs.writeFileSync('/evidence/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failed:report.failed,fatal:report.fatal}));if(report.failed)process.exitCode=1;
});
