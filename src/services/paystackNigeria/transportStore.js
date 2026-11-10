'use strict';
const {randomUUID}=require('node:crypto'),{digest,fail,isConfiguration}=require('./transportConfig');
function createTransportStore({pool,config}={}){
 if(!isConfiguration(config)||!['test','live'].includes(config.environment))fail('PAYSTACK_CONFIGURATION_UNVERIFIED');
 const environment=config.environment;
 const query=(db,sql,args=[])=>db.query({sql,timeout:10000},args);
 async function transaction(work){
  const db=await pool.getConnection();let started=false,destroyed=false,setup=false;
  try{const [[zone]]=await query(db,'SELECT @@session.time_zone AS zone');if(!['UTC','+00:00'].includes(zone.zone))fail('UTC_SESSION_REQUIRED');setup=true;await query(db,'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await db.beginTransaction();setup=false;started=true;const result=await work(db);await db.commit();started=false;return result;}
  catch(e){if(started)try{await db.rollback();}catch{destroyed=true;db.destroy();fail('PAYSTACK_TRANSACTION_UNCERTAIN');}if(setup||e.code==='PROTOCOL_SEQUENCE_TIMEOUT'){destroyed=true;db.destroy();}if(['ER_LOCK_NOWAIT','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(e.code))fail('PAYSTACK_BUSY');throw e;}
  finally{if(!destroyed)db.release();}
 }
 const order=async(db,id,buyer)=>{const [rows]=await query(db,'SELECT * FROM paystack_ng_orders WHERE id=?'+(buyer==null?'':' AND buyer_id=?')+' FOR UPDATE NOWAIT',buyer==null?[id]:[id,buyer]);if(rows.length!==1||rows[0].merchant_account!==config.merchantAccount||rows[0].environment!==environment)fail('PAYSTACK_ORDER_NOT_FOUND');config.assertScope?.(Number(rows[0].subject_id),Number(rows[0].scholar_id),Number(rows[0].buyer_id));return rows[0];};
 const checkout=async(db,id)=>{const [rows]=await query(db,'SELECT * FROM paystack_ng_checkouts WHERE order_id=? FOR UPDATE NOWAIT',[id]);return rows[0];};
 return {
  async beginInitialization(o){return transaction(async db=>{
   const stored=await order(db,o.id,o.buyerId);if(stored.state==='fulfilled')return {started:false,fulfilled:true};
   const previous=await checkout(db,o.id);if(previous){if(previous.credential_digest!==config.credentialDigest)fail('PAYSTACK_PAYMENT_REVIEW_REQUIRED');return {started:false,record:previous};}
   const [[user]]=await query(db,'SELECT email FROM users WHERE id=?',[o.buyerId]);if(!user||typeof user.email!=='string'||user.email.length>254||!/^\S+@\S+\.\S+$/.test(user.email))fail('PAYSTACK_EMAIL_REQUIRED');
   await query(db,"INSERT INTO paystack_ng_checkouts(order_id,merchant_account,environment,email_digest,credential_digest,state,attempted_at) VALUES (?,?,?,?,?,'initializing',UTC_TIMESTAMP())",[o.id,o.merchantAccount,environment,digest(user.email.toLowerCase()),config.credentialDigest]);
   return {started:true,email:user.email};
  });},
  async finishInitialization(o,result){return transaction(async db=>{await order(db,o.id,o.buyerId);const r=await checkout(db,o.id);if(!r||r.state!=='initializing')fail('PAYSTACK_INITIALIZATION_UNCERTAIN');await query(db,"UPDATE paystack_ng_checkouts SET state=?,checkout_url=?,initialization_digest=? WHERE order_id=?",[result?'ready':'uncertain',result?.url||null,result?.digest||null,o.id]);});},
  async assertEligible(o){return transaction(async db=>{await order(db,o.id,o.buyerId);const r=await checkout(db,o.id);if(!r||r.review_code||r.credential_digest!==config.credentialDigest)fail('PAYSTACK_PAYMENT_REVIEW_REQUIRED');return {emailDigest:r.email_digest};});},
  async recordVerification(o,v){return transaction(async db=>{
   await order(db,o.id,o.buyerId);const r=await checkout(db,o.id);if(!r)fail('PAYSTACK_INITIALIZATION_REQUIRED');
   const [prior]=await query(db,"SELECT provider_transaction_id FROM paystack_ng_verifications WHERE order_id=? AND state='verified' LIMIT 1",[o.id]);
   if(prior.length&&v.providerTransactionId&&prior[0].provider_transaction_id!==v.providerTransactionId)v={...v,state:'review',reason:'PAYSTACK_TRANSACTION_CONFLICT',receipt:null};
   const [holds]=await query(db,"SELECT event_key FROM paystack_ng_events WHERE merchant_account=? AND environment=? AND state='review' AND (transaction_identity=? OR (transaction_identity IS NULL AND (event_type LIKE 'refund.%' OR event_type LIKE 'charge.dispute.%'))) LIMIT 1",[config.merchantAccount,environment,v.providerTransactionId]);
   if(holds.length)v={...v,state:'review',reason:'PAYSTACK_EVENT_REVIEW_REQUIRED',receipt:null};
   await query(db,'INSERT INTO paystack_ng_verifications(id,order_id,state,provider_transaction_id,response_digest,credential_digest,receipt,reason,created_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',[randomUUID(),o.id,v.state,v.providerTransactionId,v.digest,v.credentialDigest,v.receipt?JSON.stringify(v.receipt):null,v.reason]);
   if(v.state==='review')await query(db,'UPDATE paystack_ng_checkouts SET review_code=? WHERE order_id=?',[v.reason,o.id]);
   if(v.state==='failed')await query(db,"UPDATE paystack_ng_checkouts SET state='failed' WHERE order_id=?",[o.id]);
  });},
  async hold(o,code){return transaction(async db=>{await order(db,o.id,o.buyerId);await query(db,'UPDATE paystack_ng_checkouts SET review_code=COALESCE(review_code,?) WHERE order_id=?',[code,o.id]);});},
  async status(id,buyer){return transaction(async db=>{const o=await order(db,id,buyer),r=await checkout(db,id);return {provider:'paystack',orderId:id,subjectId:Number(o.subject_id),scholarId:Number(o.scholar_id),currency:'NGN',amountMinor:150000,success:o.state==='fulfilled',state:r?.review_code?'review':o.state==='fulfilled'?'fulfilled':r?.state==='failed'?'failed':'pending',reviewCode:r?.review_code||null,payoutState:'held',checkoutEnabled:false};});},
  async recordEvent(event){return transaction(async db=>{
   let [orders]=await query(db,"SELECT * FROM paystack_ng_orders WHERE reference=? AND merchant_account=? AND environment=? LIMIT 1",[event.reference||'',config.merchantAccount,environment]);
   if(!orders.length&&event.relatedTransactionId)[orders]=await query(db,"SELECT o.* FROM paystack_ng_orders o JOIN paystack_ng_transactions t ON t.order_id=o.id WHERE t.provider_transaction_id=? AND o.merchant_account=? AND o.environment=? LIMIT 1",[event.relatedTransactionId,config.merchantAccount,environment]);
   if(!orders.length&&event.relatedTransactionId)[orders]=await query(db,"SELECT o.* FROM paystack_ng_orders o JOIN paystack_ng_verifications v ON v.order_id=o.id WHERE v.provider_transaction_id=? AND o.merchant_account=? AND o.environment=? LIMIT 1",[event.relatedTransactionId,config.merchantAccount,environment]);
   const o=orders[0];if(o)await order(db,o.id);
   const [existing]=await query(db,"SELECT * FROM paystack_ng_events WHERE merchant_account=? AND environment=? AND event_key=? FOR UPDATE NOWAIT",[config.merchantAccount,environment,event.key]);
   const conflict=existing[0]&&existing[0].claims_digest!==event.claimsDigest;
   const unsafe=event.type!=='charge.success'||event.domain!==environment||event.amount!==150000||event.currency!=='NGN'||!event.transactionId||event.integration&&event.integration!==config.merchantAccount||conflict;
   if(!existing.length)await query(db,"INSERT INTO paystack_ng_events(merchant_account,environment,entity,event_key,event_type,resource_id,payload_digest,claims_digest,transaction_identity,claims,order_id,state,received_at) VALUES (?,?,'UNICLIPS_NIGERIA_LIMITED',?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP())",[config.merchantAccount,environment,event.key,event.type,event.resourceId,event.digest,event.claimsDigest,event.transactionId||event.relatedTransactionId||null,JSON.stringify(event.claims),o?.id||null,unsafe||!o?'review':'received']);
   if(o&&unsafe)await query(db,"UPDATE paystack_ng_checkouts SET review_code=COALESCE(review_code,'PAYSTACK_EVENT_REVIEW_REQUIRED') WHERE order_id=?",[o.id]);
   if(conflict)await query(db,"UPDATE paystack_ng_events SET state='review',error_code='PAYSTACK_EVENT_CONFLICT' WHERE merchant_account=? AND environment=? AND event_key=?",[config.merchantAccount,environment,event.key]);
   return {orderId:o?.id,buyerId:o&&Number(o.buyer_id),processed:existing[0]?.state==='processed',review:!!unsafe||!o||existing[0]?.state==='review'};
  });},
  async completeEvent(key,state,code=null){return transaction(db=>query(db,"UPDATE paystack_ng_events SET state=?,error_code=?,processed_at=IF(? IN ('processed','review'),UTC_TIMESTAMP(),NULL) WHERE merchant_account=? AND environment=? AND event_key=? AND state<>'review'",[state,code,state,config.merchantAccount,environment,key]));},
 };
}
module.exports={createTransportStore};
