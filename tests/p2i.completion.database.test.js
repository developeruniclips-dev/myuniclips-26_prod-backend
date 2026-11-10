'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
if(process.env.P2I_ISOLATED_TEST!=='1')throw Error('Explicit isolated P2-I fixture required');
const C=require('../src/utils/readCapacity'),config={host:'127.0.0.1',port:33316,user:'root',password:'',database:'uniclips_p2i_i1_test',connectionLimit:10,queueLimit:20,waitForConnections:true};let pool;
const inject=(file,exports)=>{const p=require.resolve(file);require.cache[p]={id:p,filename:p,loaded:true,exports};};
test.before(async()=>{const admin=await mysql.createConnection({...config,database:undefined});await admin.query('CREATE DATABASE IF NOT EXISTS uniclips_p2i_i1_test');await admin.end();pool=mysql.createPool(config);
 for(const name of ['items','users','subjects','scholar_subjects','course_workflows','scholar_profile','purchases','subject_purchases','videos','payment_allocations','payment_orders','payment_transfers','scholar_payouts'])await pool.query('DROP TABLE IF EXISTS '+name);
 for(const ddl of [
 'CREATE TABLE items(id INT PRIMARY KEY,owner_id INT,created_at DATETIME(6),INDEX(owner_id,id))',
 'CREATE TABLE users(id INT PRIMARY KEY,fname VARCHAR(50),lname VARCHAR(50),email VARCHAR(100))',
 'CREATE TABLE subjects(id INT PRIMARY KEY,name VARCHAR(50),bundle_price DECIMAL(10,2),university_id INT,degree_programmes VARCHAR(100))',
 'CREATE TABLE scholar_subjects(id INT PRIMARY KEY,scholar_user_id INT,subject_id INT,subject_name VARCHAR(50),degree VARCHAR(50),expertise TEXT,approved INT,created_at DATETIME,INDEX(scholar_user_id))',
 'CREATE TABLE course_workflows(offering_id INT PRIMARY KEY,state VARCHAR(50))',
 'CREATE TABLE scholar_profile(user_id INT PRIMARY KEY,approved INT)',
 'CREATE TABLE videos(id INT PRIMARY KEY,title VARCHAR(50),subject_id INT,scholar_user_id INT)',
 'CREATE TABLE purchases(id INT PRIMARY KEY,buyer_user_id INT,video_id INT,amount DECIMAL(10,2))',
 'CREATE TABLE subject_purchases(id INT PRIMARY KEY,buyer_user_id INT,subject_id INT,scholar_id INT,amount DECIMAL(10,2),currency VARCHAR(3),transaction_id VARCHAR(100),created_at DATETIME,access_expires_at DATETIME,is_access_active INT,INDEX(scholar_id,created_at,id))',
 'CREATE TABLE payment_allocations(order_id VARCHAR(50),scholar_id INT,currency VARCHAR(3),scholar_minor INT)',
 'CREATE TABLE payment_orders(id VARCHAR(50),purchase_id INT,refund_state VARCHAR(20),dispute_state VARCHAR(20))',
 'CREATE TABLE payment_transfers(order_id VARCHAR(50),state VARCHAR(20),transfer_id VARCHAR(50),completed_at DATETIME)',
 'CREATE TABLE scholar_payouts(id INT PRIMARY KEY,scholar_user_id INT,currency VARCHAR(3),amount DECIMAL(10,2),status VARCHAR(20),description TEXT,stripe_transfer_id VARCHAR(50),created_at DATETIME)'
 ])await pool.query(ddl);
 await pool.query('ALTER TABLE subject_purchases ADD renewed_at DATETIME NULL');
 inject('../src/config/db',{pool,initializeDatabase:async()=>{}});
});
test.after(async()=>{if(pool)await pool.end();});
test('real MySQL complete results, ownership, timestamp ordering and 10001 overflow',async()=>{
 for(let start=1;start<=10001;start+=500){const rows=Array.from({length:Math.min(500,10002-start)},(_,i)=>[start+i,7,'2026-01-01 00:00:00.123456']);await pool.query('INSERT INTO items VALUES ?',[rows]);}
 assert.equal((await C.readBounded(pool,'SELECT * FROM items WHERE id<0'))[0].length,0);assert.equal((await C.readBounded(pool,'SELECT * FROM items WHERE id=1'))[0].length,1);
 const [rows]=await C.readBounded(pool,'SELECT * FROM items WHERE owner_id=? AND id<=10000 ORDER BY created_at DESC,id DESC',[7]);assert.equal(rows.length,10000);assert.equal(rows[0].id,10000);assert.equal(rows.at(-1).id,1);
 await assert.rejects(C.readBounded(pool,'SELECT * FROM items WHERE owner_id=? ORDER BY created_at DESC,id DESC',[7]),e=>e.status===503&&e.code==='READ_RESULTS_UNAVAILABLE');assert.equal((await C.readBounded(pool,'SELECT * FROM items WHERE owner_id=?',[8]))[0].length,0);
 const [plan]=await pool.query('EXPLAIN SELECT * FROM items WHERE owner_id=7 ORDER BY id DESC LIMIT 10001');assert.ok(plan.length);assert.equal(C.catalogueReads.status().active,0);
});
test('actual buyer/bundle/expired/sales queries retain authorization, fields and order',async()=>{
 await pool.query("INSERT INTO users VALUES (1,'buyer','fixture','buyer@example.invalid'),(7,'scholar','fixture','scholar@example.invalid'),(8,'other','buyer','other@example.invalid')");await pool.query("INSERT INTO subjects VALUES(1,'fixture',6,1,'degree')");await pool.query("INSERT INTO videos VALUES(1,'lesson',1,7)");await pool.query('INSERT INTO purchases VALUES(1,1,1,6),(2,8,1,7)');
 await pool.query("INSERT INTO subject_purchases(id,buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active) VALUES(1,1,1,7,6,'EUR','fixture-1','2026-01-01','2020-01-01',1),(2,8,1,7,7,'USD','fixture-2','2026-02-01','2020-01-01',1)");
 const {PurchaseModel:M}=require('../src/models/purchases');assert.equal((await M.findByUser(1))[0].length,1);const own=(await M.getUserSubjectPurchases(1))[0];assert.equal(own.length,1);assert.equal(own[0].buyer_user_id,1);assert.equal(own[0].is_active,0);assert.equal((await M.getExpiredPurchases(1))[0].length,1);assert.deepEqual((await M.getScholarSubjectSales(7))[0].map(r=>r.id),[2,1]);
});
test('Scholar aggregate filter is SQL-equivalent and does not mix another Scholar',async()=>{
 await pool.query("INSERT INTO scholar_subjects VALUES(1,7,1,'fixture','degree','fixture',1,'2026-01-01'),(2,8,1,'other','degree','fixture',1,'2026-01-01')");
 const {ScholarSubjectModel:M}=require('../src/models/scholarSubjects');const [rows]=await M.getScholarSubjectsStatus(7);assert.equal(rows.length,1);assert.equal(Number(rows[0].total_revenue),6);assert.equal(rows[0].total_revenue_currency,'EUR');assert.equal(Number(rows[0].sales_count),2);
 const [original]=await pool.query('SELECT currency,SUM(amount) AS revenue,COUNT(*) AS sales FROM subject_purchases WHERE subject_id=1 AND scholar_id=7 GROUP BY currency');
 const buckets=typeof rows[0].revenue_by_currency==='string'?JSON.parse(rows[0].revenue_by_currency):rows[0].revenue_by_currency;
 for(const r of original)assert.equal(Number(buckets[r.currency]),Number(r.revenue));
 assert.equal(Number(rows[0].sales_count),original.reduce((n,r)=>n+Number(r.sales),0));assert.equal(Number(rows[0].ngn_revenue),0);
});
test('real earnings remains exactly equal to accepted financial oracle',async()=>{
 await pool.query('DELETE FROM subject_purchases');for(let start=1;start<=105;start++){await pool.query("INSERT INTO subject_purchases(id,buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active) VALUES(?,1,1,7,6.01,'EUR',?,IF(?<100,'2020-01-01',CURRENT_TIMESTAMP),'2030-01-01',1)",[start,'fixture-'+start,start]);}
 await pool.query("INSERT INTO subject_purchases(id,buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active) VALUES(200,1,1,7,7.01,'USD','fixture-usd',CURRENT_TIMESTAMP,'2030-01-01',1)");
 for(const [id,state,refund,dispute]of [[101,'completed','none','none'],[102,'pending','none','none'],[103,'uncertain','none','none'],[104,'pending','full','open']]){await pool.query('INSERT INTO payment_orders VALUES(?,?,?,?)',['order-'+id,id,refund,dispute]);await pool.query("INSERT INTO payment_allocations VALUES(?,7,'EUR',301)",['order-'+id]);await pool.query('INSERT INTO payment_transfers VALUES(?,?,?,CURRENT_TIMESTAMP)',['order-'+id,state,'tr_fixture_'+id]);}
 const desc=JSON.stringify({kind:'uniclips_legacy_verified_v1',purchaseId:1,paymentId:'fixture-1',grossMinor:601,amountMinor:421,rate:70,ordinal:1});await pool.query("INSERT INTO scholar_payouts VALUES(1,7,'EUR',4.21,'completed',?,'tr_fixture',CURRENT_TIMESTAMP),(2,7,'USD',1,'uncertain','malformed',NULL,CURRENT_TIMESTAMP)",[desc]);
 const candidate=require('../src/services/payments/earningsService'),baseline=require('./fixtures/p2iEarningsBaseline.cjs');
 const mixed=await candidate.scholarEarnings(pool,7),old=await baseline.scholarEarnings(pool,7);
 assert.equal(mixed.summary.scholarEarnings,null);assert.equal(mixed.summary.legacyReconciliationRequired,true);
 for(const key of ['totalRevenue','totalPaid','pendingBalance','authoritativeEarned','verifiedReleaseEarned','uncertainTransferAmount'])assert.equal(mixed.summary[key],old.summary[key],key);
 await pool.query('DELETE FROM subject_purchases WHERE id=200');
 assert.deepEqual(await candidate.scholarEarnings(pool,7),await baseline.scholarEarnings(pool,7));
});
test('real Operations offset boundary, queue overflow and late read recovery',async()=>{
 const {paginate}=require('../src/services/operations/data');const p=await paginate(pool,'id','FROM items',[],{page:'201',limit:'50'});assert.equal(p.rows.length,1);assert.equal(p.total,10001);await assert.rejects(paginate(pool,'id','FROM items',[],{page:'202',limit:'50'}),e=>e.status===400);
 const leases=await Promise.all(Array.from({length:10},()=>pool.getConnection()));const waiting=Array.from({length:20},()=>pool.getConnection().then(c=>c.release()));await assert.rejects(C.admittedRead(pool,'SELECT 1'),e=>e.status===503);assert.equal(C.catalogueReads.status().active,0);for(const c of leases)c.release();await Promise.all(waiting);assert.equal((await C.admittedRead(pool,'SELECT 1 AS n'))[0][0].n,1);
});
test('actual ten-second query timeout destroys connection and next read recovers',async()=>{
 const begin=Date.now();await assert.rejects(C.admittedRead(pool,'SELECT SLEEP(11)'),e=>e.status===503);assert.ok(Date.now()-begin>=9000);assert.equal(C.catalogueReads.status().active,0);assert.equal((await C.admittedRead(pool,'SELECT 1 AS n'))[0][0].n,1);
});
