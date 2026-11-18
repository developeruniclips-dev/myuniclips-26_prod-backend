'use strict';
const a=require('node:assert/strict'),crypto=require('node:crypto'),net=require('node:net');
const mysql=require('mysql2/promise'),speakeasy=require('speakeasy');
const {createService}=require('../../src/services/scholarBank/service');
const {protection}=require('../../src/services/scholarBank/security');
const A=require('../../src/utils/authSecurity');
async function database(){
 a.equal(process.env.BANK_ISOLATED_TEST,'1','Explicit disposable fixture flag required');
 const connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){
  const first=Array.isArray(args[0])?args[0][0]:args[0],host=typeof first==='object'?first.host:typeof args[1]==='string'?args[1]:'localhost';
  a(['127.0.0.1','::1','localhost'].includes(host),'Fixture network must stay on loopback');
  return connect.apply(this,args);
 };
 // Runtime-generated, disposable signing material; never a stored credential.
 Reflect.set(process.env,'JWT_SECRET',crypto.randomBytes(48).toString('hex'));
 const name='uniclips_bank_test_'+crypto.randomBytes(8).toString('hex');
 const options={host:'127.0.0.1',port:33318,user:'root',password:'',timezone:'Z',connectionLimit:10};
 const admin=await mysql.createConnection(options);await admin.query('CREATE DATABASE '+name);
 const pool=mysql.createPool({...options,database:name});
 pool.on('connection',c=>c.query("SET time_zone='+00:00'"));
 const definitions=[
  'users(id INT PRIMARY KEY,fname VARCHAR(80),lname VARCHAR(80),email VARCHAR(254),password VARCHAR(255),refresh_token VARCHAR(150),refresh_token_expires DATETIME,last_activity DATETIME,two_factor_enabled TINYINT DEFAULT 0,two_factor_secret VARCHAR(150),two_factor_backup_codes JSON,locked_until DATETIME,failed_login_attempts INT DEFAULT 0,last_failed_login DATETIME)',
  'roles(id INT PRIMARY KEY,name VARCHAR(30))',
  'user_roles(user_id INT,role_id INT,PRIMARY KEY(user_id,role_id))',
  'countries(id INT PRIMARY KEY,code CHAR(2))',
  'universities(id INT PRIMARY KEY,name VARCHAR(120),short_name VARCHAR(30),country_id INT)',
  'scholar_profile(user_id INT PRIMARY KEY,university VARCHAR(160),approved TINYINT)',
  'subject_purchases(id INT PRIMARY KEY,scholar_id INT,access_expires_at DATETIME)',
  'paystack_ng_allocations(id INT PRIMARY KEY,scholar_id INT,scholar_minor INT,payout_state VARCHAR(20))',
  'scholar_payouts(id INT PRIMARY KEY,scholar_user_id INT,amount INT)'
 ];
 for(const sql of definitions)await pool.query('CREATE TABLE '+sql+' ENGINE=InnoDB');
 for(const sql of require('../../src/services/scholarBank/schema').statements)await pool.query(sql);
 await pool.query("INSERT INTO roles VALUES(1,'Learner'),(3,'Scholar'),(4,'Admin'),(5,'SuperAdmin')");
 await pool.query("INSERT INTO countries VALUES(1,'NG'),(2,'FI')");
 await pool.query("INSERT INTO universities VALUES(1,'Synthetic Nigeria University','SNG',1),(2,'Synthetic Finland University','SFI',2)");
 let sequence=100;
 async function scope(){
  const id=++sequence,adminId=++sequence,ownerId=++sequence;
  const secret=speakeasy.generateSecret({length:20}).base32;
  const state={time:Date.now(),failResolve:false,failCreate:false,mailFailure:false,createCalls:0,mails:[],records:new Map(),pause:null};
  for(const [uid,role]of [[id,3],[adminId,4],[ownerId,5]]){
   await pool.query("INSERT INTO users(id,fname,lname,email,password,refresh_token,refresh_token_expires,last_activity,two_factor_enabled,two_factor_secret,two_factor_backup_codes) VALUES(?,'Synthetic','Account',?,'synthetic-password-hash',?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 DAY),UTC_TIMESTAMP(),?,?,?)",
    [uid,'fixture'+uid+'@example.invalid','sha256:'+crypto.randomBytes(32).toString('hex'),role===5?1:0,role===5?secret:null,JSON.stringify({v:1,codes:[],lastStep:-1,challenge:null})]);
   await pool.query('INSERT INTO user_roles VALUES(?,?)',[uid,role]);
  }
  await pool.query("INSERT INTO scholar_profile VALUES(?,'Synthetic Nigeria University (SNG)',1)",[id]);
  await pool.query("INSERT INTO subject_purchases VALUES(?,?,'2027-04-11 01:59:15')",[id,id]);
  await pool.query("INSERT INTO paystack_ng_allocations VALUES(?,?,105000,'held')",[id,id]);
  const claims=async uid=>{const [[u]]=await pool.query('SELECT * FROM users WHERE id=?',[uid]);return {id:uid,session:A.credentialBinding(u)};};
  const user=await claims(id),adminClaims=await claims(adminId),ownerClaims=await claims(ownerId);
  const protect=protection({encryptionKey:crypto.randomBytes(32).toString('hex'),fingerprintKey:crypto.randomBytes(32).toString('hex'),keyId:'bank-v1'});
  const provider={
   async banks(){return [{code:'999',name:'Synthetic Bank'}];},
   async resolve(bankCode,number){if(state.failResolve)throw Object.assign(Error('Synthetic resolution failure'),{status:502,code:'BANK_RESOLUTION_FAILED'});return {accountNumber:number,accountName:'SYNTHETIC ACCOUNT HOLDER'};},
   async create(input){state.createCalls++;if(state.pause)await state.pause;const code='RCP_SYNTHETIC'+crypto.randomBytes(6).toString('hex');state.records.set(code,{recipient_code:code,domain:'test',integration:100043,type:'nuban',currency:'NGN',active:true,name:input.accountName,details:{bank_code:input.bankCode,account_number:input.accountNumber,account_name:input.accountName},metadata:{uniclips_bank_operation:input.operationId}});if(state.failCreate)throw Error('Synthetic lost acknowledgement');return code;},
   async inspect(code){return state.records.get(code);},
   checkRecipient(data,expected){a.equal(data.domain,'test');a.equal(data.integration,100043);a.equal(data.type,'nuban');a.equal(data.currency,'NGN');a.equal(data.active,true);a.equal(data.details.bank_code,expected.bankCode);a.equal(data.details.account_number,expected.accountNumber);return data.recipient_code;}
  };
  const makeService=(overrides={})=>createService({pool,provider,protection:protect,sendMail:async item=>{if(state.mailFailure)throw Error('Synthetic SMTP failure');state.mails.push(item);},merchant:'100043',environment:'test',clock:()=>new Date(state.time),passwordVerifier:async value=>({valid:value==='synthetic-password'}),...overrides});
  const service=makeService();
  const fresh=async (who=user,purpose='setup',target='')=>(await service.reauthenticate(who,{purpose,target,password:'synthetic-password',...(who.id===ownerId?{token:speakeasy.totp({secret,encoding:'base32',time:Math.floor(state.time/1000)})}:{})})).proof;
  const resolve=async(proof=undefined,number='0000000001')=>service.resolve(user,{bankCode:'999',accountNumber:number,proof:proof||await fresh()});
  const setup=async()=>{const proof=await fresh(),c=await resolve(proof);await service.confirm(user,{proof,challengeId:c.challengeId,confirmation:'USE THIS ACCOUNT FOR UNICLIPS PAYOUTS'});return {proof,c};};
  const financial=async()=>{const [p]=await pool.query('SELECT * FROM subject_purchases WHERE scholar_id=?',[id]);const [e]=await pool.query('SELECT * FROM paystack_ng_allocations WHERE scholar_id=?',[id]);const [t]=await pool.query('SELECT * FROM scholar_payouts WHERE scholar_user_id=?',[id]);return {p,e,t};};
  return {id,adminId,ownerId,user,admin:adminClaims,owner:ownerClaims,claims,state,service,makeService,protect,provider,fresh,resolve,setup,financial};
 }
 return {pool,scope,async close(){await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();net.Socket.prototype.connect=connect;}};
}
module.exports={database};
