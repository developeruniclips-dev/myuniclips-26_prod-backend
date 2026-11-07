'use strict';
const {toMinor,allocation}=require('../payments/money');
// Provenance must come from the independently reviewed evidence batch, never
// from a transaction ID, a payout status, or today's provider configuration.
function createStoredSourceVerifier({verifyProvenance}={}){
 return async(db,fact,purchase)=>{
  if(typeof verifyProvenance!=='function'||await verifyProvenance(Object.freeze({...fact}))!==true)return false;
  try{
   const number=n=>Number.isSafeInteger(Number(n))?Number(n):NaN;
   if(number(purchase.id)!==number(fact.purchase_id)||number(purchase.subject_id)!==number(fact.subject_id)||number(purchase.scholar_id)!==number(fact.scholar_id)||purchase.transaction_id!==fact.provider_reference||purchase.currency!==fact.currency||toMinor(purchase.amount,purchase.currency)!==number(fact.gross_minor))return false;
   const share=allocation(number(fact.gross_minor),number(fact.sale_ordinal));
   if(share.scholar!==number(fact.scholar_minor)||share.rate!==number(fact.scholar_rate))return false;
   if(fact.source_kind==='audited_opening')return fact.provider==='stripe'&&fact.currency==='EUR';
   if(fact.source_kind==='legacy_verified'){
    const [rows]=await db.query('SELECT * FROM scholar_payouts WHERE id=? AND scholar_user_id=? LIMIT 2',[fact.source_key,fact.scholar_id]);if(rows.length!==1)return false;
    const row=rows[0],i=JSON.parse(row.description);
    return fact.provider==='stripe'&&fact.entity==='UNICLIPS_OY'&&i.kind==='uniclips_legacy_verified_v1'&&number(i.purchaseId)===number(purchase.id)&&i.paymentId===fact.provider_reference&&i.paymentId===fact.provider_transaction_id&&i.account===fact.merchant_account&&i.livemode===(fact.environment==='live')&&i.currency==='EUR'&&String(row.currency).toUpperCase()==='EUR'&&toMinor(row.amount,'EUR')===share.scholar&&i.amountMinor===share.scholar&&i.grossMinor===number(fact.gross_minor)&&i.ordinal===number(fact.sale_ordinal)&&i.rate===share.rate;
   }
   if(fact.source_kind==='phase2a'){
    const [rows]=await db.query(`SELECT o.*,a.sale_ordinal,a.scholar_rate,a.scholar_minor,a.gross_minor FROM payment_orders o JOIN payment_allocations a ON a.order_id=o.id WHERE o.id=? AND o.purchase_id=? LIMIT 2`,[fact.source_key,purchase.id]);if(rows.length!==1)return false;const r=rows[0];
    return fact.provider==='stripe'&&fact.entity==='UNICLIPS_OY'&&r.provider==='stripe'&&r.state==='fulfilled'&&number(r.buyer_id)===number(purchase.buyer_user_id)&&number(r.subject_id)===number(fact.subject_id)&&number(r.scholar_id)===number(fact.scholar_id)&&r.provider_account===fact.merchant_account&&Boolean(r.livemode)===(fact.environment==='live')&&r.payment_id===fact.provider_transaction_id&&r.payment_id===fact.provider_reference&&r.currency===fact.currency&&number(r.amount_minor)===number(fact.gross_minor)&&number(r.gross_minor)===number(fact.gross_minor)&&number(r.sale_ordinal)===number(fact.sale_ordinal)&&number(r.scholar_minor)===share.scholar&&number(r.scholar_rate)===share.rate;
   }
   if(fact.source_kind==='paystack_ng'){
    const [rows]=await db.query(`SELECT o.*,a.sale_ordinal,a.scholar_rate,a.scholar_minor,a.gross_minor,a.payout_state,t.provider_transaction_id,t.evidence_digest FROM paystack_ng_orders o JOIN paystack_ng_allocations a ON a.order_id=o.id JOIN paystack_ng_transactions t ON t.order_id=o.id WHERE o.id=? AND o.purchase_id=? LIMIT 2`,[fact.source_key,purchase.id]);if(rows.length!==1)return false;const r=rows[0];
    return fact.provider==='paystack'&&r.state==='fulfilled'&&r.payout_state==='held'&&r.entity===fact.entity&&r.merchant_account===fact.merchant_account&&r.environment===fact.environment&&r.reference===fact.provider_reference&&r.provider_transaction_id===fact.provider_transaction_id&&r.evidence_digest===fact.evidence_digest&&number(r.buyer_id)===number(purchase.buyer_user_id)&&number(r.subject_id)===number(fact.subject_id)&&number(r.scholar_id)===number(fact.scholar_id)&&r.currency==='NGN'&&number(r.total_minor)===150000&&number(r.gross_minor)===150000&&number(r.sale_ordinal)===number(fact.sale_ordinal)&&number(r.scholar_minor)===share.scholar&&number(r.scholar_rate)===share.rate;
   }return false;
  }catch(e){if(e.code&&e.code!=='ER_NO_SUCH_TABLE')throw e;return false;}
 };
}
module.exports={createStoredSourceVerifier};
