'use strict';
const {pool}=require('../config/db');
const routing=require('../services/coursePayments/routing');
const reporting=require('../services/coursePayments/reporting');
const {catalogueReads}=require('../utils/readCapacity');
const failure=(res,e)=>{require('../utils/safeLogging').logError('Course payment request failed',e);return res.status(e.status||503).json({message:'Course payment information is unavailable',code:e.status?e.code:'PAYMENT_INFORMATION_UNAVAILABLE'});};
const run=work=>async(req,res)=>{try{res.json(await catalogueReads.run(String(req.user?.id||'public'),()=>work(req)));}catch(e){failure(res,e);}};
exports.offering=run(async req=>{
 const result=await routing.offering(pool,req.query.subjectId,req.query.scholarId);
 if(result.payment.provider==='paystack'&&result.payment.unavailableCode==='PAYSTACK_CHECKOUT_DISABLED'){
  try{const ng=require('../services/paystackNigeria/runtime').paymentRuntime();if(ng.enabled)Object.assign(result.payment,await ng.quote(result.subjectId,result.scholarId));}
  catch{result.payment.checkoutEnabled=false;result.payment.unavailableCode='PAYSTACK_TEST_NOT_READY';}
 }
 return result;
});
exports.history=run(async req=>({purchases:await reporting.history(pool,req.user.id)}));
exports.status=run(async req=>{
 const match=/^(stripe|paystack):([A-Za-z0-9_-]{1,100})$/.exec(req.params.orderId||'');if(!match)throw routing.error('ORDER_NOT_FOUND',404);
 if(match[1]==='stripe')return {provider:'stripe',...await require('../services/paymentRelease').paymentRuntime().payments.orderStatus(match[2],req.user.id)};
 const ng=require('../services/paystackNigeria/runtime').paymentRuntime();if(ng.enabled)return ng.status(match[2],req.user.id);
 const [rows]=await require('../utils/readCapacity').readQuery(pool,'SELECT id,state,currency,total_minor AS amountMinor,subject_id AS subjectId,scholar_id AS scholarId,purchase_id FROM paystack_ng_orders WHERE id=? AND buyer_id=? LIMIT 1',[match[2],req.user.id]);
 if(!rows.length)throw routing.error('ORDER_NOT_FOUND',404);return {...rows[0],provider:'paystack',checkoutEnabled:false,payoutState:'held'};
});
exports.earnings=run(async req=>({...await require('../services/payments/earningsService').scholarEarnings(pool,req.user.id),...await reporting.earnings(pool,req.user.id)}));
exports.checkout=async(req,res)=>{try{
 const ids=routing.checkoutInput(req.body),o=await catalogueReads.run(String(req.user.id),()=>routing.offering(pool,ids.subjectId,ids.scholarId));
 if(req.body.contextVersion&&req.body.contextVersion!==o.payment.contextVersion)throw routing.error('PAYMENT_CONTEXT_CHANGED');
 if(o.payment.provider==='paystack'){
  if(o.payment.unavailableCode!=='PAYSTACK_CHECKOUT_DISABLED')throw routing.error('OFFERING_UNAVAILABLE');
  const ng=require('../services/paystackNigeria/runtime').paymentRuntime();if(!ng.enabled)throw routing.error('PAYSTACK_CHECKOUT_DISABLED');
  if(!req.body.contextVersion)throw routing.error('PAYMENT_CONTEXT_REQUIRED',400);
  return res.json(await ng.checkout({...ids,buyerId:req.user.id,idempotencyKey:req.body.idempotencyKey}));
 }
 if(!o.payment.checkoutEnabled||o.payment.provider!=='stripe')throw routing.error('STRIPE_UNAVAILABLE');
 res.json(await require('../services/paymentRelease').paymentRuntime().payments.createOrder(req.user.id,o.subjectId,o.scholarId));
 }catch(e){failure(res,e);}};
exports.verify=async(req,res)=>{try{
 if(!req.body||Object.keys(req.body).join(',')!=='orderId'||typeof req.body.orderId!=='string'||!/^[a-f0-9-]{36}$/.test(req.body.orderId))throw routing.error('INVALID_ORDER',400);
 const ng=require('../services/paystackNigeria/runtime').paymentRuntime();if(!ng.enabled)throw routing.error('PAYSTACK_DISABLED',503);
 res.json(await ng.verify(req.body.orderId,req.user.id));
 }catch(e){failure(res,e);}};
