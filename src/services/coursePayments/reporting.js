'use strict';
const {readBounded,admittedRead}=require('../../utils/readCapacity');
const {toMinor,allocation}=require('../payments/money');
const {validateAudit,integer}=require('./historicalResolver');
const unavailable=e=>['ER_NO_SUCH_TABLE','BASELINE_AUDIT_REQUIRED','BASELINE_AUDIT_MISMATCH','BASELINE_ORDINAL_CONFLICT','INVALID_SALE_PROOF','INVALID_NG_PROOF','INVALID_STRIPE_PROOF'].includes(e.code);
async function purchaseEvidence(pool,purchases){
 const facts=new Map(),scopes=new Map();
 for(const p of purchases)if(p.subject_id&&p.scholar_id)scopes.set(p.subject_id+':'+p.scholar_id,{subjectId:Number(p.subject_id),scholarId:Number(p.scholar_id)});
 // A fixed number of bounded batches, not one query per card/purchase.
 if(scopes.size)try{
  const ids=[...new Set([...scopes.values()].map(s=>s.subjectId))];
  const [audits]=await readBounded(pool,`SELECT a.* FROM course_sale_audits a JOIN
   (SELECT subject_id,scholar_id,MAX(review_version) AS version FROM course_sale_audits WHERE subject_id IN (?) GROUP BY subject_id,scholar_id) latest
   ON a.subject_id=latest.subject_id AND a.scholar_id=latest.scholar_id AND a.review_version=latest.version`,[ids]);
  const [proofs]=await readBounded(pool,'SELECT * FROM course_sale_proofs WHERE subject_id IN (?) ORDER BY subject_id,scholar_id,sale_ordinal',[ids]);
  const auditsByScope=new Map(audits.map(a=>[a.subject_id+':'+a.scholar_id,a])),proofsByScope=new Map();
  for(const r of proofs){const key=r.subject_id+':'+r.scholar_id;if(!proofsByScope.has(key))proofsByScope.set(key,[]);proofsByScope.get(key).push(r);}
  for(const [key,scope]of scopes)try{const {rows}=validateAudit(auditsByScope.get(key),proofsByScope.get(key)||[],scope);for(const r of rows)facts.set(Number(r.purchase_id),r);}catch(e){if(!unavailable(e))throw e;}
 }catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
 const ngIds=[...facts.values()].filter(r=>r.provider==='paystack').map(r=>Number(r.purchase_id));
 const ng=new Map();
 if(ngIds.length){
  try{const [rows]=await readBounded(pool,`SELECT a.*,o.reference,o.state AS order_state,o.purchase_id AS order_purchase,o.subject_id AS order_subject,o.scholar_id AS order_scholar,
   o.total_minor AS order_total,o.merchant_account AS order_merchant,o.environment AS order_environment,o.entity AS order_entity,
   t.reference AS receipt_reference,t.provider_transaction_id,t.amount_minor AS receipt_amount,t.currency AS receipt_currency,t.evidence_digest,t.processing_fees_minor
   FROM paystack_ng_allocations a JOIN paystack_ng_orders o ON o.id=a.order_id JOIN paystack_ng_transactions t ON t.order_id=a.order_id
   WHERE a.purchase_id IN (?)`,[ngIds]);for(const r of rows)ng.set(Number(r.purchase_id),r);
  }catch(e){if(e.code!=='ER_NO_SUCH_TABLE')throw e;}
 }
 const adjustments=new Map();
 if(ngIds.length){const [rows]=await readBounded(pool,`SELECT o.purchase_id,a.kind,a.state,a.amount_minor,a.currency,a.event_key FROM paystack_ng_adjustments a JOIN paystack_ng_orders o ON o.id=a.order_id WHERE o.purchase_id IN (?)`,[ngIds]);
  for(const row of rows){const id=Number(row.purchase_id);if(!adjustments.has(id))adjustments.set(id,[]);adjustments.get(id).push({kind:row.kind,state:row.state,amountMinor:integer(row.amount_minor),currency:row.currency,eventKey:row.event_key});}
 }
 return purchases.map(p=>{
  const r=facts.get(Number(p.purchase_id??p.id));let valid=false;
  try{valid=!!r&&Number(r.subject_id)===Number(p.subject_id)&&Number(r.scholar_id)===Number(p.scholar_id)&&r.currency===p.currency&&r.provider_reference===(p.payment_reference??p.transaction_id)&&integer(r.gross_minor)===toMinor(p.amount,p.currency);}catch{/* Unreconciled is never a zero-valued verified sale. */}
  const n=r&&ng.get(Number(r.purchase_id));
  if(valid&&r.provider==='paystack')valid=!!n&&n.provider_transaction_id===r.provider_transaction_id&&n.order_id===r.source_key&&n.order_state==='fulfilled'&&n.payout_state==='held'&&Number(n.order_purchase)===Number(r.purchase_id)&&Number(n.order_subject)===Number(r.subject_id)&&Number(n.order_scholar)===Number(r.scholar_id)&&Number(n.sale_ordinal)===Number(r.sale_ordinal)&&Number(n.gross_minor)===Number(r.gross_minor)&&Number(n.scholar_minor)===Number(r.scholar_minor)&&Number(n.order_total)===Number(r.gross_minor)&&Number(n.receipt_amount)===Number(r.gross_minor)&&n.currency===r.currency&&n.receipt_currency===r.currency&&n.reference===r.provider_reference&&n.receipt_reference===r.provider_reference&&n.order_merchant===r.merchant_account&&n.order_environment===r.environment&&n.order_entity===r.entity&&n.evidence_digest===r.evidence_digest;
  return {...p,provider:valid?r.provider:'unreconciled',entity:valid?r.entity:null,environment:valid?r.environment:null,verificationState:valid?'verified':'unreconciled',saleOrdinal:valid?integer(r.sale_ordinal):null,scholarMinor:valid?integer(r.scholar_minor):null,feesMinor:valid&&n&&n.processing_fees_minor!=null?integer(n.processing_fees_minor):null,adjustments:valid?(adjustments.get(Number(r.purchase_id))||[]):null,payoutState:valid&&r.provider==='paystack'?'held':null,canReleaseStripe:false};
 });
}
function summarize(rows){
 const groups=new Map();
 for(const p of rows){const key=JSON.stringify([p.entity,p.provider,p.currency]),currency=p.currency;
  if(!['EUR','NGN'].includes(currency)){const g=groups.get(key)||{entity:null,provider:'unreconciled',currency,sales:0,recordedGrossMinor:null,scholarMinor:null,unsupportedCurrency:true};g.sales++;groups.set(key,g);continue;}
  const g=groups.get(key)||{entity:p.entity,provider:p.provider,currency,sales:0,recordedGrossMinor:0,verifiedGrossMinor:0,scholarMinor:0,heldScholarMinor:0,unreconciledSales:0,feesMinor:0,platformNetMinor:null};
  const gross=toMinor(p.amount,currency);g.sales++;g.recordedGrossMinor+=gross;
  if(p.verificationState==='verified'){g.verifiedGrossMinor+=gross;g.scholarMinor+=integer(p.scholarMinor);if(p.payoutState==='held')g.heldScholarMinor+=integer(p.scholarMinor);}else g.unreconciledSales++;
  if(![g.recordedGrossMinor,g.verifiedGrossMinor,g.scholarMinor,g.heldScholarMinor].every(Number.isSafeInteger))throw Object.assign(new Error('Financial total unavailable'),{code:'READ_RESULTS_UNAVAILABLE',status:503});
  g.feesMinor=g.feesMinor==null||p.feesMinor==null?null:g.feesMinor+integer(p.feesMinor);
  if(g.feesMinor!=null&&!Number.isSafeInteger(g.feesMinor))throw Object.assign(new Error('Financial total unavailable'),{status:503});
  g.platformGrossMinor=g.verifiedGrossMinor-g.scholarMinor;g.platformNetMinor=g.feesMinor==null||g.unreconciledSales?null:g.platformGrossMinor-g.feesMinor;groups.set(key,g);
 }return [...groups.values()];
}
async function history(pool,buyerId){const [rows]=await readBounded(pool,`SELECT p.*,p.id AS purchase_id,p.transaction_id AS payment_reference,s.name AS course_name FROM subject_purchases p LEFT JOIN subjects s ON s.id=p.subject_id WHERE p.buyer_user_id=? ORDER BY p.created_at DESC,p.id DESC`,[buyerId]);return purchaseEvidence(pool,rows);}
async function earnings(pool,scholarId){const [rows]=await readBounded(pool,`SELECT p.*,p.id AS purchase_id,p.transaction_id AS payment_reference,s.name AS course_name FROM subject_purchases p LEFT JOIN subjects s ON s.id=p.subject_id WHERE p.scholar_id=? ORDER BY p.created_at,p.id`,[scholarId]);const purchases=await purchaseEvidence(pool,rows);return {breakdowns:summarize(purchases),purchases,nigerianPayoutsEnabled:false,accountingNote:'Verified global ordinals only. Unreconciled amounts are not payable. Fees and bank settlement are not inferred.'};}
async function revenue(pool){const [rows]=await readBounded(pool,'SELECT p.*,p.id AS purchase_id,p.transaction_id AS payment_reference FROM subject_purchases p ORDER BY p.id');return summarize(await purchaseEvidence(pool,rows));}
module.exports={purchaseEvidence,summarize,history,earnings,revenue};
