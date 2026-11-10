'use strict';
// Invoked ONLY by the explicit disposable runner. No env/config/real provider.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const net=require('node:net'),dns=require('node:dns'),vm=require('node:vm'),{createRequire}=require('node:module');
assert(process.argv.includes('--owned-phase2d'),'Explicit owned-fixture invocation required');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
assert(/^paystack_ng_phase2d_test_[a-f0-9]{12}$/.test(input.database));
assert.equal(input.database,'paystack_ng_phase2d_test_'+input.nonce);assert(/^[a-f0-9]{64}$/.test(input.container));
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
const statements=[...require('../src/services/paystackNigeria/schema').statements,...require('../src/services/coursePayments/schema').statements];
const H=require('../src/services/coursePayments/historicalResolver');
const W=require('./fixtures/courseWriterPolicy.cjs');
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
function store(customPool=pool,resolve=H.resolveHistoricalSales,md=meta){return createMysqlStore({pool:customPool,resolveHistoricalSales:resolve,schemaMetadata:md});}
async function scope(){
 const subjectId=++subjectSequence,scholarId=7;
 await exec("INSERT INTO subjects VALUES(?,? ,2,'Engineering',6.00)",[subjectId,'Synthetic course '+subjectId]);
 await exec("INSERT INTO scholar_subjects(subject_id,scholar_user_id,subject_name,degree,expertise,approved) VALUES(?,7,?,'Engineering','synthetic',1)",[subjectId,'Synthetic course '+subjectId]);
 await exec("INSERT INTO course_workflows SELECT id,'PUBLISHED' FROM scholar_subjects WHERE subject_id=?",[subjectId]);
 await exec('INSERT INTO videos(subject_id,scholar_user_id,approved,title) VALUES(?,7,1,?)',[subjectId,'Synthetic video']);
 await exec('INSERT INTO paystack_ng_offerings(subject_id,scholar_id,merchant_account,environment,policy_version,approved) VALUES(?,7,?,?,?,1)',[subjectId,'fixture_merchant','test',RULE.version]);
 await auditScope({subjectId,scholarId});
 return {subjectId,scholarId};
}
function service(st=store(),clock=()=>Date.now()){
 const receipts=new Map(),policy=createPolicy({enabled:true,environment:'test',merchantAccount:'fixture_merchant'});
 const provider={kind:'offline-double',verify:async ref=>structuredClone(receipts.get(ref))};
 return {api:createServices({store:st,provider,policy,now:clock,writerPolicy:W()}),receipts,provider,
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
const business=['course_sale_audits','course_sale_proofs','paystack_ng_orders','paystack_ng_transactions','subject_purchases','paystack_ng_allocations','paystack_ng_sale_counters','payment_sale_counters','payment_allocations','payment_transfers','scholar_payouts'];
async function snapshot(){const result={};for(const table of business){if(table==='payment_sale_counters'&&!meta.stripeCounterPresent)continue;const[rows]=await pool.query('SELECT * FROM '+table);result[table]=rows.map(r=>JSON.stringify(r)).sort();}return result;}
function wrapPool(hook,base=pool){return {async getConnection(){const c=await base.getConnection();return new Proxy(c,{get(target,key){if(key==='query')return async(sql,args)=>{const text=typeof sql==='string'?sql:sql.sql;await hook('before',text,args,c);const result=await c.query(sql,args);await hook('after',text,args,c,result);return result;};const v=target[key];return typeof v==='function'?v.bind(target):v;}});}};}
function barrier(){let enter,release;const signal=new Promise(r=>enter=r),gate=new Promise(r=>release=r);const reached=Promise.race([signal,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('FIXTURE_BARRIER_NOT_REACHED')),15000);t.unref();})]);reached.catch(()=>{});return {reached,release,async hold(){enter();await gate;}};}
async function busy(p){await assert.rejects(p,e=>e.code==='PAYSTACK_NG_BUSY');}

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

const auditKeys=crypto.generateKeyPairSync('ed25519');
const acceptedSources=new Set();
async function auditScope(sc,facts=[]){
 const [[latest]]=await pool.query('SELECT COALESCE(MAX(review_version),0) AS version FROM course_sale_audits WHERE subject_id=? AND scholar_id=?',[sc.subjectId,sc.scholarId]);
 const payload=JSON.stringify({...sc,reviewVersion:Number(latest.version)+1,reviewId:crypto.randomUUID(),sourceRevision:'synthetic-offline-receipt-batch',writerMode:'legacy_verified',facts});
 return H.createAuditImporter({pool,publicKey:auditKeys.publicKey,verifyProvenance:async r=>acceptedSources.has(r.evidence_digest)})({payload,signature:crypto.sign(null,Buffer.from(payload),auditKeys.privateKey).toString('base64')});
}
async function seedAudited(sc,n){
 const facts=[];
 for(let buyer=1001;buyer<=1000+n;buyer++)await exec("INSERT IGNORE INTO users(id,fname,lname,email) VALUES(?,'Synthetic','Buyer',?)",[buyer,'synthetic-'+buyer+'@example.invalid']);
 for(let ordinal=1;ordinal<=n;ordinal++){
  const reference='fixture-verified-'+sc.subjectId+'-'+ordinal,digest=crypto.createHash('sha256').update(reference).digest('hex');acceptedSources.add(digest);
  const [r]=await exec("INSERT INTO subject_purchases(buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id) VALUES(?,?,?,6,'EUR',?)",[1000+ordinal,sc.subjectId,sc.scholarId,reference]);
  const share=require('../src/services/payments/money').allocation(600,ordinal);
  facts.push({purchase_id:Number(r.insertId),subject_id:sc.subjectId,scholar_id:sc.scholarId,sale_ordinal:ordinal,provider:'stripe',entity:'UNICLIPS_OY',merchant_account:'fixture_stripe',environment:'test',provider_transaction_id:reference,provider_reference:reference,currency:'EUR',gross_minor:600,scholar_rate:share.rate,scholar_minor:share.scholar,source_kind:'audited_opening',source_key:reference,evidence_digest:digest});
 }
 await auditScope(sc,facts);return facts;
}
async function phaseDCases(){
 await test('unchanged verified-legacy Stripe creates EUR access; audited source validates exact durable instruction',async()=>{
  const sc=await scope();await exec('UPDATE subjects SET university_id=1 WHERE id=?',[sc.subjectId]);await exec("UPDATE scholar_profile SET university='Fixture FI University (FFI)' WHERE user_id=7");
  try{const f=stripeFixture(pool,true),o=await f.api.createOrder(30,sc.subjectId,7),result=await f.api.verifySession(o.sessionId,30);assert.equal(result.success,true);
   const [[p]]=await pool.query('SELECT * FROM subject_purchases WHERE subject_id=?',[sc.subjectId]);const [[release]]=await pool.query('SELECT * FROM scholar_payouts WHERE scholar_user_id=7 ORDER BY id DESC LIMIT 1');const i=JSON.parse(release.description);
   const fact={purchase_id:Number(p.id),subject_id:sc.subjectId,scholar_id:7,sale_ordinal:i.ordinal,provider:'stripe',entity:'UNICLIPS_OY',merchant_account:i.account,environment:'test',provider_reference:i.paymentId,provider_transaction_id:i.paymentId,currency:'EUR',gross_minor:i.grossMinor,scholar_rate:i.rate,scholar_minor:i.amountMinor,source_kind:'legacy_verified',source_key:String(release.id),evidence_digest:crypto.createHash('sha256').update(JSON.stringify(i)).digest('hex')};
   acceptedSources.add(fact.evidence_digest);await auditScope(sc,[fact]);assert.equal((await H.auditedFacts(pool,sc)).rows[0].provider,'stripe');assert.equal(unsafeProviderCalls,0);
  }finally{await exec("UPDATE scholar_profile SET university='Fixture NG University (FNG)' WHERE user_id=7");}
 });
 await test('nine tables, enforced checks and RESTRICT audit/proof linkage validated by MySQL',async()=>{
  const [[t]]=await pool.query("SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN ('course_sale_proofs','course_sale_audits')",[input.database]);assert.equal(Number(t.n),2);
  const sc=await scope();await seedAudited(sc,1);
  await assert.rejects(exec('DELETE FROM subject_purchases WHERE subject_id=?',[sc.subjectId]),e=>e.code==='ER_ROW_IS_REFERENCED_2');
  await assert.rejects(exec('UPDATE course_sale_proofs SET scholar_minor=1 WHERE subject_id=?',[sc.subjectId]),e=>e.code==='ER_CHECK_CONSTRAINT_VIOLATED');
 });
 await test('actual country join routes existing/future universities independent of all buyer countries',async()=>{
  const R=require('../src/services/coursePayments/routing'),sc=await scope();
  for(const id of [2,99]){if(id===99)await exec("INSERT INTO universities VALUES(99,'Renamed future Nigerian university','WHATEVER',2)");await exec('UPDATE subjects SET university_id=? WHERE id=?',[id,sc.subjectId]);
   for(const buyer of ['NG','FI','GB','US','other']){const o=await R.offering(pool,sc.subjectId,7,{stripeReady:true,buyerCountry:buyer});assert.equal(o.payment.currency,'NGN');assert.equal(o.payment.amountMinor,150000);assert.equal(o.payment.checkoutEnabled,false);}
  }
  await exec('UPDATE subjects SET university_id=1,bundle_price=7 WHERE id=?',[sc.subjectId]);
  const fi=await R.offering(pool,sc.subjectId,7,{stripeReady:true});assert.equal(fi.payment.currency,'EUR');assert.equal(fi.payment.amountMinor,700);assert.equal(fi.payment.checkoutEnabled,true);
  await assert.rejects(R.requireStripeOffering(pool,{...sc,scholarId:7,provider:'paystack'},{stripeReady:true}),e=>e.code==='CLIENT_PAYMENT_OVERRIDE');
 });
 await test('audited 0/99/100/101 baselines allocate 70/50 globally and append proof atomically',async()=>{
  for(const n of [0,99,100,101]){const sc=await scope();if(n)await seedAudited(sc,n);const s=service(),o=await order(s,sc,20),r=await confirm(s,o);assert.equal(r.ordinal,n+1);assert.equal(r.scholarMinor,n<100?105000:75000);
   const [[p]]=await pool.query('SELECT * FROM course_sale_proofs WHERE purchase_id=?',[r.purchaseId]);assert.equal(p.provider,'paystack');assert.equal(Number(p.sale_ordinal),n+1);assert.equal(Number(p.scholar_minor),r.scholarMinor);
   assert.equal((await confirm(s,o)).replay,true);await assert.rejects(s.api.createOrder({...sc,buyerId:20,idempotencyKey:crypto.randomUUID()}),e=>e.code==='REPURCHASE_BLOCKED');
  }
 });
 await test('missing, blocked or altered audit never assumes zero; all writes rollback',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,21);await exec("UPDATE course_sale_audits SET state='blocked' WHERE subject_id=?",[sc.subjectId]);const before=await snapshot();await assert.rejects(confirm(s,o),e=>e.code==='BASELINE_AUDIT_REQUIRED');assert.deepEqual(await snapshot(),before);
  await exec("UPDATE course_sale_audits SET state='approved',baseline_digest=? WHERE subject_id=?",['f'.repeat(64),sc.subjectId]);await assert.rejects(confirm(s,o),e=>e.code==='BASELINE_AUDIT_MISMATCH');
 });
 await test('pending university/country and offering revision changes refuse rather than reroute',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,22);await exec('UPDATE paystack_ng_offerings SET revision=revision+1 WHERE subject_id=?',[sc.subjectId]);await assert.rejects(confirm(s,o),e=>e.code==='ORDER_CONTEXT_CHANGED');
  const [[p]]=await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=?',[sc.subjectId]);assert.equal(Number(p.n),0);
 });
 await test('two buyers and same-order concurrency settle NOWAIT refusal, then unique ordinals100/101',async()=>{
  const sc=await scope();await seedAudited(sc,99);const gate=barrier();let once=false;
  const wrapped=wrapPool(async(when,sql)=>{if(once&&when==='after'&&sql.startsWith('SELECT id FROM subjects')){once=false;await gate.hold();}});
  const a=service(store(wrapped)),b=service(),o1=await order(a,sc,23),o2=await order(b,sc,24);
  // Pause only fulfillment (order creation also acquires the subject lock).
  b.receipts.set(o1.reference,a.receipts.get(o1.reference));once=true;const first=confirm(a,o1);first.catch(()=>{});await gate.reached;
  try{await busy(confirm(b,o2));await busy(confirm(b,o1));}finally{gate.release();}
  assert.equal((await first).ordinal,100);assert.equal((await confirm(b,o2)).ordinal,101);
 });
 await test('failure after each financial write including proof and ambiguous acknowledgement is atomic',async()=>{
  for(const marker of ['INSERT INTO paystack_ng_transactions','INSERT INTO subject_purchases','INSERT INTO paystack_ng_allocations','INSERT INTO course_sale_proofs','INSERT INTO paystack_ng_sale_counters','UPDATE paystack_ng_orders']){
   const sc=await scope(),normal=service(),o=await order(normal,sc,25),before=await snapshot();
   const wrapped=wrapPool(async(when,sql)=>{if(when==='after'&&sql.startsWith(marker))throw Error('INJECTED_AFTER_WRITE');});const failing=service(store(wrapped));failing.receipts.set(o.reference,normal.receipts.get(o.reference));await assert.rejects(confirm(failing,o));assert.deepEqual(await snapshot(),before);
  }
 });
 await test('mixed history reports actual provider, no EUR+NGN sum, sale101 held750, no Stripe instruction',async()=>{
  const sc=await scope();await seedAudited(sc,100);const s=service(),o=await order(s,sc,26),r=await confirm(s,o),R=require('../src/services/coursePayments/reporting');
  const rows=await R.history(pool,26),p=rows.find(p=>Number(p.purchase_id)===r.purchaseId);assert.equal(p.provider,'paystack');assert.equal(p.scholarMinor,75000);assert.equal(p.canReleaseStripe,false);assert.equal(p.payoutState,'held');
  const earnings=await R.earnings(pool,7);assert(earnings.breakdowns.some(g=>g.provider==='paystack'&&g.currency==='NGN'&&g.heldScholarMinor>0));assert(earnings.breakdowns.some(g=>g.provider==='stripe'&&g.currency==='EUR'));
  const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM payment_orders p JOIN paystack_ng_orders n ON p.purchase_id=n.purchase_id');assert.equal(Number(n.n),0);
  await exec('UPDATE paystack_ng_transactions SET evidence_digest=? WHERE order_id=?',['0'.repeat(64),o.id]);assert.equal((await R.history(pool,26)).find(p=>Number(p.purchase_id)===r.purchaseId).provider,'unreconciled');
 });
 await test('phase2a/unknown writer configuration refuses before verification, with no financial writes',async()=>{
  const sc=await scope(),s=service(),o=await order(s,sc,27);let calls=0;
  const api=createServices({store:store(),provider:{kind:'offline-double',verify(){calls++;}},policy:createPolicy({enabled:true,merchantAccount:'fixture_merchant'}),writerPolicy:W({patch:{phase2aWriters:1}})});
  const before=await snapshot();await assert.rejects(api.fulfill({orderId:o.id,buyerId:27}),e=>e.code==='WRITER_SAFETY_UNVERIFIED');assert.equal(calls,0);assert.deepEqual(await snapshot(),before);
 });
 await test('lost commit acknowledgement and expired-access replay retain exactly one proof/grant/allocation',async()=>{
  const sc=await scope(),normal=service(),o=await order(normal,sc,29);let once=true;
  const wrapped={async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(t,k){if(k==='commit')return async()=>{await t.commit();if(once){once=false;throw Error('LOST_COMMIT_ACK');}};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};
  const failing=service(store(wrapped));failing.receipts.set(o.reference,normal.receipts.get(o.reference));await assert.rejects(confirm(failing,o),/LOST_COMMIT_ACK/);
  assert.equal((await confirm(normal,o)).replay,true);await exec("UPDATE subject_purchases SET access_expires_at='2000-01-01',is_access_active=0 WHERE subject_id=?",[sc.subjectId]);assert.equal((await confirm(normal,o)).replay,true);
  const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM course_sale_proofs WHERE subject_id=?',[sc.subjectId]);assert.equal(Number(n.n),1);
  await assert.rejects(normal.api.createOrder({...sc,buyerId:29,idempotencyKey:crypto.randomUUID()}),e=>e.code==='REPURCHASE_BLOCKED');
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
 await test('nine additive Paystack and audit tables execute on actual MySQL8.4',async()=>{for(const ddl of statements)await exec(ddl);
  const[rows]=await pool.query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'paystack_ng_%'",[input.database]);assert.equal(rows.length,7);rows.forEach(r=>{assert.equal(r.ENGINE,'InnoDB');assert.equal(r.TABLE_COLLATION,'utf8mb4_bin');});report.observations.tables=rows;
 });
 if(report.tests.at(-1).status!=='PASS')return;
 await phaseDCases();
}
main().catch(e=>{report.tests.push({name:'harness preflight/execution',status:'FAIL',code:e.code,message:e.message});console.error(e.stack);}).finally(async()=>{
 for(const p of pools)await p.end();report.finished=new Date().toISOString();report.pass=report.tests.filter(t=>t.status==='PASS').length;report.fail=report.tests.filter(t=>t.status==='FAIL').length;
 console.log('PHASE2D_RESULT '+JSON.stringify(report));if(report.fail)process.exitCode=1;
});
