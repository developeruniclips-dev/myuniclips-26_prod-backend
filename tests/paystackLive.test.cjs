'use strict';
// Synthetic keys, inert transports and scripted connections only. No hosted IO.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const L=require('../src/services/paystackNigeria/liveConfiguration'),C=require('../src/services/paystackNigeria/transportConfig'),S=require('../src/services/paystackNigeria/liveSchema'),A=require('../src/services/paystackNigeria/liveApprovals');
function metadata(){const m=require('./fixtures/paystackNigeriaMetadata.cjs').metadata(false);for(const [table,keys]of Object.entries(S.unique)){m.tables[table]={engine:'InnoDB'};m.uniqueKeys[table]=structuredClone(keys);}m.checks=S.environmentTables.map(table=>({table,clause:"(`environment` = _utf8mb4'live')",enforced:'YES'}));return m;}
function fixture({patch={},envPatch={}}={}){
 const keys=crypto.generateKeyPairSync('ed25519'),secret=['sk','live',crypto.randomBytes(24).toString('hex')].join('_'),webhookSecret='whsec_'+crypto.randomBytes(24).toString('hex');
 const identity={service:'srv-fixture',generation:'fixture-boot',source:'a'.repeat(64),instance:'srv-fixture-instance'},m=metadata();
 const env={NODE_ENV:'production',PAYSTACK_NG_MODE:'live',PAYSTACK_NG_APPROVAL_MODE:L.MODE,PAYMENT_ARCHITECTURE:'legacy_verified',DB_HOST:'db.example.invalid',DB_PORT:'25060',DB_NAME:'live_fixture',DB_USER:'live_fixture_app',DB_SSL:'true',DB_SSL_CA:'inert-ca-path',FRONTEND_URL:'https://ui.example.invalid',ALLOWED_ORIGINS:'https://ui.example.invalid',PAYSTACK_NG_TEST_CHECKOUT:'disabled',PAYSTACK_NG_LIVE_CHECKOUT:'enabled',PAYSTACK_NG_VERIFICATION:'enabled',PAYSTACK_NG_WEBHOOKS:'enabled',PAYSTACK_NG_SECRET_KEY:secret,PAYSTACK_NG_WEBHOOK_SECRET:webhookSecret,...envPatch};
 const f={time:Date.now(),keys,identity,env,metadata:m,secret,webhookSecret};const now=()=>f.time;
 const body={approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:'e'.repeat(64),authorityFingerprint:L.hash(keys.publicKey.export({type:'spki',format:'der'})),kind:'paystack-ng-live-authorization-v1',version:1,environment:'live',entity:'UNICLIPS_NIGERIA_LIMITED',...identity,issuedAt:f.time,expiresAt:f.time+3600000,merchantAccount:'100043',credentialDigest:L.hash(secret),webhookCredentialDigest:L.hash(webhookSecret),webhookScheme:'timestamped-v1',callbackOrigin:env.FRONTEND_URL,schemaDigest:S.schemaDigest(),metadataDigest:L.hash(JSON.stringify(m)),auditDigest:'b'.repeat(64),feesAbsorbed:true,noAutomaticSplits:true,commercialTermsReviewed:true,payoutHoldAccepted:true,database:{host:env.DB_HOST,port:25060,name:env.DB_NAME,user:env.DB_USER},pilot:{buyerId:1,subjectId:10,scholarId:20},controls:{LIVE_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true},...patch};
 const sign=body=>{const payload=JSON.stringify(body);return {payload,signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('base64')};};
 Object.assign(f,{body,sign,now,authorization:sign(body)});f.config=()=>C.liveConfiguration({env,secret,webhookSecret,publicKey:keys.publicKey,authorization:f.authorization,identity,now});return f;
}
function writer(f,authorization=f.authorization,patch={}){return f.sign({approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:'e'.repeat(64),kind:'paystack-ng-live-writer-v1',version:1,environment:'live',mode:'legacy_verified',...f.identity,issuedAt:f.time,expiresAt:f.time+300000,authorizationDigest:L.hash(JSON.stringify(authorization)),phase2aWriters:0,unknownWriters:0,entryPoints:require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS,rosterEvidenceDigest:'d'.repeat(64),...patch});}
function packet(f,r,patch={}){const c=r.status();return f.sign({approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:'e'.repeat(64),kind:'paystack-ng-live-packet-v1',version:1,identity:c.identity,challenge:c.challenge,issuedAt:f.time,expiresAt:f.time+300000,sequence:c.sequence+1,authorization:f.authorization,writer:writer(f),...patch});}

test('Live requires its own owner protocol, sealed configuration, production isolation and explicit controls',()=>{
 const f=fixture(),config=f.config();assert.equal(config.environment,'live');assert.equal(config.testCheckout,false);assert(C.isConfiguration(config));assert(Object.isFrozen(config));config.assertScope(10,20,1);
 for(const patch of [{environment:'test'},{kind:'authorization'},{approvalMode:'single-owner-v1'},{ownerAuthorized:false},{evidenceDigest:''},{credentialDigest:'0'.repeat(64)},{webhookCredentialDigest:'0'.repeat(64)},{schemaDigest:''},{metadataDigest:''},{auditDigest:''},{database:{name:'other'}},{feesAbsorbed:false},{noAutomaticSplits:false},{commercialTermsReviewed:false},{payoutHoldAccepted:false},{pilot:{buyerId:20,subjectId:10,scholarId:20}},{generation:'old'},{instance:'old'},{source:'old'},{expiresAt:0},{expiresAt:Date.now()+172800000}])assert.throws(()=>fixture({patch}).config());
 for(const envPatch of [{NODE_ENV:'test'},{UNICLIPS_SANDBOX:'paystack-test-v1'},{SANDBOX_APPROVAL_MODE:'single-owner-v1'},{DB_NAME:'uniclipspsngsandbox'},{DB_USER:'doadmin'},{DB_SSL:'false'},{PAYMENT_ARCHITECTURE:'phase2a'},{PAYSTACK_NG_TEST_CHECKOUT:'enabled'},{PAYSTACK_NG_LIVE_CHECKOUT:'true'},{FRONTEND_URL:'https://sandbox.example.invalid'}])assert.throws(()=>fixture({envPatch}).config());
 assert.throws(()=>C.configuration({env:f.env}),{code:'PAYSTACK_LIVE_NOT_SUPPORTED'});assert.throws(()=>require('../src/services/paystackNigeria/policy').createPolicy({enabled:true,environment:'live',merchantAccount:'100043'}).assertEnabled());
});

test('wrong key type, Test credentials, expired controls, clock rollback and out-of-scope buyers fail closed',()=>{
 const f=fixture(),options={env:f.env,secret:f.secret,webhookSecret:f.webhookSecret,authorization:f.authorization,identity:f.identity,now:f.now};
 assert.throws(()=>C.liveConfiguration({...options,publicKey:crypto.generateKeyPairSync('rsa',{modulusLength:2048}).publicKey}));
 assert.throws(()=>C.liveConfiguration({...options,publicKey:f.keys.publicKey,secret:['sk','test',crypto.randomBytes(24).toString('hex')].join('_')}));
 for(const value of [NaN,Infinity,1.5])assert.throws(()=>C.liveConfiguration({...options,publicKey:f.keys.publicKey,now:()=>value}),{code:'PAYSTACK_LIVE_APPROVAL_EXPIRED_OR_MISMATCHED'});
 const config=f.config();for(const args of [[11,20,1],[10,21,1],[10,20,2]])assert.throws(()=>config.assertScope(...args));
 f.time+=3600000;assert.throws(()=>config.assert('verification'));f.time=NaN;assert.throws(()=>config.assert('verification'));f.time=0;assert.throws(()=>config.assert('verification'));
 const off=fixture({envPatch:{PAYSTACK_NG_LIVE_CHECKOUT:'disabled'}}).config();assert.throws(()=>off.assert('liveCheckout'));off.assert('verification');
});

test('public owner PEM is fingerprint-pinned Ed25519; private PEM and other algorithms are refused',()=>{
 const f=fixture(),pem=f.keys.publicKey.export({type:'spki',format:'pem'}),fp=L.hash(f.keys.publicKey.export({type:'spki',format:'der'}));assert.equal(L.ownerKey(pem,fp).asymmetricKeyType,'ed25519');
 for(const [value,h]of [[pem,'0'.repeat(64)],[f.keys.privateKey.export({type:'pkcs8',format:'pem'}),fp],['invalid',fp],[pem.repeat(100),fp]])assert.throws(()=>L.ownerKey(value,h));
});

test('Live schema proposal leaves Test definitions intact and rejects missing uniqueness or Test CHECKs',()=>{
 assert.equal(S.statements.length,11);assert.equal(require('../src/services/paystackNigeria/schema').statements.length,7);assert(require('../src/services/paystackNigeria/schema').statements.some(s=>s.includes("environment='test'")));assert(!S.statements.some(s=>/environment='test'/.test(s)));assert(S.statements.every(s=>/^CREATE TABLE /.test(s)&&!/\b(ALTER|DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b/.test(s)));
 S.requireLiveSchema(metadata());for(const mutate of [m=>delete m.tables.paystack_ng_transactions,m=>m.uniqueKeys.paystack_ng_orders=[],m=>m.checks[0].clause="environment='test'",m=>m.checks[0].enforced='NO',m=>m.checks=[]]){const m=metadata();mutate(m);assert.throws(()=>S.requireLiveSchema(m));}
});

test('Live writer requires fresh exact roster, owner review, boot identity and exact authorization digest',()=>{
 const f=fixture(),make=e=>A.writerPolicy({publicKey:f.keys.publicKey,identity:f.identity,readAttestation:()=>e,authorizationDigest:L.hash(JSON.stringify(f.authorization)),now:f.now});make(writer(f)).assertSafe();
 for(const p of [{environment:'test'},{kind:'writer'},{approvalMode:'single-owner-v1'},{ownerAuthorized:false},{generation:'old'},{phase2aWriters:1},{unknownWriters:1},{mode:'phase2a'},{entryPoints:[]},{entryPoints:[...require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS,'workers']},{authorizationDigest:'a'.repeat(64)},{rosterEvidenceDigest:''},{expiresAt:0}])assert.throws(()=>make(writer(f,f.authorization,p)).assertSafe());
 const w=make(writer(f));f.time+=300000;assert.throws(()=>w.assertSafe());
});

test('Live packets refuse absent approval, replay, duplicate inner signatures, cross-boot and changed authorization',()=>{
 const f=fixture();let creations=0;const create=()=>A.createReceiver({env:f.env,pool:{getConnection(){throw Error('No DB allowed');}},identity:f.identity,publicKey:f.keys.publicKey,metadata:f.metadata,now:f.now,createService:()=>{creations++;return {enabled:true};}}),r=create();
 assert.throws(()=>r.runtime());const first=packet(f,r);assert.equal(r.install(first).accepted,true);assert.equal(r.runtime().enabled,true);assert.equal(creations,1);assert.throws(()=>r.install(first));
 assert.throws(()=>r.install(packet(f,r,{writer:f.authorization})));assert.throws(()=>create().install(first));
 f.authorization=f.sign({...f.body,evidenceDigest:'f'.repeat(64)});assert.throws(()=>r.install(packet(f,r)),{code:'PAYSTACK_LIVE_AUTHORIZATION_RESTART_REQUIRED'});assert.equal(creations,1);f.time+=300000;assert.throws(()=>r.runtime());
});

test('Live initialization, verified entitlement, held allocation and replay use Live evidence only',async()=>{
 const f=fixture(),g=require('./fixtures/paystackTransport.cjs').fixture({configInput:f});g.state.verifyPatch={domain:'live',integration:f.body.merchantAccount};
 const o=await g.api.checkout(g.input);assert.equal(o.state,'ready');assert.equal(JSON.parse(g.calls[0].body.metadata).environment,'live');assert.equal(g.calls[0].body.amount,'150000');
 assert.equal((await g.api.quote(10,20)).checkoutEnabled,false);assert.equal((await g.api.quote(10,20,1)).checkoutMode,'live');
 assert.equal((await g.api.verify(o.orderId,1)).state,'fulfilled');assert.equal((await g.api.verify(o.orderId,1)).state,'fulfilled');assert.equal(g.store.state().purchases.length,1);assert.equal(g.store.state().allocations.length,1);assert.equal(g.store.state().allocations[0].scholarMinor,105000);assert.equal(g.store.state().allocations[0].payoutState,'held');assert.equal(g.verifications[0].receipt.environment,'live');
 for(const patch of [{domain:'test'},{currency:'EUR'},{amount:150001},{integration:123},{split:{id:1}}]){const h=require('./fixtures/paystackTransport.cjs').fixture({configInput:fixture()});h.state.verifyPatch={domain:'live',...patch};const order=await h.api.checkout(h.input);assert.equal((await h.api.verify(order.orderId,1)).state,'review');assert.equal(h.store.state().purchases.length,0);}
 const h=require('./fixtures/paystackTransport.cjs').fixture({configInput:fixture()});await assert.rejects(h.api.checkout({...h.input,buyerId:2}));assert.equal(h.calls.length,0);assert.equal(h.store.state().orders.length,0);
});

test('Live SQL inbox uses bound environment parameters and rejects a Test order before writes',async()=>{
 const f=fixture(),queries=[],config=f.config();let orderEnvironment='test';
 const db={async query(q,args){const sql=q.sql;queries.push({sql,args});if(sql.includes('time_zone'))return [[{zone:'+00:00'}]];if(sql.startsWith('SET '))return [[]];if(sql.includes('FROM paystack_ng_orders'))return [[{id:'synthetic',merchant_account:config.merchantAccount,environment:orderEnvironment,subject_id:10,scholar_id:20,buyer_id:1}]];if(sql.includes('FROM paystack_ng_events'))return [[]];if(sql.startsWith('INSERT INTO paystack_ng_events'))return [{affectedRows:1}];throw Error('Unexpected SQL');},async beginTransaction(){},async commit(){},async rollback(){},release(){},destroy(){}};
 const store=require('../src/services/paystackNigeria/transportStore').createTransportStore({pool:{getConnection:async()=>db},config});
 await assert.rejects(store.status('synthetic',1),{code:'PAYSTACK_ORDER_NOT_FOUND'});assert(!queries.some(q=>/^(INSERT|UPDATE)/.test(q.sql)));
 orderEnvironment='live';const event={reference:'synthetic',key:'a'.repeat(64),type:'charge.success',domain:'test',amount:150000,currency:'NGN',transactionId:'1',resourceId:'1',digest:'b'.repeat(64),claimsDigest:'c'.repeat(64),claims:{}};
 db.query=async(q,args)=>{queries.push({sql:q.sql,args});if(q.sql.includes('time_zone'))return [[{zone:'+00:00'}]];if(q.sql.startsWith('SET '))return [[]];if(q.sql.includes('FROM paystack_ng_orders'))return [[{id:'synthetic',merchant_account:config.merchantAccount,environment:'live',subject_id:10,scholar_id:20,buyer_id:1}]];if(q.sql.includes('FROM paystack_ng_events'))return [[]];return [{affectedRows:1}];};
 assert.equal((await store.recordEvent(event)).review,true);const insert=queries.find(q=>q.sql.startsWith('INSERT INTO paystack_ng_events'));assert.equal(insert.args[1],'live');assert(!queries.some(q=>q.sql.includes("environment='test'")));
});

test('Live database guard refuses unsafe grants, roles, sandbox markers and TLS before lease delivery',async()=>{
 const f=fixture(),R=require('../src/services/paystackNigeria/liveReadiness');
 async function check(patch={}){let destroyed=false;const db={async query(q){const s=q.sql;if(s.startsWith('SET '))return [[]];if(s.includes('CURRENT_USER'))return [[{db:'live_fixture',account:'live_fixture_app@%',effective_role:'NONE',partial_revokes:1,...patch.identity}]];if(s==='SHOW GRANTS')return [(patch.grants||['GRANT USAGE ON *.* TO "live_fixture_app"@"%"','GRANT SELECT, INSERT, UPDATE, DELETE ON "live_fixture".* TO "live_fixture_app"@"%"']).map(x=>({g:x}))];if(s.includes('Ssl_cipher'))return [[{Value:patch.cipher??'TLS_AES_256_GCM_SHA384'}]];if(s.includes('Ssl_version'))return [[{Value:'TLSv1.3'}]];if(s.includes('sandbox_manifest'))return [patch.marker?[{}]:[]];throw Error('Unexpected SQL');},destroy(){destroyed=true;}};
  const pool=R.guardedPool({pool:{getConnection:async()=>db},env:f.env,buildPoolConfig:()=>({ssl:{rejectUnauthorized:true,verifyIdentity:true}})});try{await pool.getConnection();return true;}catch(e){assert(destroyed);throw e;}}
 assert.equal(await check(),true);for(const p of [{identity:{db:'other'}},{identity:{effective_role:'admin'}},{grants:['GRANT ALL PRIVILEGES ON *.* TO x']},{grants:['GRANT SELECT ON other.* TO x']},{grants:['GRANT SELECT ON live_fixture.* TO x WITH GRANT OPTION']},{grants:['GRANT CREATE ON live_fixture.* TO x']},{marker:true},{cipher:''}])await assert.rejects(check(p));
 assert.throws(()=>R.guardedPool({pool:{},env:f.env,buildPoolConfig:()=>({ssl:{rejectUnauthorized:false,verifyIdentity:true}})}));
});

test('owner signing cannot substitute Test kinds or another owner key; no Live zero-history command exists',()=>{
 const f=fixture(),cli=require('../scripts/paystackLiveApproval.cjs'),fp=L.hash(f.keys.publicKey.export({type:'spki',format:'der'}));
 const signed=cli.signReviewed({kind:'authorization',value:{...f.body,authorityFingerprint:fp}},f.keys.privateKey,f.time);assert.equal(L.signed(signed,f.keys.publicKey).environment,'live');
 assert.throws(()=>cli.signReviewed({kind:'authorization',value:f.body},crypto.generateKeyPairSync('ed25519').privateKey,f.time));assert.throws(()=>cli.signReviewed({kind:'authorization',value:{...f.body,kind:'authorization'}},f.keys.privateKey,f.time));
 const r=A.createReceiver({env:f.env,pool:{},identity:f.identity,publicKey:f.keys.publicKey,metadata:f.metadata,now:f.now,createService:()=>({})});const input={approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:'e'.repeat(64),challenge:r.status(),authorization:f.authorization};assert.throws(()=>cli.draft('zero-history',input,f.time));
 const points=require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS,observations=points.map(entryPoint=>({entryPoint,conclusion:'legacy-only-or-absent',checkedAt:f.time,evidenceDigest:'d'.repeat(64)}));assert.equal(cli.draft('writer',{...input,observations},f.time).value.environment,'live');assert.throws(()=>cli.draft('writer',{...input,observations:observations.map(x=>({...x,checkedAt:f.time-300001}))},f.time));
});

test('Live history rejects Test evidence and a different reviewed baseline without provider access',async()=>{
 const f=fixture(),R=require('../src/services/paystackNigeria/liveReadiness'),H=require('../src/services/coursePayments/historicalResolver');
 const audit={subject_id:10,scholar_id:20,review_version:1,baseline_count:0,baseline_digest:H.digest([]),source_revision:'synthetic-reviewed',review_id:crypto.randomUUID(),writer_mode:'legacy_verified',state:'approved'};
 const config={...f.config(),auditDigest:R.auditDigest(audit)},db={query:async sql=>[sql.includes('course_sale_audits')?[audit]:[]]};assert.deepEqual(await R.historicalResolver(config)(db,[],{subjectId:10,scholarId:20}),[]);
 await assert.rejects(R.historicalResolver({...config,auditDigest:'a'.repeat(64)})(db,[],{subjectId:10,scholarId:20}),{code:'PAYSTACK_LIVE_HISTORY_REVIEW_REQUIRED'});
 const fact={purchase_id:1,subject_id:10,scholar_id:20,sale_ordinal:1,provider:'paystack',entity:'UNICLIPS_NIGERIA_LIMITED',merchant_account:f.body.merchantAccount,environment:'test',provider_reference:'synthetic-test-sale',currency:'NGN',gross_minor:150000,scholar_rate:70,scholar_minor:105000,source_kind:'paystack_ng',source_key:'synthetic-proof',evidence_digest:'d'.repeat(64),provider_transaction_id:'1'};
 const testAudit={...audit,baseline_count:1,baseline_digest:H.digest([fact])};
 await assert.rejects(R.historicalResolver({...config,auditDigest:R.auditDigest(testAudit)})({query:async sql=>[sql.includes('course_sale_audits')?[testAudit]:[fact]]},[],{subjectId:10,scholarId:20}),{code:'PAYSTACK_LIVE_HISTORY_REVIEW_REQUIRED'});
});

test('Live charge.success is signature checked, verified once, and replay cannot duplicate access or earnings',async()=>{
 const T=require('./fixtures/paystackTransport.cjs'),f=fixture(),g=T.fixture({configInput:f});g.state.verifyPatch={domain:'live',integration:f.body.merchantAccount};
 await g.api.checkout(g.input);const order=g.store.state().orders[0];
 const raw=Buffer.from(JSON.stringify({event:'charge.success',data:T.response(order,undefined,{domain:'live',integration:f.body.merchantAccount}).data}));
 await assert.rejects(g.api.webhook(raw,{}),{code:'PAYSTACK_INVALID_SIGNATURE'});assert.equal(g.events.size,0);
 assert.equal((await g.api.webhook(raw,T.signature(raw,f))).state,'processed');assert.equal((await g.api.webhook(raw,T.signature(raw,f))).state,'processed');
 assert.equal(g.store.state().purchases.length,1);assert.equal(g.store.state().allocations.length,1);assert.equal(g.store.state().allocations[0].payoutState,'held');
 const other=T.fixture({configInput:fixture()});other.state.verifyPatch={domain:'live'};await other.api.checkout(other.input);
 const bad=Buffer.from(JSON.stringify({event:'charge.success',data:T.response(other.store.state().orders[0]).data}));
 assert.equal((await other.api.webhook(bad,T.signature(bad,other.configInput))).state,'review');assert.equal(other.store.state().purchases.length,0);
});

test('Live startup defers validation into safe failure handling and approval routes retain both auth gates',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../src/services/paystackNigeria/liveRuntime.js'),'utf8');
 const f=fixture();f.env.RENDER_SERVICE_ID='srv-fixture';f.env.RENDER_INSTANCE_ID='srv-fixture-instance';f.env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM=f.keys.publicKey.export({type:'spki',format:'pem'});f.env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256=L.hash(f.keys.publicKey.export({type:'spki',format:'der'}));
 let databaseReads=0;const routes=[],app={get:(p,...chain)=>routes.push({p,chain}),post:(p,...chain)=>routes.push({p,chain})},module={exports:{}};
 vm.runInNewContext(source,{module,Buffer,URL,require(name){
  if(name==='node:crypto')return crypto;if(name==='./liveConfiguration')return L;
  if(name==='./liveReadiness')return {metadata:async()=>{databaseReads++;return f.metadata;},guardedPool:()=>({})};
  if(name==='../../sandbox/isolation')return {sourceDigest:()=>f.identity.source};if(name==='./liveApprovals')return A;
  if(name==='../../middleware/auth')return {authMiddleware:(req,res,next)=>req.actor?next():res.status(401).json({code:'AUTH_REQUIRED'})};
  if(name==='../../middleware/roles')return {authorizeRoles:role=>{assert.equal(role,'SuperAdmin');return (req,res,next)=>req.actor===role?next():res.status(403).json({code:'ROLE_REQUIRED'});}};
  if(name==='express-rate-limit')return {rateLimit:opts=>{assert.equal(opts.limit,10);return (_req,_res,next)=>next();}};
  throw Error('Unexpected dependency');
 }});
 const M=module.exports;assert.equal(routes.length,0);await M.mount(app,{env:{},pool:{}}).initialize();assert.equal(routes.length,0);assert.equal(databaseReads,0);
 const call=actor=>{let status=200,body;const res={status:n=>(status=n,res),json:value=>(body=value,res)},req={actor};let n=0;const next=()=>routes[0].chain[n++]?.(req,res,next);next();return {status,body};};
 const control=M.mount(app,{env:f.env,pool:{}});assert.equal(routes.length,2);assert.equal(databaseReads,0);
 assert.equal(call(null).status,401);assert.equal(call('Scholar').status,403);assert.deepEqual(call('SuperAdmin').status,503);
 await control.initialize();assert.equal(databaseReads,1);assert.equal(call('SuperAdmin').body.approvalMode,L.MODE);assert.throws(()=>control.runtime(),{code:'PAYSTACK_LIVE_APPROVAL_REQUIRED'});
 const canary='SENSITIVE_CONTENT_MUST_NEVER_BE_SERIALIZED',invalid=M.mount(app,{env:{...f.env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:canary},pool:{}});
 await assert.rejects(invalid.initialize(),e=>M.safeCode(e)==='PAYSTACK_LIVE_OWNER_KEY_REQUIRED'&&!JSON.stringify({code:M.safeCode(e)}).includes(canary));assert.equal(databaseReads,1);
 assert.equal(M.safeCode({code:canary,message:canary,stack:canary}),'PAYSTACK_LIVE_NOT_READY');
});

module.exports={fixture,metadata,writer,packet};
