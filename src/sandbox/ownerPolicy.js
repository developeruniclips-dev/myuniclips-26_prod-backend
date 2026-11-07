'use strict';
// This policy is confined to the named synthetic Test sandbox, never production.
const crypto=require('node:crypto');
const {fail}=require('./isolation');
const MODE='single-owner-v1';
function approval(p){
 if(!p||p.approvalMode!==MODE||p.ownerAuthorized!==true||!/^[a-f0-9]{64}$/.test(p.evidenceDigest||''))fail('SANDBOX_OWNER_APPROVAL_REQUIRED');
 if(['independentlyReviewed','independentReview','review','reviewerKey'].some(k=>Object.hasOwn(p,k)))fail('SANDBOX_LEGACY_REVIEW_REJECTED');
 return p;
}
function ownerKey(key){
 try{const k=key?.type==='public'?key:crypto.createPublicKey(key);if(k.asymmetricKeyType!=='ed25519')throw Error();}
 catch{fail('SANDBOX_OWNER_ED25519_REQUIRED');}
}
// Called inside the import transaction AFTER its existing subject lock. Checkout
// and fulfillment take that same lock. Never convert a nonempty scope to zero.
async function requireEmptyFinancialState(db){
 const tables=['subject_purchases','purchases','transactions','scholar_payouts','course_sale_audits','course_sale_proofs',
  'paystack_ng_orders','paystack_ng_transactions','paystack_ng_events','paystack_ng_sale_counters',
  'paystack_ng_allocations','paystack_ng_adjustments','paystack_ng_checkouts','paystack_ng_verifications'];
 const [[r]]=await db.query('SELECT '+tables.map(t=>'(SELECT COUNT(*) FROM '+t+')').join('+')+' AS financial_rows');
 if(String(r.financial_rows)!=='0')fail('SANDBOX_ZERO_NONEMPTY');
}
module.exports={MODE,approval,ownerKey,requireEmptyFinancialState};
