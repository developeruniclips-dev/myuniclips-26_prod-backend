'use strict';
// Invoked ONLY by the explicit disposable runner. No env/config/real provider.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const net=require('node:net'),dns=require('node:dns'),vm=require('node:vm'),{createRequire}=require('node:module');
assert(process.argv.includes('--owned-phase2c'),'Explicit owned-fixture invocation required');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
assert(/^paystack_ng_phase2c_test_[a-f0-9]{12}$/.test(input.database));
assert.equal(input.database,'paystack_ng_phase2c_test_'+input.nonce);assert(/^[a-f0-9]{64}$/.test(input.container));
assert.equal(process.version,'v22.23.3');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
    const first=Array.isArray(args[0])?args[0][0]:args[0];
    const host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';
    if(!['127.0.0.1','::1','localhost'].includes(host))throw Error('NON_LOOPBACK_SOCKET_DENIED');
    return connect.apply(this,args);
};
dns.lookup=function(host,options,callback){if(typeof options==='function'){callback=options;options={};}if(!['localhost','127.0.0.1','::1'].includes(host))throw Error('DNS_DENIED');queueMicrotask(()=>callback(null,'127.0.0.1',4));};
const mysql=require('/deps/node_modules/mysql2/promise');
assert.equal(require('/deps/node_modules/mysql2/package.json').version,'3.24.6');
const {statements}=require('../src/services/paystackNigeria/schema');
const {reviewSchema}=require('../src/services/paystackNigeria/compatibility');
const {createMysqlStore}=require('../src/services/paystackNigeria/store');
const {createServices}=require('../src/services/paystackNigeria/services');
const {createPolicy,RULE}=require('../src/services/paystackNigeria/policy');
const {createPaymentService}=require('../src/services/payments/paymentService');
const {createReleaseService,TYPE}=require('../src/services/paymentRelease/service');
const {buildPoolConfig}=require('../src/config/databaseTls');
const cert=new crypto.X509Certificate(input.certificate);assert.equal(cert.fingerprint256,input.fingerprint);
const hostname=cert.subject.match(/(?:^|\n)CN=(.+)/)[1];
const config=buildPoolConfig({NODE_ENV:'production',DB_HOST:hostname,DB_PORT:'3306',DB_USER:'root',DB_PASS:String(input.password),
    DB_NAME:input.database,DB_SSL:'true',DB_SSL_CA:'/synthetic-ca.pem'},()=>Buffer.from(input.ca.replace(/\0+$/,'')));
const pool=mysql.createPool({...config,connectionLimit:10,queueLimit:20,timezone:'Z',supportBigNumbers:true,bigNumberStrings:true,
    stream:()=>net.connect(3306,'127.0.0.1')});
const report={tests:[],observations:{},started:new Date().toISOString(),inputs:{node:process.version,mysql2:'3.24.6'}};
const pools=new Set([pool]);
async function owned(db=pool){const[[r]]=await db.query('SELECT DATABASE() AS db');assert.equal(r.db,input.database);}
async function exec(sql,args=[]){await owned();return pool.query(sql,args);}
async function test(name,work){try{await work();report.tests.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){report.tests.push({name,status:'FAIL',code:e.code,message:e.message});console.log('FAIL '+name+' '+e.code+' '+e.message);}}
const options='ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const core=[
 'countries(id INT PRIMARY KEY,name VARCHAR(50),code CHAR(2))',
 'universities(id INT PRIMARY KEY,name VARCHAR(100),short_name VARCHAR(20),country_id INT NOT NULL,FOREIGN KEY(country_id) REFERENCES countries(id))',
 'users(id INT PRIMARY KEY,fname VARCHAR(50),lname VARCHAR(50),email VARCHAR(100),university_id INT NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
 'subjects(id INT PRIMARY KEY,name VARCHAR(100),university_id INT NOT NULL,degree_programmes VARCHAR(100),bundle_price DECIMAL(10,2),FOREIGN KEY(university_id) REFERENCES universities(id))',
 'scholar_profile(user_id INT PRIMARY KEY,university VARCHAR(100),degree VARCHAR(100),approved TINYINT,stripe_account_id VARCHAR(100),FOREIGN KEY(user_id) REFERENCES users(id))',
 'scholar_subjects(id INT AUTO_INCREMENT PRIMARY KEY,subject_id INT NOT NULL,scholar_user_id INT NOT NULL,subject_name VARCHAR(100),degree VARCHAR(100),expertise TEXT,approved TINYINT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_user_id) REFERENCES users(id))',
 'videos(id INT AUTO_INCREMENT PRIMARY KEY,subject_id INT NOT NULL,scholar_user_id INT NOT NULL,approved TINYINT,title VARCHAR(100),FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_user_id) REFERENCES users(id))',
 'subject_purchases(id INT AUTO_INCREMENT PRIMARY KEY,buyer_user_id INT NOT NULL,subject_id INT NOT NULL,scholar_id INT NOT NULL,amount DECIMAL(10,2) NOT NULL,currency VARCHAR(3) NOT NULL,transaction_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,renewed_at DATETIME NULL,access_expires_at DATETIME NULL,is_access_active TINYINT DEFAULT 1,UNIQUE KEY entitlement(buyer_user_id,subject_id,scholar_id),FOREIGN KEY(buyer_user_id) REFERENCES users(id),FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_id) REFERENCES users(id))',
 'scholar_payouts(id INT AUTO_INCREMENT PRIMARY KEY,scholar_user_id INT,amount DECIMAL(10,2),currency VARCHAR(3),status VARCHAR(30),description TEXT,stripe_transfer_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
 'course_workflows(offering_id INT PRIMARY KEY,state VARCHAR(40))',
 'purchases(id INT AUTO_INCREMENT PRIMARY KEY,buyer_user_id INT,video_id INT,amount DECIMAL(10,2),currency VARCHAR(3),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
 'transactions(id INT AUTO_INCREMENT PRIMARY KEY,provider VARCHAR(24),provider_transaction_id VARCHAR(255),status VARCHAR(40),purchase_id INT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
];
const stripe=[
 `payment_catalogue_policy(university_id INT PRIMARY KEY,provider VARCHAR(24),currency CHAR(3),enabled BOOLEAN)`,
 `payment_orders(id CHAR(36) PRIMARY KEY,buyer_id INT NOT NULL,subject_id INT NOT NULL,scholar_id INT NOT NULL,university_id INT NOT NULL,provider VARCHAR(24) NOT NULL,currency CHAR(3) NOT NULL,amount_minor BIGINT NOT NULL,rule_version VARCHAR(60) NOT NULL,quoted_rate INT NOT NULL,quoted_scholar_minor BIGINT NOT NULL,quoted_platform_minor BIGINT NOT NULL,provider_account VARCHAR(255) NOT NULL,livemode BOOLEAN NOT NULL,destination_account VARCHAR(255),session_id VARCHAR(255),payment_id VARCHAR(255),charge_id VARCHAR(255),checkout_url TEXT,state VARCHAR(40) DEFAULT 'created',purchase_id INT,paid_at DATETIME,fulfilled_at DATETIME,refund_state VARCHAR(40) DEFAULT 'none',dispute_state VARCHAR(40) DEFAULT 'none',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE(provider,session_id),UNIQUE(provider,payment_id),UNIQUE(purchase_id))`,
 `payment_sale_counters(subject_id INT NOT NULL,scholar_id INT NOT NULL,legacy_baseline INT NOT NULL,successful_sales INT NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(subject_id,scholar_id))`,
 `payment_allocations(order_id CHAR(36) PRIMARY KEY,subject_id INT NOT NULL,scholar_id INT NOT NULL,sale_ordinal INT NOT NULL,currency CHAR(3) NOT NULL,gross_minor BIGINT NOT NULL,scholar_rate INT NOT NULL,scholar_minor BIGINT NOT NULL,platform_minor BIGINT NOT NULL,UNIQUE(subject_id,scholar_id,sale_ordinal),FOREIGN KEY(order_id) REFERENCES payment_orders(id))`,
 `payment_transfers(order_id CHAR(36) PRIMARY KEY,provider VARCHAR(24),currency CHAR(3),amount_minor BIGINT,destination_account VARCHAR(255),idempotency_key VARCHAR(255),transfer_id VARCHAR(255),state VARCHAR(40) DEFAULT 'pending',error_code VARCHAR(80),attempted_at DATETIME,completed_at DATETIME,UNIQUE(provider,transfer_id),UNIQUE(idempotency_key),FOREIGN KEY(order_id) REFERENCES payment_orders(id))`,
];
async function metadata(){
 const [ts]=await pool.query('SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=?',[input.database]);
 const [cs]=await pool.query('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,NUMERIC_PRECISION,NUMERIC_SCALE,CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=?',[input.database]);
 const [ks]=await pool.query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',[input.database]);
 const m={tables:{},columns:{},uniqueKeys:{},indexes:{},stripeCounterPresent:ts.some(t=>t.TABLE_NAME==='payment_sale_counters')};
 for(const t of ts)m.tables[t.TABLE_NAME]={engine:t.ENGINE};
 for(const c of cs)m.columns[c.TABLE_NAME+'.'+c.COLUMN_NAME]={type:c.DATA_TYPE,unsigned:c.COLUMN_TYPE.includes('unsigned'),nullable:c.IS_NULLABLE==='YES',precision:Number(c.NUMERIC_PRECISION),scale:Number(c.NUMERIC_SCALE),length:Number(c.CHARACTER_MAXIMUM_LENGTH),collation:c.COLLATION_NAME};
 const groups=new Map();for(const k of ks){const key=k.TABLE_NAME+':'+k.INDEX_NAME;if(!groups.has(key))groups.set(key,{table:k.TABLE_NAME,unique:Number(k.NON_UNIQUE)===0,columns:[]});groups.get(key).columns.push(k.COLUMN_NAME);}
 for(const k of groups.values()){(m.indexes[k.table]||=[]).push(k.columns);if(k.unique)(m.uniqueKeys[k.table]||=[]).push(k.columns);}return m;
}
let meta,subjectSequence=100,receiptSequence=0;
const historical=new Map();
const resolver=async(db,rows)=>{
 const proofs=[];
 for(const r of rows){
  if(historical.has(r.id)){proofs.push({...historical.get(r.id)});continue;}
  // Fixture provenance only: these rows were produced by the actual unchanged
  // verifier against the inert provider below, never by an external payment.
  const[modern]=await db.query("SELECT a.sale_ordinal FROM payment_orders o JOIN payment_allocations a ON a.order_id=o.id WHERE o.purchase_id=? AND o.payment_id=? AND o.state='fulfilled'",[r.id,r.transactionId]);
  const[legacy]=await db.query("SELECT JSON_EXTRACT(description,'$.ordinal') AS ordinal FROM scholar_payouts WHERE JSON_VALID(description) AND JSON_EXTRACT(description,'$.purchaseId')=? AND JSON_UNQUOTE(JSON_EXTRACT(description,'$.paymentId'))=?",[r.id,r.transactionId]);
  if(modern.length+legacy.length===1)proofs.push({purchaseId:r.id,ordinal:Number(modern[0]?.sale_ordinal??legacy[0]?.ordinal),verified:true,provider:'stripe',provenance:'synthetic actual verifier with inert provider evidence',reference:r.transactionId,currency:r.currency,amountMinor:r.amountMinor});
 }
 return proofs;
};
function store(customPool=pool,resolve=resolver,md=meta){return createMysqlStore({pool:customPool,resolveHistoricalSales:resolve,schemaMetadata:md});}
async function scope(){
 const subjectId=++subjectSequence,scholarId=7;
 await exec("INSERT INTO subjects VALUES(?,? ,2,'Engineering',6.00)",[subjectId,'Synthetic course '+subjectId]);
 await exec("INSERT INTO scholar_subjects(subject_id,scholar_user_id,subject_name,degree,expertise,approved) VALUES(?,7,?,'Engineering','synthetic',1)",[subjectId,'Synthetic course '+subjectId]);
 await exec('INSERT INTO videos(subject_id,scholar_user_id,approved,title) VALUES(?,7,1,?)',[subjectId,'Synthetic video']);
 await exec('INSERT INTO paystack_ng_offerings(subject_id,scholar_id,merchant_account,environment,policy_version,approved) VALUES(?,7,?,?,?,1)',[subjectId,'fixture_merchant','test',RULE.version]);
 return {subjectId,scholarId};
}
function service(st=store(),clock=()=>Date.now()){
 const receipts=new Map(),policy=createPolicy({enabled:true,environment:'test',merchantAccount:'fixture_merchant'});
 const provider={kind:'offline-double',verify:async ref=>structuredClone(receipts.get(ref))};
 return {api:createServices({store:st,provider,policy,now:clock}),receipts,provider,
  receipt(o,overrides={}){const e={verified:true,status:'success',orderId:o.id,buyerId:o.buyerId,subjectId:o.subjectId,scholarId:o.scholarId,
   merchantAccount:o.merchantAccount,environment:'test',transactionId:'tx_fixture_'+(++receiptSequence),reference:o.reference,currency:'NGN',amountMinor:150000,totalChargedMinor:150000,
   feesMinor:3000,paidAt:Math.floor(clock()/1000),evidenceDigest:crypto.randomBytes(32).toString('hex'),refundedMinor:0,disputed:false,...overrides};receipts.set(o.reference,e);return e;}};
}
async function order(s,sc,buyerId=20){const o=await s.api.createOrder({...sc,buyerId,idempotencyKey:crypto.randomBytes(16).toString('hex')});s.receipt(o);return o;}
const confirm=(s,o)=>s.api.fulfill({orderId:o.id,buyerId:o.buyerId});
async function seed(sc,n,{counter=true,mixed=true}={}){
 const values=[];for(let i=1;i<=n;i++)values.push([10000+sc.subjectId*11000+i,sc.subjectId,sc.scholarId,mixed&&i%2===0?'1500.00':'6.00',mixed&&i%2===0?'NGN':'EUR','historical_'+sc.subjectId+'_'+i]);
 for(let start=0;start<values.length;start+=500){const chunk=values.slice(start,start+500);await exec('INSERT INTO users(id,fname,lname,email) VALUES ?',[chunk.map(r=>[r[0],'Synthetic','Historical','h'+r[0]+'@example.invalid'])]);await exec('INSERT INTO subject_purchases(buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id) VALUES ?',[chunk]);}
 const[rows]=await pool.query('SELECT id,currency,amount,transaction_id FROM subject_purchases WHERE subject_id=? AND scholar_id=? ORDER BY id',[sc.subjectId,sc.scholarId]);
 rows.forEach((r,i)=>historical.set(r.id,{purchaseId:r.id,ordinal:i+1,verified:true,provider:r.currency==='EUR'?'stripe':'historical_ng',provenance:'synthetic audited ordinal fixture',reference:r.transaction_id,currency:r.currency,amountMinor:Number(r.amount)*100}));
 if(counter&&meta.stripeCounterPresent)await exec('INSERT INTO payment_sale_counters(subject_id,scholar_id,legacy_baseline,successful_sales) VALUES(?,?,?,?)',[sc.subjectId,sc.scholarId,n,n]);return rows;
}
const business=['paystack_ng_orders','paystack_ng_transactions','subject_purchases','paystack_ng_allocations','paystack_ng_sale_counters','payment_sale_counters','payment_allocations','payment_transfers','scholar_payouts'];
async function snapshot(){const result={};for(const table of business){if(table==='payment_sale_counters'&&!meta.stripeCounterPresent)continue;const[rows]=await pool.query('SELECT * FROM '+table);result[table]=rows.map(r=>JSON.stringify(r)).sort();}return result;}
function wrapPool(hook,base=pool){return {async getConnection(){const c=await base.getConnection();return new Proxy(c,{get(target,key){if(key==='query')return async(sql,args)=>{const text=typeof sql==='string'?sql:sql.sql;await hook('before',text,args,c);const result=await c.query(sql,args);await hook('after',text,args,c,result);return result;};const v=target[key];return typeof v==='function'?v.bind(target):v;}});}};}
function barrier(){let enter,release;const signal=new Promise(r=>enter=r),gate=new Promise(r=>release=r);const reached=Promise.race([signal,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('FIXTURE_BARRIER_NOT_REACHED')),15000);t.unref();})]);reached.catch(()=>{});return {reached,release,async hold(){enter();await gate;}};}
async function busy(p){await assert.rejects(p,e=>e.code==='PAYSTACK_NG_BUSY');}
async function ngCases(){
 await test('empty/mixed lifetime baselines 0,99,100,101 and exact NGN held allocation',async()=>{
  for(const n of [0,99,100,101]){const sc=await scope();await seed(sc,n);const s=service(),o=await order(s,sc),r=await confirm(s,o);assert.equal(r.ordinal,n+1);assert.equal(r.scholarMinor,n<100?105000:75000);const[[c]]=await pool.query('SELECT * FROM paystack_ng_sale_counters WHERE subject_id=?',[sc.subjectId]);assert.equal(Number(c.successful_sales),n+1);assert.equal(Number(c.historical_verified_sales),n);assert.equal(Number(c.ng_successful_sales),1);const earnings=await s.api.earnings(7);assert.equal(earnings.currency,'NGN');}
 });
 await test('duplicate/expired access, immutable request reuse and provider ownership/amount refusal',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc);await confirm(s,o);const replay=await confirm(s,o);assert.equal(replay.replay,true);
  await exec("UPDATE subject_purchases SET access_expires_at='2000-01-01',is_access_active=0 WHERE id=?",[replay.purchaseId]);assert.equal((await confirm(s,o)).replay,true);
  await assert.rejects(s.api.createOrder({...sc,buyerId:o.buyerId,idempotencyKey:'different_request_key_123'}),e=>e.code==='REPURCHASE_BLOCKED');
  const again=await s.api.createOrder({...sc,buyerId:o.buyerId,idempotencyKey:o.idempotencyKey});assert.equal(again.id,o.id);
  const b=await order(s,sc,21);for(const change of [{amountMinor:149999},{currency:'EUR'},{buyerId:999},{totalChargedMinor:150001}]){const before=await snapshot();s.receipt(b,change);await assert.rejects(confirm(s,b));assert.deepEqual(await snapshot(),before);}
 });
 await test('calendar five-month expiry and exact DECIMAL/BIGINT conversion',async()=>{
  for(const [paid,expiry]of [['2026-01-31T12:00:00Z','2026-06-30 12:00:00'],['2023-09-30T12:00:00Z','2024-02-29 12:00:00']]){
   const sc=await scope(),clock=()=>Date.parse(paid),s=service(store(),clock),o=await order(s,sc);const r=await confirm(s,o);
   const[[p]]=await pool.query("SELECT amount,DATE_FORMAT(access_expires_at,'%Y-%m-%d %H:%i:%s') AS expiry FROM subject_purchases WHERE id=?",[r.purchaseId]);assert.equal(p.amount,'1500.00');assert.equal(p.expiry,expiry);
  }
  const[[wide]]=await pool.query("SELECT CAST(9007199254740993 AS UNSIGNED) AS n,CAST(1500 AS DECIMAL(10,2)) AS amount");assert.equal(wide.n,'9007199254740993');assert.equal(wide.amount,'1500.00');
 });
 await test('two NG buyers deterministic NOWAIT, explicit resubmission gives ordinals100/101',async()=>{
  const sc=await scope();await seed(sc,99);const block=barrier();let once=true;
  const wrapped=wrapPool(async(when,sql)=>{if(once&&when==='after'&&sql.startsWith('SELECT successful_sales FROM payment_sale_counters')){once=false;await block.hold();}});
  const a=service(store(wrapped)),b=service(),o1=await order(a,sc,22),o2=await order(b,sc,23);const first=confirm(a,o1);await block.reached;
  try{await busy(confirm(b,o2));}finally{block.release();}assert.equal((await first).ordinal,100);assert.equal((await confirm(b,o2)).ordinal,101);
 });
 await test('same-order concurrent replay and ambiguous commit response produce one grant',async()=>{
  const sc=await scope();await seed(sc,0);const b=barrier();let once=true;const wrapped=wrapPool(async(when,sql)=>{if(once&&when==='after'&&sql.startsWith('SELECT successful_sales FROM payment_sale_counters')){once=false;await b.hold();}});
  const a=service(store(wrapped)),o=await order(a,sc,24),other=service();other.receipts.set(o.reference,a.receipts.get(o.reference));const p=confirm(a,o);await b.reached;try{await busy(confirm(other,o));}finally{b.release();}await p;assert.equal((await confirm(other,o)).replay,true);
  const sc2=await scope(),real=store(),s=service({...real,async transaction(work){const r=await real.transaction(work);if(r?.state==='fulfilled'&&!r.replay)throw Error('SYNTHETIC_LOST_COMMIT_RESPONSE');return r;}}),o2=await order(s,sc2,25);
  await assert.rejects(confirm(s,o2),/LOST_COMMIT_RESPONSE/);assert.equal((await confirm(s,o2)).replay,true);
  const[[n]]=await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=?',[sc2.subjectId]);assert.equal(Number(n.n),1);
 });
 await test('rollback after every business write leaves complete table snapshots unchanged',async()=>{
  const patterns=['INSERT INTO paystack_ng_transactions','INSERT INTO subject_purchases','INSERT INTO paystack_ng_allocations','INSERT INTO paystack_ng_sale_counters','UPDATE payment_sale_counters SET','UPDATE paystack_ng_orders SET state'];
  for(const pattern of patterns){const sc=await scope();let enabled=false,fired=false;const p=wrapPool(async(when,sql)=>{if(enabled&&!fired&&when==='after'&&sql.startsWith(pattern)){fired=true;throw Error('SYNTHETIC_AFTER_WRITE');}});const s=service(store(p)),o=await order(s,sc,26),before=await snapshot();enabled=true;await assert.rejects(confirm(s,o),/SYNTHETIC_AFTER_WRITE/);assert(fired,pattern);assert.deepEqual(await snapshot(),before);}
 });
 await test('missing/duplicate/gapped proof, ahead counter and corrupt NG chain refuse atomically',async()=>{
  for(const kind of ['missing','duplicate','gap','amount','ahead','deleted']){const sc=await scope(),rows=await seed(sc,2),s=service(),o=await order(s,sc,27);
   if(kind==='missing')historical.delete(rows[0].id);if(kind==='duplicate')historical.get(rows[1].id).ordinal=1;if(kind==='gap')historical.get(rows[1].id).ordinal=3;if(kind==='amount')historical.get(rows[1].id).amountMinor++;
   if(kind==='ahead')await exec('UPDATE payment_sale_counters SET successful_sales=3 WHERE subject_id=?',[sc.subjectId]);
   if(kind==='deleted')await exec('DELETE FROM subject_purchases WHERE id=?',[rows[1].id]);const before=await snapshot();await assert.rejects(confirm(s,o),e=>e.code.startsWith('BASELINE_'));assert.deepEqual(await snapshot(),before);
  }
  const sc=await scope(),s=service(),o=await order(s,sc,28);await confirm(s,o);const next=await order(s,sc,29);await exec("UPDATE paystack_ng_orders SET policy_version='corrupt-synthetic-policy' WHERE id=?",[o.id]);const before=await snapshot();await assert.rejects(confirm(s,next),e=>e.code==='BASELINE_NG_LEDGER_MISMATCH');assert.deepEqual(await snapshot(),before);
 });
 await test('10000/10001 real-row census boundary, no truncated baseline',async()=>{
  for(const n of [10000,10001]){const sc=await scope();await seed(sc,n,{mixed:false});const s=service(),o=await order(s,sc,30);if(n===10000)assert.equal((await confirm(s,o)).ordinal,10001);else{const before=await snapshot();await assert.rejects(confirm(s,o),e=>e.code==='BASELINE_REVIEW_REQUIRED');assert.deepEqual(await snapshot(),before);}}
 });
}
async function schemaCases(){
 await test('actual FK metadata uses unique parents, exact column types/collations, RESTRICT deletes',async()=>{
  const md=await metadata();const[fks]=await pool.query('SELECT TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME,ORDINAL_POSITION FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION',[input.database]);
  const groups=new Map();for(const fk of fks){if(!fk.TABLE_NAME.startsWith('paystack_ng_'))continue;const key=fk.TABLE_NAME+':'+fk.CONSTRAINT_NAME;if(!groups.has(key))groups.set(key,{table:fk.TABLE_NAME,parent:fk.REFERENCED_TABLE_NAME,child:[],parentColumns:[]});const g=groups.get(key);g.child.push(fk.COLUMN_NAME);g.parentColumns.push(fk.REFERENCED_COLUMN_NAME);
   const child=md.columns[fk.TABLE_NAME+'.'+fk.COLUMN_NAME],parent=md.columns[fk.REFERENCED_TABLE_NAME+'.'+fk.REFERENCED_COLUMN_NAME];assert.equal(child.type,parent.type);assert.equal(child.unsigned,parent.unsigned);assert.equal(child.collation,parent.collation);
  }
  for(const g of groups.values())assert(md.uniqueKeys[g.parent].some(k=>JSON.stringify(k)===JSON.stringify(g.parentColumns)),JSON.stringify(g));
  const[rules]=await pool.query("SELECT TABLE_NAME,CONSTRAINT_NAME,DELETE_RULE,UPDATE_RULE FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME LIKE 'paystack_ng_%'",[input.database]);rules.forEach(r=>{assert(['NO ACTION','RESTRICT'].includes(r.DELETE_RULE));assert(['NO ACTION','RESTRICT'].includes(r.UPDATE_RULE));});
  const[checks]=await pool.query("SELECT tc.TABLE_NAME,cc.CHECK_CLAUSE,tc.ENFORCED FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=? AND tc.TABLE_NAME LIKE 'paystack_ng_%'",[input.database]);assert(checks.length>=20);checks.forEach(r=>assert.equal(r.ENFORCED,'YES'));report.observations.foreignKeys=[...groups.values()];report.observations.checkCount=checks.length;
 });
 await test('FK/check/unique constraints reject context, price, tier, case and dangling links',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,31),r=await confirm(s,o);
  const invalid=[['UPDATE paystack_ng_orders SET currency=? WHERE id=?',['ngn',o.id]],['UPDATE paystack_ng_orders SET total_minor=150001 WHERE id=?',[o.id]],['UPDATE paystack_ng_orders SET purchase_id=NULL WHERE id=?',[o.id]],
   ["UPDATE paystack_ng_allocations SET payout_state='HELD' WHERE order_id=?",[o.id]],["UPDATE paystack_ng_allocations SET scholar_rate=50,scholar_minor=75000,platform_gross_minor=75000 WHERE order_id=?",[o.id]],
   ['UPDATE paystack_ng_allocations SET subject_id=? WHERE order_id=?',[sc.subjectId+1,o.id]],['UPDATE paystack_ng_transactions SET reference=? WHERE order_id=?',['wrong_reference',o.id]],
   ['UPDATE paystack_ng_transactions SET merchant_account=? WHERE order_id=?',['wrong_merchant',o.id]],['UPDATE paystack_ng_orders SET purchase_id=2147483647 WHERE id=?',[o.id]]];
  for(const[sql,args]of invalid)await assert.rejects(exec(sql,args),e=>['ER_CHECK_CONSTRAINT_VIOLATED','ER_NO_REFERENCED_ROW_2'].includes(e.code));
  await assert.rejects(exec('DELETE FROM subject_purchases WHERE id=?',[r.purchaseId]),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  await assert.rejects(exec('DELETE FROM users WHERE id=31'),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  await assert.rejects(exec('DELETE FROM subjects WHERE id=?',[sc.subjectId]),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  await assert.rejects(exec('INSERT INTO subject_purchases(buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id) VALUES(31,?,7,1500,?,?)',[sc.subjectId,'NGN','duplicate']),e=>e.code==='ER_DUP_ENTRY');
 });
 await test('DDL batch is not rollback-atomic; unsigned/nonunique parent variants fail',async()=>{
  const aux=input.database+'_ddl';assert(aux.startsWith('paystack_ng_phase2c_test_'+input.nonce));await owned();await pool.query('CREATE DATABASE `'+aux+'`');
  const db=await pool.getConnection();
  const q=async(sql)=>{const[[r]]=await db.query('SELECT DATABASE() AS db');assert.equal(r.db,aux);return db.query(sql);};
  try{await db.query('USE `'+aux+'`');for(const d of ['users(id INT PRIMARY KEY)','subjects(id INT PRIMARY KEY)','subject_purchases(id INT PRIMARY KEY)'])await q('CREATE TABLE '+d+' '+options);
   await db.beginTransaction();for(const ddl of statements.slice(0,3))await q(ddl);await assert.rejects(q(statements[2]),e=>e.code==='ER_TABLE_EXISTS_ERROR');await db.rollback();
   const[[count]]=await q("SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'paystack_ng_%'");assert.equal(Number(count.n),3);
   for(const name of ['paystack_ng_transactions','paystack_ng_orders','paystack_ng_offerings'])await q('DROP TABLE '+name);
   await q('DROP TABLE subjects');await q('CREATE TABLE subjects(id INT UNSIGNED PRIMARY KEY) '+options);await assert.rejects(q(statements[0]),e=>e.code==='ER_FK_INCOMPATIBLE_COLUMNS');
   await q('DROP TABLE subjects');await q('CREATE TABLE subjects(id INT,KEY(id)) '+options);await assert.rejects(q(statements[0]),e=>/Missing unique key/.test(e.message));
   report.observations.partialDDL={createdBeforeFailure:3,remainingAfterRollback:3,cleanup:'reverse foreign-key order then owned schema removal'};
  }finally{await db.query('USE `'+input.database+'`');db.release();await owned();await pool.query('DROP DATABASE `'+aux+'`');}
 });
 await test('next-transaction isolation does not leak into later Stripe/default transactions; UTC enforced',async()=>{
  const singleton=mysql.createPool({...config,connectionLimit:1,timezone:'Z',stream:()=>net.connect(3306,'127.0.0.1')});pools.add(singleton);
  try{const[[before]]=await singleton.query('SELECT @@session.transaction_isolation AS iso,CONNECTION_ID() AS id');
   const checkIsolation=async db=>{const[events]=await db.query('SELECT ISOLATION_LEVEL FROM performance_schema.events_transactions_current WHERE THREAD_ID=(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=CONNECTION_ID())');if(events.length)assert.equal(events[0].ISOLATION_LEVEL,'READ COMMITTED');return [];};
   await store(singleton,checkIsolation).transaction(async tx=>assert.deepEqual(await tx.historicalProofs([],{}),[]));
   const[[after]]=await singleton.query('SELECT @@session.transaction_isolation AS iso,CONNECTION_ID() AS id');assert.equal(after.iso,before.iso);assert.equal(after.id,before.id);
   const c=await singleton.getConnection();try{await c.beginTransaction();const[events]=await c.query('SELECT ISOLATION_LEVEL FROM performance_schema.events_transactions_current WHERE THREAD_ID=(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=CONNECTION_ID())');if(events.length)assert.equal(events[0].ISOLATION_LEVEL,'REPEATABLE READ');await c.rollback();}finally{c.release();}
   await singleton.query("SET SESSION time_zone='+01:00'");await assert.rejects(store(singleton).transaction(()=>{}),e=>e.code==='UTC_SESSION_REQUIRED');await singleton.query("SET SESSION time_zone='+00:00'");
  }finally{await singleton.end();pools.delete(singleton);}
 });
}
let stripeSequence=0,unsafeProviderCalls=0;
const denyProvider=async()=>{unsafeProviderCalls++;throw Error('EXTERNAL_OR_AUTOMATIC_ACTION_DENIED');};
function stripeFixture(customPool=pool,legacy=false){
 const sessions=new Map(),identity={account:'acct_fixture_platform',livemode:false};
 const provider={name:'stripe',identity:async()=>identity,evidence:async id=>structuredClone(sessions.get(id)),
  retrieveAccount:denyProvider,createTransfer:denyProvider,createReleaseTransfer:denyProvider,refund:denyProvider,
  createCheckout:async(o,signature)=>{
   const n=++stripeSequence,id='cs_local_'+n,pi='pi_local_'+n;
   const metadata=legacy?{type:TYPE,snapshot:JSON.stringify(o),signature}:{type:'uniclips_order_v1',orderId:o.id,buyerId:String(o.buyer_id),subjectId:String(o.subject_id),scholarId:String(o.scholar_id)};
   const amount=legacy?o.amountMinor:o.amount_minor;
   sessions.set(id,{identity,session:{id,livemode:false,mode:'payment',client_reference_id:legacy?o.nonce:o.id,metadata,amount_total:amount,currency:'eur',payment_status:'paid'},
    payment:{id:pi,status:'succeeded',amount_received:amount,currency:'eur',livemode:false,metadata},
    charge:{id:'ch_local_'+n,paid:true,amount,currency:'eur',payment_intent:pi,livemode:false,created:Math.floor(Date.now()/1000),amount_refunded:0,disputed:false}});
   return {id,url:'https://example.invalid/inert-no-checkout'};
  }};
 const service=legacy?createReleaseService({pool:customPool,provider,signingSecret:crypto.randomBytes(32).toString('hex')}).payments:createPaymentService({pool:customPool,provider});
 return {api:service,sessions};
}
async function market(sc,code){const country=code==='FI'?1:2;await exec('UPDATE subjects SET university_id=? WHERE id=?',[country,sc.subjectId]);await exec('UPDATE scholar_profile SET university=? WHERE user_id=7',[code==='FI'?'Fixture FI University (FFI)':'Fixture NG University (FNG)']);}
async function phaseOrder(f,sc,buyer){await market(sc,'FI');const o=await f.api.createOrder(buyer,sc.subjectId,sc.scholarId);await market(sc,'NG');return o;}
async function waitForLock(){for(let i=0;i<150;i++){const[[r]]=await pool.query('SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits');if(Number(r.n)>0)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('EXPECTED_FIXTURE_LOCK_WAIT_NOT_OBSERVED');}
const outcome=p=>p.then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}));
async function crossProviderCases(){
 await test('Stripe phase2a counter-first: NG NOWAIT refusal then global ordinal continuation',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,32),b=barrier();let held=false;
  const custom=wrapPool(async(when,sql)=>{if(!held&&when==='after'&&sql.startsWith('SELECT * FROM payment_sale_counters')){held=true;await b.hold();}});
  const f=stripeFixture(custom),checkout=await phaseOrder(f,sc,33);const first=f.api.verifySession(checkout.sessionId,33);await b.reached;
  try{await busy(confirm(s,o));}finally{b.release();}assert.equal((await first).state,'fulfilled');assert.equal((await confirm(s,o)).ordinal,2);
 });
 await test('NG counter-first: actual Stripe census locks settle or roll back without partial grants',async()=>{
  const sc=await scope();await seed(sc,0);const b=barrier();let held=false;const custom=wrapPool(async(when,sql)=>{if(!held&&when==='after'&&sql.startsWith('SELECT successful_sales FROM payment_sale_counters')){held=true;await b.hold();}});
  const s=service(store(custom)),o=await order(s,sc,34),started=barrier();let armed=false;
  const stPool=wrapPool(async(when,sql)=>{if(armed&&when==='before'&&sql.startsWith('INSERT INTO payment_sale_counters')){armed=false;await started.hold();}});
  const f=stripeFixture(stPool),checkout=await phaseOrder(f,sc,35);const first=outcome(confirm(s,o));await b.reached;armed=true;const second=outcome(f.api.verifySession(checkout.sessionId,35));await started.reached;started.release();
  // The actual RR INSERT...SELECT may take census locks before the counter
  // upsert and deadlock with NG. Both outcomes are joined and inspected.
  try{await waitForLock();}finally{b.release();}const a=await first,st=await second;
  assert(a.status==='fulfilled'||st.status==='fulfilled');
  if(a.status==='rejected'){assert.equal(a.reason.code,'PAYSTACK_NG_BUSY');assert.equal(st.value.state,'fulfilled');assert.equal((await confirm(s,o)).ordinal,2);}
  else{assert.equal(a.value.ordinal,1);if(st.status==='rejected'){assert(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(st.reason.code));assert.equal((await f.api.verifySession(checkout.sessionId,35)).state,'fulfilled');}else assert.equal(st.value.state,'fulfilled');}
  report.observations.ngStripeLockOutcomes={ng:a.status==='fulfilled'?'fulfilled':a.reason.code,stripe:st.status==='fulfilled'?'fulfilled':st.reason.code,explicitFixtureResubmission:a.status==='rejected'||st.status==='rejected'};
  const[[allocation]]=await pool.query('SELECT sale_ordinal FROM payment_allocations WHERE order_id=?',[checkout.orderId]);const[[ngAllocation]]=await pool.query('SELECT sale_ordinal FROM paystack_ng_allocations WHERE order_id=?',[o.id]);assert.deepEqual([Number(allocation.sale_ordinal),Number(ngAllocation.sale_ordinal)].sort(),[1,2]);
  const next=await order(s,sc,36);assert.equal((await confirm(s,next)).ordinal,3);
 });
 await test('first-time shared counter race: NG absent SELECT, Stripe initializer, NG waits before subject',async()=>{
  const sc=await scope(),ngBarrier=barrier(),stripeBarrier=barrier();let ngOnce=true,stOnce=true;
  const ngPool=wrapPool(async(when,sql,args,c,result)=>{if(ngOnce&&when==='after'&&sql.startsWith('SELECT successful_sales FROM payment_sale_counters')&&result[0].length===0){ngOnce=false;await ngBarrier.hold();}});
  const stPool=wrapPool(async(when,sql)=>{if(stOnce&&when==='after'&&sql.startsWith('SELECT * FROM payment_sale_counters')){stOnce=false;await stripeBarrier.hold();}});
  const s=service(store(ngPool)),o=await order(s,sc,37),f=stripeFixture(stPool),checkout=await phaseOrder(f,sc,38);
  const ng=outcome(confirm(s,o));await ngBarrier.reached;const st=outcome(f.api.verifySession(checkout.sessionId,38));await stripeBarrier.reached;ngBarrier.release();
  try{await waitForLock();}finally{stripeBarrier.release();}const stResult=await st,ngResult=await ng;assert.equal(stResult.status,'fulfilled');assert.equal(stResult.value.state,'fulfilled');assert.equal(ngResult.status,'fulfilled');assert.equal(ngResult.value.ordinal,2);
 });
 await test('stale Stripe pre-counter entitlement check cannot grant duplicate access',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,39),b=barrier();let held=false;
  const custom=wrapPool(async(when,sql)=>{if(!held&&when==='after'&&sql.startsWith('SELECT id FROM subject_purchases WHERE buyer_user_id')){held=true;await b.hold();}});
  held=true;const f=stripeFixture(custom),checkout=await phaseOrder(f,sc,39);held=false;const st=outcome(f.api.verifySession(checkout.sessionId,39));await b.reached;
  try{await confirm(s,o);}finally{b.release();}const stResult=await st;assert.equal(stResult.status,'rejected');assert.equal(stResult.reason.code,'ER_DUP_ENTRY');
  const[[count]]=await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE buyer_user_id=39 AND subject_id=?',[sc.subjectId]);assert.equal(Number(count.n),1);
  const[[old]]=await pool.query('SELECT state FROM payment_orders WHERE id=?',[checkout.orderId]);assert.equal(old.state,'pending');
 });
 await test('legacy subject-lock holder denies NG; proven legacy sale then NG continues lifetime',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,40),b=barrier();let held=false;
  const custom=wrapPool(async(when,sql)=>{if(!held&&when==='after'&&sql.startsWith('SELECT s.id,s.university_id,c.code')&&sql.includes('FOR UPDATE')){held=true;await b.hold();}});
  await market(sc,'FI');const f=stripeFixture(custom,true),checkout=await f.api.createOrder(41,sc.subjectId,7);const legacy=f.api.verifySession(checkout.sessionId,41);await b.reached;
  try{await busy(confirm(s,o));}finally{b.release();}assert.equal((await legacy).state,'fulfilled');await market(sc,'NG');
  assert.equal((await confirm(s,o)).ordinal,2);
 });
 await test('NG subject-lock holder settles; late legacy FI receipt refuses market transition',async()=>{
  const sc=await scope(),b=barrier();let held=false;
  const custom=wrapPool(async(when,sql)=>{if(!held&&when==='after'&&sql.startsWith('SELECT id FROM subjects WHERE id=? FOR UPDATE')){held=true;await b.hold();}});
  const s=service(store(custom)); // Arm only after order creation to avoid blocking setup.
  held=true;const o=await order(s,sc,42);held=false;
  const f=stripeFixture(pool,true),checkout=await phaseOrder(f,sc,43);
  const ng=outcome(confirm(s,o));await b.reached;const st=outcome(f.api.verifySession(checkout.sessionId,43));
  try{await waitForLock();}finally{b.release();}assert.equal((await ng).status,'fulfilled');const stResult=await st;assert.equal(stResult.status,'rejected');assert.match(stResult.reason.message,/academic context requires review/);
 });
 await test('existing Stripe-to-Stripe duplicated ordinal hazard reproduced; NG refuses conflicting proof',async()=>{
  const sc=await scope();await seed(sc,99,{mixed:false});const s=service(),o=await order(s,sc,44);await market(sc,'FI');
  const b=barrier();let armed=false;
  const concurrentPool=wrapPool(async(when,sql)=>{if(armed&&when==='after'&&sql.startsWith('SELECT id FROM subject_purchases WHERE buyer_user_id')){armed=false;await b.hold();}});
  const legacy=stripeFixture(pool,true),modern=stripeFixture(concurrentPool),oldOrder=await legacy.api.createOrder(45,sc.subjectId,7),newOrder=await modern.api.createOrder(46,sc.subjectId,7);
  armed=true;const modernPending=outcome(modern.api.verifySession(newOrder.sessionId,46));await b.reached;
  // Phase2a's transaction is already open at its pre-counter read. Complete
  // legacy inside that interval, then let the unchanged counter writer finish.
  try{await legacy.api.verifySession(oldOrder.sessionId,45);}finally{b.release();}
  assert.equal((await modernPending).status,'fulfilled');
  const[[allocation]]=await pool.query('SELECT sale_ordinal FROM payment_allocations WHERE order_id=?',[newOrder.orderId]);
  const[[instruction]]=await pool.query('SELECT JSON_EXTRACT(description,\'$.ordinal\') AS ordinal FROM scholar_payouts WHERE JSON_UNQUOTE(JSON_EXTRACT(description,\'$.sessionId\'))=?',[oldOrder.sessionId]);
  assert.equal(Number(instruction.ordinal),100);assert.equal(allocation.sale_ordinal,100);
  const[[count]]=await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=?',[sc.subjectId]);assert.equal(Number(count.n),101);
  await market(sc,'NG');const before=await snapshot();await assert.rejects(confirm(s,o),e=>e.code==='BASELINE_ORDINAL_CONFLICT');assert.deepEqual(await snapshot(),before);
  report.observations.stripeCoexistence={status:'BLOCKER_REPRODUCED',overlappingVerificationTransactions:true,legacyOrdinal:100,phase2aOrdinal:100,purchases:101,ngResult:'BASELINE_ORDINAL_CONFLICT',stripeSourceChanged:false};
 });
}
function loadWithPool(relative,other={}){
 const filename=path.resolve(__dirname,'..',relative),localRequire=createRequire(filename),module={exports:{}};
 const req=id=>id.endsWith('/config/db')?{pool}:Object.prototype.hasOwnProperty.call(other,id)?other[id]:localRequire(id);
 vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(filename,'utf8')+'\n})',{filename})(req,module,module.exports);return module.exports;
}
async function reportingCases(){
 await test('actual existing reports reproduce provider misclassification, currency mixing and NG re-tiering',async()=>{
  const sc=await scope();await exec("INSERT INTO scholar_profile VALUES(8,'Fixture NG University (FNG)','Engineering',1,'acct_fixture_other')");
  await exec('UPDATE scholar_subjects SET scholar_user_id=8 WHERE subject_id=?',[sc.subjectId]);await exec('UPDATE videos SET scholar_user_id=8 WHERE subject_id=?',[sc.subjectId]);
  await exec('UPDATE paystack_ng_offerings SET scholar_id=8 WHERE subject_id=?',[sc.subjectId]);sc.scholarId=8;await seed(sc,100,{mixed:false});
  const s=service(),o=await order(s,sc,47),r=await confirm(s,o);assert.equal(r.ordinal,101);assert.equal(r.scholarMinor,75000);
  const controller=loadWithPool('src/controller/purchaseController.js',{'../models/purchases':{PurchaseModel:{}},'../utils/generalCourses':{annotateCourses:()=>{}},'../services/paymentRelease':{paymentRuntime:()=>{throw Error('RUNTIME_DENIED');}}});
  let response,status=200;const res={status(n){status=n;return this;},json(value){response=value;}};await controller.getAllTransactions({},res);assert.equal(status,200);assert.equal(response.transactions.find(p=>Number(p.purchase_id)===r.purchaseId).provider,'stripe');
  const ops=require('../src/services/operations/data').createData(pool);const tx=await ops.transactions({userId:'47'});assert.equal(tx.rows.find(p=>p.reference==='bundle-'+r.purchaseId).provider,'legacy');
  const model=loadWithPool('src/models/scholarSubjects.js').ScholarSubjectModel;const[rows]=await model.getScholarSubjectsStatus(8);assert.equal(Number(rows[0].total_revenue),2100);assert.equal(Number(rows[0].sales_count),101);
  const old=await require('../src/services/payments/earningsService').scholarEarnings(pool,8);const ng=await s.api.earnings(8);
  assert.equal(old.summariesByCurrency.NGN.scholarEarnings,'1050.00');assert.equal(old.summariesByCurrency.NGN.authoritativeEarned,'0.00');assert.equal(ng.scholarMinor,75000);
  const[currency]=await pool.query('SELECT currency,SUM(amount) AS amount FROM subject_purchases WHERE subject_id=? GROUP BY currency',[sc.subjectId]);
  report.observations.reporting={status:'BLOCKERS_REPRODUCED',adminProvider:'stripe',operationsProvider:'legacy',mixedRevenue:'2100.00 (invalid EUR+NGN sum)',correctCurrencyTotals:currency,oldNgEstimatedScholar:'1050.00',actualHeldNgScholar:'750.00',automaticProviderCalls:unsafeProviderCalls};
 });
 await test('synthetic census EXPLAIN with and without pair-leading fixture index',async()=>{
  const[before]=await pool.query('EXPLAIN SELECT id,amount,currency,transaction_id FROM subject_purchases WHERE subject_id=? AND scholar_id=? ORDER BY id LIMIT 10001',[101,8]);
  await exec('CREATE INDEX fixture_census_pair ON subject_purchases(subject_id,scholar_id,id)');
  const[after]=await pool.query('EXPLAIN SELECT id,amount,currency,transaction_id FROM subject_purchases WHERE subject_id=? AND scholar_id=? ORDER BY id LIMIT 10001',[101,8]);
  report.observations.censusPlans={before,after,fixtureOnlyIndex:true,capacityQualified:false};
 });
}
async function finalCases(){
 await test('real receipt/event/adjustment uniqueness prevents duplicate evidence and context reuse',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,50);await confirm(s,o);const next=await order(s,sc,49);
  s.receipt(next,{transactionId:s.receipts.get(o.reference).transactionId});const before=await snapshot();await assert.rejects(confirm(s,next),e=>e.code==='ER_DUP_ENTRY');assert.deepEqual(await snapshot(),before);
  const event=crypto.randomBytes(32).toString('hex'),digest=crypto.randomBytes(32).toString('hex');
  const eventSql="INSERT INTO paystack_ng_events(merchant_account,environment,event_key,event_type,resource_id,payload_digest,order_id,received_at) VALUES('fixture_merchant','test',?,'charge.success','synthetic',?,?,UTC_TIMESTAMP())";
  await exec(eventSql,[event,digest,o.id]);await assert.rejects(exec(eventSql,[event,digest,o.id]),e=>e.code==='ER_DUP_ENTRY');
  const adjustment="INSERT INTO paystack_ng_adjustments(merchant_account,environment,order_id,event_key,kind,state,amount_minor,currency,created_at) VALUES('fixture_merchant','test',?,?,'refund','review_required',150000,'NGN',UTC_TIMESTAMP())";
  await exec(adjustment,[o.id,event]);await assert.rejects(exec(adjustment,[o.id,event]),e=>e.code==='ER_DUP_ENTRY');
  // Recording a synthetic review row is not executing a refund or revocation.
  assert.equal((await confirm(s,o)).replay,true);
 });
 await test('strict SQL rejects out-of-range money and store rejects an unsafe real-driver aggregate',async()=>{
  const sc=await scope();await assert.rejects(exec("INSERT INTO subject_purchases(buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id) VALUES(50,?,7,999999999999.00,'NGN','overflow')",[sc.subjectId]),e=>e.code==='ER_WARN_DATA_OUT_OF_RANGE');
  const p={async getConnection(){const c=await pool.getConnection();return {query:(sql,args)=>sql.includes('SUM(gross_minor)')?c.query("SELECT 1 AS sales,CAST(9007199254740993 AS UNSIGNED) AS gross,105000 AS scholar,45000 AS platform"):c.query(sql,args),release:()=>c.release()};}};
  await assert.rejects(store(p).earnings(7),e=>e.code==='INVALID_DATABASE_NUMBER');
 });
 await test('real session setup/begin/rollback failures destroy unsafe connections',async()=>{
  for(const mode of ['setup','begin','rollback']){let destroyed=0;const p={async getConnection(){const c=await pool.getConnection();return {query:async(sql,args)=>{if(mode==='setup'&&sql==='SET TRANSACTION ISOLATION LEVEL READ COMMITTED')throw Error('SETUP_FAIL');return c.query(sql,args);},beginTransaction:async()=>{if(mode==='begin')throw Error('BEGIN_FAIL');return c.beginTransaction();},commit:()=>c.commit(),rollback:async()=>{if(mode==='rollback')throw Error('ROLLBACK_FAIL');return c.rollback();},destroy:()=>{destroyed++;c.destroy();},release:()=>c.release()};}};
   await assert.rejects(store(p).transaction(()=>{throw Error('WORK_FAIL');}),mode==='rollback'?e=>e.code==='PAYSTACK_NG_TRANSACTION_UNCERTAIN':()=>true);assert.equal(destroyed,1);
  }
 });
 await test('no NG-created automatic Stripe instructions, transfers, refunds or initiation calls',async()=>{
  assert.equal(unsafeProviderCalls,0);
  const[[n]]=await pool.query('SELECT COUNT(*) AS n FROM payment_orders o JOIN paystack_ng_orders n ON n.purchase_id=o.purchase_id');assert.equal(Number(n.n),0);
  const[[p]]=await pool.query("SELECT COUNT(*) AS n FROM scholar_payouts p JOIN paystack_ng_orders n ON JSON_VALID(p.description) AND JSON_EXTRACT(p.description,'$.purchaseId')=n.purchase_id");assert.equal(Number(p.n),0);
  report.observations.automaticActions={externalCalls:0,ngStripeOrderLinks:0,ngStripePayoutLinks:0};
 });
 await test('optional Stripe foundation absent: real metadata selected explicitly, NG still atomic',async()=>{
  for(const table of ['payment_transfers','payment_allocations','payment_sale_counters','payment_orders','payment_catalogue_policy'])await exec('DROP TABLE '+table);
  meta=await metadata();assert.equal(meta.stripeCounterPresent,false);assert.equal(reviewSchema(meta).compatible,true);
  const sc=await scope(),s=service(),a=await order(s,sc,48);assert.equal((await confirm(s,a)).ordinal,1);const b=await order(s,sc,49);assert.equal((await confirm(s,b)).ordinal,2);
  const[[n]]=await pool.query('SELECT successful_sales,ng_successful_sales FROM paystack_ng_sale_counters WHERE subject_id=?',[sc.subjectId]);assert.equal(Number(n.successful_sales),2);assert.equal(Number(n.ng_successful_sales),2);
 });
}
async function main(){
 await owned();const c=await pool.getConnection();try{assert.equal(c.connection.stream.authorized,true);report.observations.tls={authorized:true,protocol:c.connection.stream.getProtocol(),hostname,serverFingerprint:input.fingerprint};}finally{c.release();}
 const[[server]]=await pool.query('SELECT VERSION() AS version,@@session.time_zone AS zone,@@session.transaction_isolation AS isolation,@@session.sql_mode AS sqlMode,@@session.innodb_lock_wait_timeout AS lockWait,@@foreign_key_checks AS fks');
 assert(/^8\.4\./.test(server.version));assert.equal(server.zone,'+00:00');assert(server.sqlMode.includes('STRICT_TRANS_TABLES'));assert.equal(Number(server.fks),1);report.observations.server=server;
 await test('synthetic core/optional Stripe fixture DDL and metadata preflight',async()=>{for(const d of [...core,...stripe])await exec('CREATE TABLE '+d+' '+options);
  await exec("INSERT INTO countries VALUES(1,'Synthetic Finland','FI'),(2,'Synthetic Nigeria','NG')");await exec("INSERT INTO universities VALUES(1,'Fixture FI University','FFI',1),(2,'Fixture NG University','FNG',2)");
  await exec('INSERT INTO users(id,fname,lname,email) VALUES ?',[Array.from({length:50},(_,i)=>[i+1,'Synthetic','User','u'+i+'@example.invalid'])]);await exec("INSERT INTO scholar_profile VALUES(7,'Fixture NG University (FNG)','Engineering',1,'acct_fixture_scholar')");
  await exec("INSERT INTO payment_catalogue_policy VALUES(1,'stripe','EUR',1)");meta=await metadata();const review=reviewSchema(meta);assert(review.compatible,JSON.stringify(review));report.observations.metadataReview=review;
 });
 if(report.tests.at(-1).status!=='PASS')return;
 await test('seven proposed Paystack tables execute unchanged on actual MySQL8.4',async()=>{for(const ddl of statements)await exec(ddl);
  const[rows]=await pool.query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'paystack_ng_%'",[input.database]);assert.equal(rows.length,7);rows.forEach(r=>{assert.equal(r.ENGINE,'InnoDB');assert.equal(r.TABLE_COLLATION,'utf8mb4_bin');});report.observations.tables=rows;
 });
 if(report.tests.at(-1).status!=='PASS')return;
 await schemaCases();await reportingCases();await ngCases();await crossProviderCases();await finalCases();
}
main().catch(e=>{report.tests.push({name:'harness preflight/execution',status:'FAIL',code:e.code,message:e.message});console.error(e.stack);}).finally(async()=>{
 for(const p of pools)await p.end();report.finished=new Date().toISOString();report.pass=report.tests.filter(t=>t.status==='PASS').length;report.fail=report.tests.filter(t=>t.status==='FAIL').length;
 console.log('PHASE2C_RESULT '+JSON.stringify(report));if(report.fail)process.exitCode=1;
});
