'use strict';
// Hard-coded synthetic MySQL target. No dotenv, deployment configuration or provider SDK.
const test=require('node:test'),assert=require('node:assert/strict'),mysql=require('mysql2/promise'),net=require('node:net'),crypto=require('node:crypto'),cp=require('node:child_process');
if(process.env.P2G_ISOLATED_TEST!=='1')throw Error('Explicit P2-G isolated fixture required');
const config={host:'127.0.0.1',port:33316,user:'root',password:'',database:'uniclips_p2g_test',connectionLimit:10,queueLimit:20,timezone:'Z'};
let pool;
test.before(async()=>{
 const admin=await mysql.createConnection({...config,database:undefined});await admin.query('CREATE DATABASE IF NOT EXISTS uniclips_p2g_test');await admin.end();pool=mysql.createPool(config);
 assert.equal((await pool.query('SELECT DATABASE() AS name'))[0][0].name,'uniclips_p2g_test');
 const tables=['conversion_fixture','scholar_payouts','subject_purchases','videos','scholar_subjects','subjects','scholar_profile','users','universities','countries'];
 for(const name of tables)await pool.query('DROP TABLE IF EXISTS '+name);
 for(const ddl of [
 'CREATE TABLE conversion_fixture(id INT PRIMARY KEY AUTO_INCREMENT,n DECIMAL(12,2),wide BIGINT,stamp DATETIME(6),data JSON,txt VARCHAR(255))',
 'CREATE TABLE countries(id INT PRIMARY KEY,name VARCHAR(50),code VARCHAR(2))',
 'CREATE TABLE universities(id INT PRIMARY KEY,name VARCHAR(100),short_name VARCHAR(20),country_id INT)',
 'CREATE TABLE users(id INT PRIMARY KEY,fname VARCHAR(50),lname VARCHAR(50),email VARCHAR(100))',
 'CREATE TABLE scholar_profile(user_id INT PRIMARY KEY,university VARCHAR(100),degree VARCHAR(100),approved TINYINT,stripe_account_id VARCHAR(100))',
 'CREATE TABLE subjects(id INT PRIMARY KEY,name VARCHAR(100),university_id INT,degree_programmes VARCHAR(100),bundle_price DECIMAL(10,2))',
 'CREATE TABLE scholar_subjects(id INT PRIMARY KEY,subject_id INT,scholar_user_id INT,approved TINYINT)',
 'CREATE TABLE videos(id INT AUTO_INCREMENT PRIMARY KEY,subject_id INT,scholar_user_id INT,approved TINYINT)',
 'CREATE TABLE subject_purchases(id INT AUTO_INCREMENT PRIMARY KEY,buyer_user_id INT,subject_id INT,scholar_id INT,amount DECIMAL(10,2),currency VARCHAR(3),transaction_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,access_expires_at DATETIME,is_access_active TINYINT DEFAULT 1,UNIQUE(buyer_user_id,subject_id,scholar_id))',
 'CREATE TABLE scholar_payouts(id INT AUTO_INCREMENT PRIMARY KEY,scholar_user_id INT,amount DECIMAL(10,2),currency VARCHAR(3),status VARCHAR(30),description TEXT,stripe_transfer_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)'
 ])await pool.query(ddl);
 await pool.query("INSERT INTO countries VALUES(1,'Synthetic Finland','FI'),(2,'Synthetic Nigeria','NG')");
 await pool.query("INSERT INTO universities VALUES(1,'Synthetic University','SYN',1),(2,'Other University','OTH',2)");
 for(let id=1;id<=8;id++)await pool.query("INSERT INTO users VALUES(?,'Synthetic','User',?)",[id,`p2g${id}@example.invalid`]);
 await pool.query("INSERT INTO scholar_profile VALUES(7,'Synthetic University (SYN)','Engineering',1,'acct_p2g')");
 await pool.query("INSERT INTO subjects VALUES(10,'Synthetic course',1,'Engineering',6),(11,'Tier course',1,'Engineering',6),(20,'NG course',2,'Engineering',6)");
 await pool.query('INSERT INTO scholar_subjects VALUES(1,10,7,1),(2,11,7,1),(3,20,7,1)');await pool.query('INSERT INTO videos(subject_id,scholar_user_id,approved) VALUES(10,7,1),(11,7,1),(20,7,1)');
});
test.after(async()=>{if(pool)await pool.end();});
test('prepared and text queries preserve decimal, bigint, JSON, UTF-8 and datetime microseconds',async()=>{
 const c=await mysql.createConnection({...config,supportBigNumbers:true,bigNumberStrings:true});
 try{const text="quote'\\; -- \u{1f4a1}",json={kind:'synthetic',count:3},date='2026-10-16 12:34:56.123456';
 await c.execute('INSERT INTO conversion_fixture(n,wide,stamp,data,txt) VALUES(?,?,?,?,?)',['1500.00','9007199254740993',date,JSON.stringify(json),text]);
 const[[r]]=await c.execute("SELECT n,wide,data,txt,DATE_FORMAT(stamp,'%Y-%m-%d %H:%i:%s.%f') AS stamp FROM conversion_fixture WHERE id=?",[1]);
 assert.equal(r.n,'1500.00');assert.equal(r.wide,'9007199254740993');assert.deepEqual(r.data,json);assert.equal(r.txt,text);assert.equal(r.stamp,date);
 assert.equal((await c.query('SELECT ? AS value',[text]))[0][0].value,text);
 const d=new Date('2026-01-31T12:00:00.000Z');assert.equal((await c.execute('SELECT ? AS value',[d]))[0][0].value.toISOString(),d.toISOString());
 assert.equal((await c.query("SELECT DATE_ADD('2026-01-31',INTERVAL 5 MONTH) AS expiry"))[0][0].expiry,'2026-06-30');
 }finally{await c.end();}
});
test('transaction commit and rollback preserve expected row visibility',async()=>{
 const c=await pool.getConnection();try{await c.beginTransaction();await c.query('INSERT INTO conversion_fixture(txt) VALUES(?)',['rolled back']);await c.rollback();assert.equal((await c.query('SELECT COUNT(*) AS n FROM conversion_fixture WHERE txt=?',['rolled back']))[0][0].n,0);await c.beginTransaction();await c.query('INSERT INTO conversion_fixture(txt) VALUES(?)',['committed']);await c.commit();assert.equal((await pool.query('SELECT COUNT(*) AS n FROM conversion_fixture WHERE txt=?',['committed']))[0][0].n,1);}finally{c.release();}
});
test('advisory locks stay connection-owned across transaction commits and release correctly',async()=>{
 const a=await pool.getConnection(),b=await pool.getConnection(),name='uniclips:p2g:synthetic-lock';
 try{assert.equal((await a.query('SELECT GET_LOCK(?,0) AS n',[name]))[0][0].n,1);await a.beginTransaction();await a.commit();assert.equal((await b.query('SELECT GET_LOCK(?,0) AS n',[name]))[0][0].n,0);await a.query('SELECT RELEASE_LOCK(?)',[name]);assert.equal((await b.query('SELECT GET_LOCK(?,0) AS n',[name]))[0][0].n,1);}finally{await a.query('SELECT RELEASE_LOCK(?)',[name]);await b.query('SELECT RELEASE_LOCK(?)',[name]);a.release();b.release();}
});
test('finite real pool rejects queue overflow and queued acquisitions recover',async()=>{
 const p=mysql.createPool({...config,connectionLimit:1,queueLimit:2});let held,one,two;
 try{held=await p.getConnection();const q1=p.getConnection(),q2=p.getConnection();await assert.rejects(p.getConnection(),/Queue limit reached/);held.release();held=null;one=await q1;assert.equal((await one.query('SELECT 1 AS n'))[0][0].n,1);one.release();one=null;two=await q2;two.release();two=null;}finally{held?.release();one?.release();two?.release();await p.end();}
});
test('real query deadline maps safely and destroys the leased connection before reuse',async()=>{
 const p=mysql.createPool({...config,connectionLimit:1,queueLimit:1});try{const old=(await p.query('SELECT CONNECTION_ID() AS id'))[0][0].id;const{readQuery}=require('../src/utils/readCapacity');await assert.rejects(readQuery(p,'SELECT SLEEP(11)'),e=>e.status===503&&e.code==='READ_CAPACITY_UNAVAILABLE');const next=(await p.query('SELECT CONNECTION_ID() AS id'))[0][0].id;assert.notEqual(old,next);}finally{await p.end();}
});
test('real MySQL compression supports normal bounded query roundtrips',async()=>{const c=await mysql.createConnection({...config,compress:true});try{const[[r]]=await c.query("SELECT REPEAT('abc',1000) AS value");assert.equal(r.value,'abc'.repeat(1000));}finally{await c.end();}});
test('caching_sha2_password authenticates a synthetic password over verified TLS',async()=>{
 const user='p2g_driver_fixture';await pool.query("CREATE USER IF NOT EXISTS 'p2g_driver_fixture'@'%' IDENTIFIED WITH caching_sha2_password BY 'P2G_SYNTHETIC_PASSWORD_ONLY'");await pool.query("GRANT SELECT ON uniclips_p2g_test.* TO 'p2g_driver_fixture'@'%'");let c;
 try{const read=f=>cp.execFileSync('docker',['exec','uniclips-payment-phase2a-test','cat','/var/lib/mysql/'+f]);const ca=Buffer.from(read('ca.pem').toString().replace(/\0+$/,'')),cert=new crypto.X509Certificate(read('server-cert.pem')),hostname=cert.subject.match(/(?:^|\n)CN=(.+)/)[1];
 const opts=require('../src/config/databaseTls').buildPoolConfig({NODE_ENV:'production',DB_HOST:hostname,DB_PORT:'33316',DB_USER:user,DB_PASS:'P2G_SYNTHETIC_PASSWORD_ONLY',DB_NAME:config.database,DB_SSL:'true',DB_SSL_CA:'/synthetic/ca.pem'},()=>ca);
 c=await mysql.createConnection({...opts,stream:()=>net.connect(33316,'127.0.0.1')});assert.equal(c.connection.stream.authorized,true);assert.equal((await c.query('SELECT COUNT(*) AS n FROM conversion_fixture'))[0][0].n>=1,true);
 }finally{if(c)await c.end();await pool.query("DROP USER IF EXISTS 'p2g_driver_fixture'@'%'");}
});
let providerSequence=0;
function releaseFixture(){
 const{TYPE}=require('../src/services/paymentRelease/stripeProvider'),sessions=new Map(),transfers=[];let next=0,transferCreates=0;
 const identity={account:'acct_p2g_platform',livemode:false};
 const provider={identity:async()=>identity,createCheckout:async(snapshot,signature)=>{const n=++providerSequence,id='cs_p2g_'+n,paymentId='pi_p2g_'+n,metadata={type:TYPE,snapshot:JSON.stringify(snapshot),signature};sessions.set(id,{session:{id,mode:'payment',client_reference_id:snapshot.nonce,amount_total:snapshot.amountMinor,currency:'eur',payment_status:'paid',livemode:false,metadata},identity,payment:{id:paymentId,status:'succeeded',amount_received:snapshot.amountMinor,currency:'eur',livemode:false,metadata},charge:{id:'ch_p2g_'+n,paid:true,amount:snapshot.amountMinor,currency:'eur',payment_intent:paymentId,livemode:false,created:Date.now()/1000|0,amount_refunded:0,disputed:false}});return{id,url:'https://example.invalid/checkout'};},evidence:async id=>structuredClone(sessions.get(id)),retrieveAccount:async()=>({country:'FI',capabilities:{transfers:'active'},payouts_enabled:true}),findReleaseTransfers:async group=>transfers.filter(t=>t.transfer_group===group),createReleaseTransfer:async x=>{transferCreates++;const t={id:'tr_p2g_'+transferCreates,amount:x.amountMinor,currency:'eur',destination:x.destination,source_transaction:x.chargeId,transfer_group:x.group,metadata:{release:TYPE,purchaseId:String(x.purchaseId),instructionId:String(x.id)}};transfers.push(t);return t;}};
 const runtime=require('../src/services/paymentRelease/service').createReleaseService({pool,provider,signingSecret:'P2G_SYNTHETIC_SIGNING_SECRET'});return{runtime,provider,sessions,creates:()=>transferCreates};
}
test('Stripe fulfilment remains verified, idempotent and atomic; earnings and transfer are currency-safe doubles',async()=>{
 const f=releaseFixture(),checkout=await f.runtime.payments.createOrder(1,10,7),evidence=f.sessions.get(checkout.sessionId),bad=structuredClone(evidence);bad.session.amount_total=601;f.sessions.set(checkout.sessionId,bad);await assert.rejects(f.runtime.payments.verifySession(checkout.sessionId,1));f.sessions.set(checkout.sessionId,evidence);
 const results=await Promise.all([f.runtime.payments.verifySession(checkout.sessionId,1),f.runtime.payments.verifySession(checkout.sessionId,1)]);assert.ok(results.every(r=>r.success));assert.equal((await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE subject_id=10'))[0][0].n,1);assert.equal((await pool.query('SELECT access_expires_at=DATE_ADD(created_at,INTERVAL 5 MONTH) AS n FROM subject_purchases WHERE subject_id=10'))[0][0].n,1);
 const earnings=require('../src/services/payments/earningsService').scholarEarnings;let report=await earnings(pool,7);assert.equal(report.summary.scholarEarnings,'4.20');assert.equal(report.summary.pendingBalance,'4.20');assert.equal(report.summary.currency,'EUR');
 await f.runtime.transferOrder(results[0].orderId);await f.runtime.transferOrder(results[0].orderId);assert.equal(f.creates(),1);report=await earnings(pool,7);assert.equal(report.summary.totalPaid,'4.20');
 await assert.rejects(f.runtime.payments.createOrder(2,20,7),/market/);
});
test('failed payment-instruction persistence rolls back access and can later fulfil once',async()=>{
 const f=releaseFixture(),order=await f.runtime.payments.createOrder(2,10,7);const faulty={getConnection:async()=>{const c=await pool.getConnection();return new Proxy(c,{get(t,k){if(k==='query')return(sql,args)=>{if(sql.startsWith('INSERT INTO scholar_payouts'))throw Error('SYNTHETIC_INSTRUCTION_FAILURE');return t.query(sql,args);};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};
 const r=require('../src/services/paymentRelease/service').createReleaseService({pool:faulty,provider:f.provider,signingSecret:'P2G_SYNTHETIC_SIGNING_SECRET'});await assert.rejects(r.payments.verifySession(order.sessionId,2),/SYNTHETIC_INSTRUCTION_FAILURE/);assert.equal((await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE buyer_user_id=2'))[0][0].n,0);await f.runtime.payments.verifySession(order.sessionId,2);assert.equal((await pool.query('SELECT COUNT(*) AS n FROM subject_purchases WHERE buyer_user_id=2'))[0][0].n,1);
});
test('concurrent real fulfilments retain the 99/100/101 earnings boundary',async()=>{
 for(let n=0;n<98;n++)await pool.query("INSERT INTO subject_purchases(buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id) VALUES(?,11,7,6,'EUR',?)",[1000+n,'pi_p2g_history_'+n]);const f=releaseFixture(),orders=await Promise.all([3,4,5].map(id=>f.runtime.payments.createOrder(id,11,7)));await Promise.all(orders.map((o,i)=>f.runtime.payments.verifySession(o.sessionId,3+i)));
 const rows=(await pool.query('SELECT description FROM scholar_payouts'))[0].map(r=>JSON.parse(r.description)).filter(r=>orders.some(o=>o.sessionId===r.sessionId));assert.deepEqual(rows.map(r=>r.ordinal).sort((a,b)=>a-b),[99,100,101]);assert.deepEqual(rows.map(r=>r.amountMinor).sort((a,b)=>a-b),[300,420,420]);
});