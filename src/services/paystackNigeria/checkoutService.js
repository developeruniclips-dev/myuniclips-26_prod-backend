'use strict';
const {createReadBudget}=require('../../utils/readCapacity'),{createPolicy}=require('./policy'),{createServices}=require('./services');
const {createProvider,checkoutUrl}=require('./provider'),{createTransportStore}=require('./transportStore'),{fail}=require('./transportConfig');
const {authenticate,event}=require('./webhooks');
function createCheckoutService({config,ledgerStore,pool,writerPolicy,transport,transportStore=createTransportStore({pool,config})}={}){
 const budget=createReadBudget({global:2,perUser:1});
 const provider=createProvider({config,transport,recordVerification:(o,v)=>transportStore.recordVerification(o,v),assertEligible:o=>transportStore.assertEligible(o)});
 const ledger=createServices({store:ledgerStore,provider,policy:createPolicy({enabled:true,merchantAccount:config.merchantAccount}),writerPolicy});
 async function inspect(subjectId,scholarId){config.assert('testCheckout');config.assert('verification');return ledger.inspectOffering(subjectId,scholarId);}
 async function verifyOrder(orderId,buyerId){
  config.assert('verification');await writerPolicy.assertSafe();
  try{await ledger.fulfill({orderId,buyerId});}
  catch(e){
   if(e.paymentState||e.code==='PAYSTACK_PAYMENT_REVIEW_REQUIRED')return transportStore.status(orderId,buyerId);
   const review=/^(BASELINE_|INVALID_SALE_PROOF|ORDER_CONTEXT_|ORDER_REQUIRES_REVIEW|ORDER_STATE_CHANGED|OFFERING_|REPURCHASE_|PAYMENT_TIME_|PAYMENT_EVIDENCE_MISMATCH|PAYSTACK_EVENT_REVIEW_REQUIRED)/.test(e.code||'');
   if(review){const o=await ledgerStore.readOrder(orderId);if(o?.buyerId===buyerId)await transportStore.hold(o,e.code);return transportStore.status(orderId,buyerId);}throw e;
  }
  return transportStore.status(orderId,buyerId);
 }
 return {
  enabled:true,budget,
  quote:(s,c)=>budget.run(null,async()=>{await inspect(s,c);return {checkoutEnabled:true,checkoutMode:'test',unavailableCode:null};}),
  checkout:input=>budget.run(input.buyerId,async()=>{
   await inspect(input.subjectId,input.scholarId);
   const o=await ledger.createOrder(input);if(o.state==='fulfilled')return transportStore.status(o.id,input.buyerId);
   const attempt=await transportStore.beginInitialization(o);
   if(attempt.fulfilled)return transportStore.status(o.id,input.buyerId);
   if(!attempt.started){const r=attempt.record;return {orderId:o.id,provider:'paystack',state:r.state==='ready'&&!r.review_code?'ready':'pending',url:r.state==='ready'&&!r.review_code?checkoutUrl(r.checkout_url):null};}
   let result;
   try{result=await provider.initialize(o,attempt.email);}
   catch{await transportStore.finishInitialization(o,null);return {orderId:o.id,provider:'paystack',state:'pending',url:null};}
   // If this commit is ambiguous, a retry reads the durable marker; no new POST.
   await transportStore.finishInitialization(o,result);return {orderId:o.id,provider:'paystack',state:'ready',url:result.url};
  }),
  verify:(id,buyer)=>budget.run(buyer,()=>verifyOrder(id,buyer)),
  status:(id,buyer)=>budget.run(buyer,()=>transportStore.status(id,buyer)),
  async webhook(raw,headers){
   authenticate(raw,headers,config);const claim=event(raw);
   // Await every started operation. A failed/capacity-limited attempt remains
   // durably received and returns non-200 so Paystack can redeliver safely.
   return budget.run(null,async()=>{
    const saved=await transportStore.recordEvent(claim);
    if(saved.review||saved.processed)return {received:true,state:saved.review?'review':'processed'};
    const result=await verifyOrder(saved.orderId,saved.buyerId),state=result.state==='fulfilled'?'processed':result.state==='review'?'review':'pending';
    await transportStore.completeEvent(claim.key,state);if(state==='pending')fail('PAYSTACK_VERIFICATION_PENDING');return {received:true,state};
   });
  },
 };
}
module.exports={createCheckoutService};
