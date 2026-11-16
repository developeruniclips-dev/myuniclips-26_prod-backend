'use strict';
// Disposable loopback MySQL only. Synthetic Live signatures; inert provider.
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto'),a=require('assert/strict');
// Pin the synthetic pilot clock so the November payment fixture is reproducible
// beyond its five-month term. This test process never uses a live service.
Date.now=()=>Date.UTC(2026,10,17,12,0,0);
const source=process.env.PAYSTACK_REDELIVERY_BASELINE==='1'?path.resolve(__dirname,'../../../course-visibility-backend'):path.resolve(__dirname,'../..');
const mysql=require('mysql2/promise'),H=require(path.join(source,'src/services/coursePayments/historicalResolver'));
const {createMysqlStore}=require(path.join(source,'src/services/paystackNigeria/store'));
const {createCheckoutService}=require(path.join(source,'src/services/paystackNigeria/checkoutService'));
const {createTransportStore}=require(path.join(source,'src/services/paystackNigeria/transportStore'));
const C=require(path.join(source,'src/services/paystackNigeria/transportConfig')),L=require(path.join(source,'src/services/paystackNigeria/liveConfiguration'));
const schema=require(path.join(source,'src/services/paystackNigeria/liveSchema'));
const {response}=require('./paystackTransport.cjs');
async function metadata(pool){
 const [ts]=await pool.query('SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE()');
 const [cs]=await pool.query('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,NUMERIC_PRECISION,NUMERIC_SCALE,CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
 const [ks]=await pool.query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX');
 const [checks]=await pool.query('SELECT t.TABLE_NAME AS table_name,c.CHECK_CLAUSE,t.ENFORCED FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.CONSTRAINT_TYPE=?',['CHECK']);
 const m={tables:{},columns:{},uniqueKeys:{},indexes:{},stripeCounterPresent:false,checks:checks.map(c=>({table:c.table_name,clause:c.CHECK_CLAUSE,enforced:c.ENFORCED}))};
 for(const r of ts)m.tables[r.TABLE_NAME]={engine:r.ENGINE};
 for(const r of cs)m.columns[r.TABLE_NAME+'.'+r.COLUMN_NAME]={type:r.DATA_TYPE,unsigned:r.COLUMN_TYPE.includes('unsigned'),nullable:r.IS_NULLABLE==='YES',precision:Number(r.NUMERIC_PRECISION),scale:Number(r.NUMERIC_SCALE),length:Number(r.CHARACTER_MAXIMUM_LENGTH)};
 const groups=new Map();for(const r of ks){const key=r.TABLE_NAME+':'+r.INDEX_NAME;if(!groups.has(key))groups.set(key,{table:r.TABLE_NAME,unique:Number(r.NON_UNIQUE)===0,cols:[]});groups.get(key).cols.push(r.COLUMN_NAME);}
 for(const r of groups.values()){(m.indexes[r.table]||=[]).push(r.cols);if(r.unique)(m.uniqueKeys[r.table]||=[]).push(r.cols);}return schema.requireLiveSchema(m);
}
async function database(){
 a.equal(process.env.PAYSTACK_REDELIVERY_ISOLATED_TEST,'1');
 const net=require('net'),connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0],host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';a(['127.0.0.1','::1','localhost'].includes(host),'Fixture network is loopback only');return connect.apply(this,args);};
 const name='uniclips_redelivery_test_'+crypto.randomBytes(6).toString('hex');a(/^uniclips_redelivery_test_[a-f0-9]{12}$/.test(name));
 const options={host:'127.0.0.1',port:33317,user:'root',password:'',timezone:'Z',supportBigNumbers:true,bigNumberStrings:true};
 const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE '+name);const pool=mysql.createPool({...options,database:name,connectionLimit:10,queueLimit:30});
 pool.on('connection',c=>c.query("SET time_zone='+00:00'"));
 const fixture=fs.readFileSync(path.join(__dirname,'../paystackNigeria.phase2d.mysql.cjs'),'utf8');
 const definitions=fixture.slice(fixture.indexOf('const options='),fixture.indexOf('async function metadata()'));
 const core=vm.runInNewContext(definitions+';({core,options})');
 for(const ddl of core.core)await pool.query('CREATE TABLE '+ddl+' '+core.options);
 await pool.query("INSERT INTO countries VALUES(2,'Synthetic Nigeria','NG')");await pool.query("INSERT INTO universities VALUES(2,'Fixture NG University','FNG',2)");
 await pool.query("INSERT INTO users(id,fname,lname,email) VALUES(14,'Synthetic','Buyer','buyer14@example.invalid'),(15,'Synthetic','Buyer','buyer15@example.invalid'),(50,'Synthetic','Scholar','scholar50@example.invalid')");
 await pool.query("INSERT INTO scholar_profile VALUES(50,'Fixture NG University (FNG)','Engineering',1,NULL)");
 for(const ddl of schema.statements)await pool.query(ddl);
 const visibility=require('./courseWorkflowSchema.cjs').split('CREATE TABLE course_workflows')[0];
 for(const sql of visibility.split(';').map(s=>s.replace(/--[^\n]*/g,'').trim()).filter(Boolean))await pool.query(sql);
 const meta=await metadata(pool);let sequence=4000;
 async function scope(){const subjectId=++sequence,scholarId=50;
  await pool.query("INSERT INTO subjects VALUES(?,'Synthetic pilot',2,'Engineering',6)",[subjectId]);
  const [offer]=await pool.query("INSERT INTO scholar_subjects(subject_id,scholar_user_id,approved) VALUES(?,50,1)",[subjectId]);
  await pool.query("INSERT INTO course_workflows VALUES(?,'PUBLISHED')",[offer.insertId]);await pool.query("INSERT INTO videos(subject_id,scholar_user_id,approved,title) VALUES(?,50,1,'Synthetic lesson')",[subjectId]);
  await pool.query("INSERT INTO paystack_ng_offerings(subject_id,scholar_id,merchant_account,environment,policy_version,approved) VALUES(?,50,'100043','live','paystack-ng-course-1500-v1',1)",[subjectId]);
  const keys=crypto.generateKeyPairSync('ed25519'),payload=JSON.stringify({subjectId,scholarId,reviewVersion:1,reviewId:crypto.randomUUID(),sourceRevision:'synthetic-redelivery-fixture',writerMode:'legacy_verified',facts:[]});
  await H.createAuditImporter({pool,publicKey:keys.publicKey,verifyProvenance:async()=>false})({payload,signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('base64')});
  return {subjectId,scholarId,offeringId:offer.insertId};
 }
 return {pool,meta,scope,async close(){await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}};
}
function configuration(sc,meta){
 const keys=crypto.generateKeyPairSync('ed25519'),secret=['sk','live',crypto.randomBytes(24).toString('hex')].join('_'),webhookSecret='whsec_'+crypto.randomBytes(24).toString('hex'),time=Date.now();
 const identity={service:'srv-synthetic',generation:'synthetic-redelivery',source:'a'.repeat(64),instance:'srv-synthetic-instance'};
 const env={NODE_ENV:'production',PAYSTACK_NG_MODE:'live',PAYSTACK_NG_APPROVAL_MODE:L.MODE,PAYMENT_ARCHITECTURE:'legacy_verified',DB_HOST:'fixture.example.invalid',DB_PORT:'25060',DB_NAME:'synthetic_live',DB_USER:'synthetic_app',DB_SSL:'true',DB_SSL_CA:'unused-synthetic',FRONTEND_URL:'https://ui.example.invalid',ALLOWED_ORIGINS:'https://ui.example.invalid',PAYSTACK_NG_TEST_CHECKOUT:'disabled',PAYSTACK_NG_LIVE_CHECKOUT:'enabled',PAYSTACK_NG_VERIFICATION:'enabled',PAYSTACK_NG_WEBHOOKS:'enabled'};
 const body={approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:'e'.repeat(64),kind:'paystack-ng-live-authorization-v1',version:1,environment:'live',entity:'UNICLIPS_NIGERIA_LIMITED',...identity,issuedAt:time,expiresAt:time+3600000,merchantAccount:'100043',credentialDigest:L.hash(secret),webhookCredentialDigest:L.hash(webhookSecret),webhookScheme:'timestamped-v1',callbackOrigin:env.FRONTEND_URL,schemaDigest:schema.schemaDigest(),metadataDigest:L.hash(JSON.stringify(meta)),auditDigest:'b'.repeat(64),feesAbsorbed:true,noAutomaticSplits:true,commercialTermsReviewed:true,payoutHoldAccepted:true,database:{host:env.DB_HOST,port:25060,name:env.DB_NAME,user:env.DB_USER},pilot:{buyerId:14,subjectId:sc.subjectId,scholarId:sc.scholarId},controls:{LIVE_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true}};
 const payload=JSON.stringify(body),config=C.liveConfiguration({env,secret,webhookSecret,publicKey:keys.publicKey,authorization:{payload,signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('base64')},identity});
 return {config,sign(raw,t=Math.floor(Date.now()/1000)){return {'paystack-signature':`t=${t},v1=whk_synthetic:${crypto.createHmac('sha512',webhookSecret).update(t+'.').update(raw).digest('hex')}`};}};
}
function brokenPool(pool,{afterWrite,afterCommit}={}){let fired=false;return {async getConnection(){const c=await pool.getConnection();let target=false;return new Proxy(c,{get(t,k){if(k==='query')return async(sql,args)=>{const text=typeof sql==='string'?sql:sql.sql,result=await t.query(sql,args);if(text.includes('INSERT INTO subject_purchases'))target=true;if(afterCommit==='event'&&text.startsWith('UPDATE paystack_ng_events'))target=true;if(!fired&&afterWrite&&text.includes(afterWrite)){fired=true;throw Error('SYNTHETIC_AFTER_WRITE');}return result;};if(k==='commit')return async()=>{await t.commit();if(!fired&&afterCommit&&target){fired=true;throw Error('SYNTHETIC_LOST_COMMIT_ACK');}};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};}
async function workflow(db,{ledgerPool=db.pool,transportPool=db.pool}={}){
 const sc=await db.scope(),f=configuration(sc,db.meta),state={patch:{},records:new Map(),calls:[],failVerify:false};
 const store=pool=>createMysqlStore({pool,schemaMetadata:db.meta,resolveHistoricalSales:H.resolveHistoricalSales});
 const transport=async(method,url,auth,body)=>{
  state.calls.push({method,url});if(method==='POST'){
   a.equal(url,'/transaction/initialize');const [[r]]=await db.pool.query('SELECT id FROM paystack_ng_orders WHERE reference=?',[body.reference]);
   const o=await store(db.pool).readOrder(r.id);state.records.set(o.reference,{o,email:body.email,id:String(9007199254740993n+BigInt(sc.subjectId))});
   return {data:{status:true,data:{authorization_url:'https://checkout.paystack.com/synthetic',access_code:'synthetic',reference:o.reference}},digest:C.digest('synthetic init')};
  }
  a.equal(method,'GET');if(state.failVerify)throw Error('SYNTHETIC_PROVIDER_TIMEOUT');
  const reference=decodeURIComponent(url.slice(url.lastIndexOf('/')+1)),r=state.records.get(reference);a(r);
  const data=response(r.o,r.email,{id:r.id,domain:'live',integration:100043,...state.patch});return {data,digest:C.digest(JSON.stringify(data))};
 };
 const writerPolicy={assertSafe(){return {mode:'legacy_verified'};}}; // Writer expiry itself is covered by signed-policy regressions.
 const makeApi=()=>createCheckoutService({config:f.config,pool:db.pool,ledgerStore:store(ledgerPool),writerPolicy,transport,transportStore:createTransportStore({pool:transportPool,config:f.config})});
 const api=makeApi(),o=await api.checkout({buyerId:14,subjectId:sc.subjectId,scholarId:50,idempotencyKey:crypto.randomUUID()});
 const r=[...state.records.values()][0];r.o.createdAt=Date.UTC(2026,10,11,1,56,50);await db.pool.query('UPDATE paystack_ng_orders SET created_at=? WHERE id=?',[new Date(r.o.createdAt),o.orderId]);
 const raw=(patch={})=>Buffer.from(JSON.stringify({event:'charge.success',data:response(r.o,r.email,{id:r.id,domain:'live',integration:100043,...patch}).data}));
 return {sc,f,state,api,makeApi,orderId:o.orderId,r,raw,deliver:(body=raw(),client=api)=>client.webhook(body,f.sign(body))};
}
async function financial(db,w){
 const result={};for(const t of ['paystack_ng_orders','paystack_ng_transactions','subject_purchases','paystack_ng_allocations','course_sale_proofs','paystack_ng_sale_counters']){
  const where=t==='paystack_ng_transactions'?'order_id=?':'subject_id=?';const [rows]=await db.pool.query('SELECT * FROM '+t+' WHERE '+where,[t==='paystack_ng_transactions'?w.orderId:w.sc.subjectId]);result[t]=rows.map(r=>JSON.stringify(r)).sort();
 }
 const [[payouts]]=await db.pool.query('SELECT COUNT(*) AS n FROM scholar_payouts');result.payoutObligations=Number(payouts.n);return result;
}
module.exports={database,workflow,financial,brokenPool,configuration,source};
