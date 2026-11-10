'use strict';
// Proposal only. Never alters or converts a sandbox schema, and has no executor.
const {hash,deny}=require('./liveConfiguration');
const statements=[...require('./schema').statements,...require('../coursePayments/schema').statements,...require('./transportSchema').statements].map(sql=>sql.replace(/CHECK\s*\(environment='test'\)/g,"CHECK(environment='live')"));
const schemaDigest=()=>hash(JSON.stringify(statements));
const unique={paystack_ng_offerings:[['subject_id','scholar_id','merchant_account','environment']],paystack_ng_orders:[['id'],['merchant_account','environment','reference'],['merchant_account','environment','buyer_id','idempotency_key'],['buyer_id','subject_id','scholar_id'],['purchase_id']],paystack_ng_transactions:[['order_id'],['merchant_account','environment','provider_transaction_id'],['merchant_account','environment','reference']],paystack_ng_events:[['id'],['merchant_account','environment','event_key']],paystack_ng_sale_counters:[['subject_id','scholar_id']],paystack_ng_allocations:[['order_id'],['purchase_id'],['subject_id','scholar_id','sale_ordinal']],paystack_ng_adjustments:[['id'],['merchant_account','environment','event_key','kind']],paystack_ng_checkouts:[['order_id']],paystack_ng_verifications:[['id']],course_sale_audits:[['subject_id','scholar_id','review_version'],['review_id']],course_sale_proofs:[['purchase_id'],['subject_id','scholar_id','sale_ordinal'],['provider','merchant_account','environment','provider_reference'],['provider','merchant_account','environment','provider_transaction_id']]};
const environmentTables=['paystack_ng_offerings','paystack_ng_orders','paystack_ng_transactions','paystack_ng_events','paystack_ng_allocations','paystack_ng_adjustments','paystack_ng_checkouts'];
function liveEnvironmentCheck(clause){
 if(typeof clause!=='string'||clause.length>8192)return false;
 let value=clause.trim();while(value.startsWith('(')&&value.endsWith(')'))value=value.slice(1,-1).trim();
 // INFORMATION_SCHEMA can escape the literal quotes in CHECK_CLAUSE. Accept
 // only the complete, exact equality in either reported form; never discard
 // arbitrary escapes, whitespace inside a literal, or additional predicates.
 return /^(?:environment|`environment`)\s*=\s*(?:_[A-Za-z0-9]+)?(?:'live'|\\'live\\')$/.test(value);
}
function requireLiveSchema(metadata){
 require('./compatibility').requireSchema(metadata);
 for(const [table,keys]of Object.entries(unique)){
  if(metadata.tables?.[table]?.engine!=='InnoDB'||keys.some(k=>!(metadata.uniqueKeys?.[table]||[]).some(found=>JSON.stringify(k)===JSON.stringify(found))))deny('PAYSTACK_LIVE_SCHEMA_REQUIRED');
 }
 for(const table of environmentTables){const checks=(metadata.checks||[]).filter(c=>c.table===table&&c.enforced==='YES');if(!checks.some(c=>liveEnvironmentCheck(c.clause))||checks.some(c=>/environment/i.test(c.clause)&&!liveEnvironmentCheck(c.clause)))deny('PAYSTACK_LIVE_SCHEMA_REQUIRED');}
 return metadata;
}
module.exports={statements,schemaDigest,requireLiveSchema,unique,environmentTables};
