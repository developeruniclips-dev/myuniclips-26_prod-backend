'use strict';
// This is a deliberately limited synthetic application, not a production schema
// export. No DDL runs on import or application startup.
const {DATABASE,fail}=require('./isolation');
const {decode}=require('./approvals');
const {digest}=require('../services/paystackNigeria/transportConfig');
const options='ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
const core=[
 `sandbox_manifest(singleton INT PRIMARY KEY CHECK(singleton=1),version INT NOT NULL,kind VARCHAR(40) NOT NULL,database_name VARCHAR(64) NOT NULL,seed_id CHAR(36) NOT NULL,seed_digest CHAR(64) NOT NULL,subject_id INT NOT NULL,scholar_id INT NOT NULL,buyer_id INT NOT NULL,merchant_account VARCHAR(64) NOT NULL)`,
 `countries(id INT PRIMARY KEY,name VARCHAR(100) NOT NULL,code CHAR(2) NOT NULL UNIQUE)`,
 `universities(id INT PRIMARY KEY,name VARCHAR(150) NOT NULL,short_name VARCHAR(30),country_id INT NOT NULL,FOREIGN KEY(country_id) REFERENCES countries(id))`,
 `users(id INT PRIMARY KEY,fname VARCHAR(50),lname VARCHAR(50),email VARCHAR(254) NOT NULL UNIQUE,password VARCHAR(255) NOT NULL,isScholar TINYINT DEFAULT 0,university_id INT,degree_programme VARCHAR(100),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,failed_login_attempts INT DEFAULT 0,last_failed_login DATETIME,locked_until DATETIME,last_login DATETIME,last_activity DATETIME,refresh_token VARCHAR(100),refresh_token_expires DATETIME,two_factor_enabled TINYINT DEFAULT 0,two_factor_secret VARCHAR(128),two_factor_backup_codes TEXT,FOREIGN KEY(university_id) REFERENCES universities(id))`,
 `roles(id INT PRIMARY KEY,name VARCHAR(30) NOT NULL UNIQUE)`,
 `user_roles(user_id INT NOT NULL,role_id INT NOT NULL,PRIMARY KEY(user_id,role_id),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(role_id) REFERENCES roles(id))`,
 `subjects(id INT PRIMARY KEY,name VARCHAR(150),university_id INT NOT NULL,degree_programmes VARCHAR(100),bundle_price DECIMAL(10,2),FOREIGN KEY(university_id) REFERENCES universities(id))`,
 `scholar_profile(user_id INT PRIMARY KEY,university VARCHAR(150),degree VARCHAR(100),approved TINYINT,stripe_account_id VARCHAR(100),FOREIGN KEY(user_id) REFERENCES users(id))`,
 `scholar_subjects(id INT AUTO_INCREMENT PRIMARY KEY,subject_id INT NOT NULL,scholar_user_id INT NOT NULL,subject_name VARCHAR(150),degree VARCHAR(100),expertise TEXT,approved TINYINT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,UNIQUE(subject_id,scholar_user_id),FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_user_id) REFERENCES users(id))`,
 `course_workflows(offering_id INT PRIMARY KEY,state VARCHAR(40),legacy_published TINYINT DEFAULT 0,revision INT DEFAULT 1,FOREIGN KEY(offering_id) REFERENCES scholar_subjects(id))`,
 `videos(id INT PRIMARY KEY,subject_id INT NOT NULL,scholar_user_id INT NOT NULL,approved TINYINT,title VARCHAR(150),description TEXT,sequence_index INT,is_first_preview TINYINT DEFAULT 0,is_free TINYINT DEFAULT 0,price DECIMAL(10,2),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_user_id) REFERENCES users(id))`,
 `subject_purchases(id INT AUTO_INCREMENT PRIMARY KEY,buyer_user_id INT NOT NULL,subject_id INT NOT NULL,scholar_id INT NOT NULL,amount DECIMAL(10,2) NOT NULL,currency VARCHAR(3) NOT NULL,transaction_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP,renewed_at DATETIME,access_expires_at DATETIME,is_access_active TINYINT DEFAULT 1,UNIQUE KEY entitlement(buyer_user_id,subject_id,scholar_id),KEY scope_census(subject_id,scholar_id,id),FOREIGN KEY(buyer_user_id) REFERENCES users(id),FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_id) REFERENCES users(id))`,
 `scholar_payouts(id INT AUTO_INCREMENT PRIMARY KEY,scholar_user_id INT,amount DECIMAL(10,2),currency VARCHAR(3),status VARCHAR(40),description TEXT,stripe_transfer_id VARCHAR(255),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
 `purchases(id INT AUTO_INCREMENT PRIMARY KEY,buyer_user_id INT,video_id INT,amount DECIMAL(10,2),currency VARCHAR(3),created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
 `transactions(id INT AUTO_INCREMENT PRIMARY KEY,provider VARCHAR(24),provider_transaction_id VARCHAR(255),status VARCHAR(40),purchase_id INT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
].map(s=>'CREATE TABLE '+s+' '+options);
const statements=[...core,...require('../services/paystackNigeria/schema').statements,...require('../services/coursePayments/schema').statements,...require('../services/paystackNigeria/transportSchema').statements];
const schemaDigest=()=>digest(JSON.stringify(statements));
function validateSeed(s){
 if(!s||!/^[1-9]\d{0,19}$/.test(s.merchantAccount)||!/^[a-f0-9-]{36}$/.test(s.seedId||''))fail('SANDBOX_SEED_INVALID');
 for(const key of ['buyerEmail','scholarEmail'])if(typeof s[key]!=='string'||!/^\S+@\S+\.\S+$/.test(s[key])||s[key].length>254)fail('SANDBOX_SEED_INVALID');
 if(s.buyerEmail===s.scholarEmail)fail('SANDBOX_SEED_INVALID');
 for(const key of ['buyerHash','scholarHash'])if(!/^\$argon2id\$/.test(s[key]||''))fail('SANDBOX_PASSWORD_HASH_REQUIRED');
 return s;
}
async function bootstrap({pool,seed,envelope,publicKey,reviewerKey,review,now=Date.now,source}={}){
 validateSeed(seed);const a=decode(envelope,publicKey),r=decode(review,reviewerKey);
 const canonical=digest(JSON.stringify(seed));
 for(const p of [a,r])if(p.kind!=='sandbox-bootstrap-v1'||p.database!==DATABASE||p.seedDigest!==canonical||p.schemaDigest!==schemaDigest()||p.source!==source||p.host!==pool.config.host||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now()||p.expiresAt<=now()||p.expiresAt-p.issuedAt>300000)fail('SANDBOX_BOOTSTRAP_APPROVAL_REQUIRED');
 const keyDigest=k=>digest((k?.type==='public'?k:require('node:crypto').createPublicKey(k)).export({type:'spki',format:'der'}));
 if(keyDigest(publicKey)===keyDigest(reviewerKey))fail('INDEPENDENT_REVIEWER_REQUIRED');
 const c=await pool.getConnection();let begun=false;
 try{
  const [[db]]=await c.query('SELECT DATABASE() AS db');if(db.db!==DATABASE)fail('SANDBOX_DATABASE_IDENTITY_MISMATCH');
  const [tables]=await c.query('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  if(tables.length)fail('SANDBOX_BOOTSTRAP_EMPTY_DATABASE_REQUIRED');
  // DDL is not transactional. A failed batch leaves a partial owned test schema;
  // never resume blindly or DROP anything automatically.
  for(const sql of statements)await c.query(sql);
  await c.beginTransaction();begun=true;
  await c.query("INSERT INTO countries VALUES(101,'Synthetic Nigeria','NG')");
  await c.query("INSERT INTO universities VALUES(201,'SYNTHETIC FUNAAB-compatible Test University','SYNTHETIC-NG',101)");
  await c.query("INSERT INTO roles VALUES(1,'Learner'),(3,'Scholar')");
  await c.query("INSERT INTO users(id,fname,lname,email,password,isScholar,university_id,degree_programme) VALUES(301,'Synthetic','Scholar',?,?,1,201,'Synthetic Engineering'),(302,'Synthetic','Buyer',?,?,0,NULL,NULL)",[seed.scholarEmail,seed.scholarHash,seed.buyerEmail,seed.buyerHash]);
  await c.query('INSERT INTO user_roles VALUES(301,3),(302,1)');
  await c.query("INSERT INTO subjects VALUES(401,'Synthetic NG Test Course',201,'Synthetic Engineering',NULL)");
  await c.query("INSERT INTO scholar_profile VALUES(301,'SYNTHETIC FUNAAB-compatible Test University','Synthetic Engineering',1,NULL)");
  await c.query("INSERT INTO scholar_subjects(id,subject_id,scholar_user_id,subject_name,degree,expertise,approved) VALUES(501,401,301,'Synthetic NG Test Course','Synthetic Engineering','Synthetic content',1)");
  await c.query("INSERT INTO course_workflows VALUES(501,'PUBLISHED',0,1)");
  // No provider URL, upload, player token or genuine course material.
  await c.query("INSERT INTO videos(id,subject_id,scholar_user_id,approved,title,description,sequence_index,is_first_preview,is_free) VALUES(601,401,301,1,'Synthetic preview','Payment sandbox; no hosted video',1,1,1),(602,401,301,1,'Synthetic paid lesson','Entitlement fixture only',2,0,0)");
  await c.query("INSERT INTO paystack_ng_offerings(subject_id,scholar_id,merchant_account,environment,policy_version,approved) VALUES(401,301,?,'test',?,1)",[seed.merchantAccount,require('../services/paystackNigeria/policy').RULE.version]);
  await c.query("INSERT INTO sandbox_manifest VALUES(1,1,'synthetic-paystack-test',?,?,?,401,301,302,?)",[DATABASE,seed.seedId,canonical,seed.merchantAccount]);
  await c.commit();begun=false;return {subjectId:401,scholarId:301,buyerId:302,seedId:seed.seedId};
 }catch(e){if(begun)try{await c.rollback();}catch{c.destroy();throw Object.assign(new Error('Sandbox bootstrap uncertain'),{code:'SANDBOX_BOOTSTRAP_UNCERTAIN'});}throw e;}finally{c.release();}
}
async function metadata(pool){
 const [tables]=await pool.query('SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE()');
 const [columns]=await pool.query('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,NUMERIC_PRECISION,NUMERIC_SCALE,CHARACTER_MAXIMUM_LENGTH,COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
 tables.sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME));columns.sort((a,b)=>(a.TABLE_NAME+'.'+a.COLUMN_NAME).localeCompare(b.TABLE_NAME+'.'+b.COLUMN_NAME));
 const [keys]=await pool.query('SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX');
 const m={tables:{},columns:{},uniqueKeys:{},indexes:{},stripeCounterPresent:tables.some(t=>t.TABLE_NAME==='payment_sale_counters')};
 for(const t of tables)m.tables[t.TABLE_NAME]={engine:t.ENGINE};
 for(const c of columns)m.columns[c.TABLE_NAME+'.'+c.COLUMN_NAME]={type:c.DATA_TYPE,unsigned:/unsigned/i.test(c.COLUMN_TYPE),nullable:c.IS_NULLABLE==='YES',precision:Number(c.NUMERIC_PRECISION),scale:Number(c.NUMERIC_SCALE),length:Number(c.CHARACTER_MAXIMUM_LENGTH),collation:c.COLLATION_NAME};
 for(const r of keys){const t=r.TABLE_NAME,k=r.INDEX_NAME;(m.indexes[t]??={})[k]??=[];m.indexes[t][k].push(r.COLUMN_NAME);}
 for(const t of tables){const group=keys.filter(k=>k.TABLE_NAME===t.TABLE_NAME);m.uniqueKeys[t.TABLE_NAME]=[...new Set(group.filter(k=>!k.NON_UNIQUE).map(k=>k.INDEX_NAME))].map(k=>group.filter(r=>r.INDEX_NAME===k).map(r=>r.COLUMN_NAME));m.indexes[t.TABLE_NAME]=Object.values(m.indexes[t.TABLE_NAME]||{});}
 return m;
}
module.exports={statements,bootstrap,metadata,schemaDigest,validateSeed};
