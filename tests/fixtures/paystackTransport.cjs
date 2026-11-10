'use strict';
const crypto=require('node:crypto');
const {configuration,digest}=require('../../src/services/paystackNigeria/transportConfig');
const {metadata}=require('../../src/services/paystackNigeria/provider');
function inputs({patch={},envPatch={},scheme='timestamped-v1',now=Date.now}={}){
 const keys=crypto.generateKeyPairSync('ed25519'),secret=['sk','test',crypto.randomBytes(24).toString('hex')].join('_'),webhookSecret='whsec_'+crypto.randomBytes(24).toString('hex');
 const identity={service:'synthetic',generation:'fixture',source:'offline'},clock=now();
 const a={version:1,environment:'test',entity:'UNICLIPS_NIGERIA_LIMITED',merchantAccount:'100043',credentialDigest:digest(secret),webhookCredentialDigest:digest(webhookSecret),callbackOrigin:'https://ui.example.invalid',webhookScheme:scheme,schemaDigest:require('../../src/services/paystackNigeria/runtime').schemaDigest(),issuedAt:clock,expiresAt:clock+3600000,feesAbsorbed:true,noAutomaticSplits:true,...identity,controls:{TEST_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true},...patch};
 const payload=JSON.stringify(a),authorization={payload,signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString('base64')};
 const options={env:{NODE_ENV:'test',PAYSTACK_NG_TEST_CHECKOUT:'enabled',PAYSTACK_NG_VERIFICATION:'enabled',PAYSTACK_NG_WEBHOOKS:'enabled',...envPatch},secret,webhookSecret,publicKey:keys.publicKey,authorization,identity,now};
 return {...options,config:()=>configuration(options)};
}
function response(o,email='u'+o.buyerId+'@example.invalid',patch={}){return {status:true,data:{id:'18446744073709551615',domain:'test',status:'success',reference:o.reference,amount:150000,currency:'NGN',fees:1500,paid_at:new Date(o.createdAt).toISOString(),customer:{email},metadata:metadata(o),split:{},subaccount:{},fees_split:null,...patch}};}
function signature(raw,f,t=Math.floor(Date.now()/1000)){return f.config().webhookScheme==='legacy-sha512'?{'x-paystack-signature':crypto.createHmac('sha512',f.secret).update(raw).digest('hex')}:{'paystack-signature':`t=${t},v1=whk_fixture:${crypto.createHmac('sha512',f.webhookSecret).update(String(t)+'.').update(raw).digest('hex')}`};}
function fixture({history=0,configInput=inputs()}={}){
 const {createMemoryStore,historical}=require('./paystackNigeriaMemory.cjs'),W=require('./courseWriterPolicy.cjs');
 const store=createMemoryStore(history?historical(history):{}),checks=new Map(),verifications=[],events=new Map(),calls=[];
 const state={verifyPatch:{},initFailure:false,initPause:null,verifyPause:null,audited:true,guardFailure:false};
 const memory={
  async beginInitialization(o){if(checks.has(o.id))return {started:false,record:checks.get(o.id)};checks.set(o.id,{state:'initializing',email_digest:digest(('u'+o.buyerId+'@example.invalid').toLowerCase()),credential_digest:configInput.config().credentialDigest});return {started:true,email:'u'+o.buyerId+'@example.invalid'};},
  async finishInitialization(o,r){Object.assign(checks.get(o.id),{state:r?'ready':'uncertain',checkout_url:r?.url});},
  async assertEligible(o){const r=checks.get(o.id);if(!r||r.review_code)throw Object.assign(Error('review'),{code:'PAYSTACK_PAYMENT_REVIEW_REQUIRED'});return {emailDigest:r.email_digest};},
  async recordVerification(o,v){if([...events.values()].some(e=>e.state==='review'&&((e.transactionId||e.relatedTransactionId)===v.providerTransactionId||!e.transactionId&&!e.relatedTransactionId&&/^(refund\.|charge\.dispute\.)/.test(e.type))))v={...v,state:'review',reason:'PAYSTACK_EVENT_REVIEW_REQUIRED',receipt:null};verifications.push({...v,orderId:o.id});if(v.state==='review')checks.get(o.id).review_code=v.reason;if(v.state==='failed')checks.get(o.id).state='failed';},
  async hold(o,c){checks.get(o.id).review_code=c;},
  async status(id,buyer){const o=store.state().orders.find(o=>o.id===id&&o.buyerId===buyer);if(!o)throw Error('owned order missing');const r=checks.get(id);return {provider:'paystack',orderId:id,subjectId:o.subjectId,scholarId:o.scholarId,currency:'NGN',amountMinor:150000,success:o.state==='fulfilled',state:r?.review_code?'review':o.state==='fulfilled'?'fulfilled':r?.state==='failed'?'failed':'pending',payoutState:'held'};},
  async recordEvent(e){const previous=events.get(e.key),o=store.state().orders.find(o=>o.reference===e.reference);const review=!o||e.type!=='charge.success'||e.amount!==150000||e.currency!=='NGN'||e.domain!==configInput.config().environment||previous?.state==='review'||previous&&previous.claimsDigest!==e.claimsDigest;if(!previous)events.set(e.key,{...e,state:review?'review':'received'});if(review&&o)checks.get(o.id).review_code='event';return {orderId:o?.id,buyerId:o?.buyerId,review,processed:previous?.state==='processed'};},
  async completeEvent(k,s){events.get(k).state=s;},
 };
 store.controls.transportGuard=async(o,e)=>{if(state.guardFailure||checks.get(o.id)?.review_code||!verifications.some(v=>v.orderId===o.id&&v.state==='verified'&&v.receipt?.transactionId===e.transactionId))throw Object.assign(Error('guard'),{code:'PAYSTACK_PAYMENT_REVIEW_REQUIRED'});};
 const ledgerStore={...store,transaction:work=>store.transaction(tx=>work({...tx,historicalProofs:async(...args)=>{if(!state.audited)throw Object.assign(Error('audit missing'),{code:'BASELINE_AUDIT_REQUIRED'});return tx.historicalProofs(...args);}}))};
 const transport=async(method,p,auth,body)=>{calls.push({method,path:p,body});if(method==='POST'){if(state.initPause)await state.initPause;if(state.initFailure)throw Error('uncertain');return {data:{status:true,data:{authorization_url:'https://checkout.paystack.com/fixture-token',reference:body.reference,access_code:'fixture-token'}},digest:digest('initialize')};}
  if(state.verifyPause)await state.verifyPause;if(state.verifyFailure)throw Error('SYNTHETIC_VERIFY_TIMEOUT');const o=store.state().orders.find(o=>p.endsWith(o.reference));return {data:response(o,undefined,state.verifyPatch),digest:digest(JSON.stringify(state.verifyPatch))};};
 const api=require('../../src/services/paystackNigeria/checkoutService').createCheckoutService({config:configInput.config(),ledgerStore,writerPolicy:W(),transportStore:memory,transport});
 return {api,store,checks,verifications,events,calls,state,configInput,input:{buyerId:1,subjectId:10,scholarId:20,idempotencyKey:crypto.randomUUID()}};
}
module.exports={inputs,response,signature,fixture};
