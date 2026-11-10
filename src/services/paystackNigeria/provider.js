'use strict';
const https=require('node:https'),{createHash}=require('node:crypto');
const {decode,transactionId}=require('./transportJson'),{isConfiguration,fail}=require('./transportConfig');
const providers=new WeakSet(),sha=b=>createHash('sha256').update(b).digest('hex');
function checkoutUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='checkout.paystack.com'&&!u.port&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[A-Za-z0-9-]{1,100}$/.test(u.pathname)?u.href:null;}catch{return null;}}
function createTransport({request=https.request,deadlineMs=10000}={}){
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw Error('PAYSTACK_INVALID_DEADLINE');
 return (method,path,authorization,payload)=>new Promise((resolve,reject)=>{
  let req,res,timer,settled=false,bytes=0,abortCode;const chunks=[];
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Object.assign(new Error('Paystack request unavailable'),{code:error,status:503})):resolve(value);};
  const abort=code=>{abortCode=abortCode||code;if(!req){finish(code);return;}req.destroy();res?.destroy();};
  try{
   const body=payload?Buffer.from(JSON.stringify(payload)):null;
   req=request({protocol:'https:',hostname:'api.paystack.co',port:443,servername:'api.paystack.co',path,method,minVersion:'TLSv1.2',rejectUnauthorized:true,agent:false,
    headers:{Authorization:authorization,Accept:'application/json','Accept-Encoding':'identity',...(body?{'Content-Type':'application/json','Content-Length':body.length}:{})}},response=>{
    res=response;
    if(response.statusCode!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers['content-type']||'')||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){abort('PAYSTACK_PROVIDER_REJECTED');return;}
    response.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)abort('PAYSTACK_RESPONSE_LIMIT');else chunks.push(chunk);});
    response.on('aborted',()=>abort('PAYSTACK_TRANSPORT_UNCERTAIN'));response.on('error',()=>abort('PAYSTACK_TRANSPORT_UNCERTAIN'));
    response.on('end',()=>{if(settled||abortCode)return;try{const raw=Buffer.concat(chunks);finish(null,{data:decode(raw),digest:sha(raw)});}catch{finish('PAYSTACK_INVALID_RESPONSE');}});
   });
   req.on('error',()=>{abortCode=abortCode||'PAYSTACK_TRANSPORT_UNCERTAIN';});
   req.on('close',()=>{if(!settled&&(abortCode||!res?.complete))finish(abortCode||'PAYSTACK_TRANSPORT_UNCERTAIN');});
   timer=setTimeout(()=>abort('PAYSTACK_DEADLINE_EXCEEDED'),deadlineMs);
   if(body)req.write(body);req.end();
  }catch{abort('PAYSTACK_TRANSPORT_UNCERTAIN');}
 });
}
const metadata=o=>({uniclips_order_id:o.id,buyer_id:String(o.buyerId),subject_id:String(o.subjectId),scholar_id:String(o.scholarId),merchant_account:o.merchantAccount,environment:o.environment,policy_version:o.policyVersion});
function createProvider({config,transport=createTransport(),recordVerification,assertEligible}={}){
 if(!isConfiguration(config))fail('PAYSTACK_CONFIGURATION_UNVERIFIED');
 const provider={
  async initialize(o,email){
   config.assert(config.environment==='live'?'liveCheckout':'testCheckout');config.assertScope?.(o.subjectId,o.scholarId,o.buyerId);if(o.environment!==config.environment||o.merchantAccount!==config.merchantAccount||o.currency!=='NGN'||o.totalMinor!==150000||!/^[A-Za-z0-9.=-]{1,100}$/.test(o.reference)||!/^\S+@\S+\.\S+$/.test(email))fail('PAYSTACK_ORDER_CONTEXT');
   const callback=config.callbackOrigin+'/course/'+o.subjectId+'/'+o.scholarId+'?payment=paystack&order='+encodeURIComponent(o.id);
   const result=await transport('POST','/transaction/initialize',config.authorizationHeader(),{email,amount:'150000',currency:'NGN',reference:o.reference,callback_url:callback,metadata:JSON.stringify(metadata(o))});
   const d=result.data;if(d?.status!==true||d.data?.reference!==o.reference||!checkoutUrl(d.data?.authorization_url)||typeof d.data?.access_code!=='string'||!d.data.access_code)fail('PAYSTACK_INITIALIZATION_MISMATCH');
   return {url:checkoutUrl(d.data.authorization_url),digest:result.digest};
  },
  async verify(reference,o){
   config.assert('verification');if(!o||reference!==o.reference||o.merchantAccount!==config.merchantAccount||o.environment!==config.environment)fail('PAYSTACK_ORDER_CONTEXT');config.assertScope?.(o.subjectId,o.scholarId,o.buyerId);
   const context=await assertEligible(o);
   let result;
   try{result=await transport('GET','/transaction/verify/'+encodeURIComponent(reference),config.authorizationHeader());}
   catch(error){await recordVerification(o,{state:'pending',reason:'PAYSTACK_VERIFICATION_UNAVAILABLE',receipt:null,providerTransactionId:null,digest:null,credentialDigest:config.credentialDigest});throw Object.assign(new Error('Verification unavailable'),{code:'PAYSTACK_VERIFICATION_UNAVAILABLE',status:503});}
   const d=result.data?.data;
   if(result.data?.status!==true||!d){await recordVerification(o,{state:'pending',reason:'PAYSTACK_VERIFICATION_UNAVAILABLE',receipt:null,providerTransactionId:null,digest:result.digest,credentialDigest:config.credentialDigest});fail('PAYSTACK_VERIFICATION_UNAVAILABLE');}
   let state='review',receipt=null,reason='PAYSTACK_VERIFICATION_MISMATCH';
   const fields=metadata(o);let md=d.metadata;try{if(typeof md==='string')md=decode(Buffer.from(md));}catch{md=null;}
   const exact=d.reference===o.reference&&d.domain===config.environment&&d.amount===150000&&d.currency==='NGN'&&Object.entries(fields).every(([k,v])=>md?.[k]===v)&&sha(String(d.customer?.email||'').toLowerCase())===context.emailDigest&&(d.integration==null||String(d.integration)===config.merchantAccount);
   const noSplits=[d.split,d.subaccount,d.fees_split].every(v=>v==null||typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===0);
   let txId;try{txId=transactionId(d.id);}catch{/* Invalid IDs never become evidence. */}
   if(exact&&txId&&noSplits){
    if(['pending','ongoing','processing','queued','abandoned'].includes(d.status)){state='pending';reason='PAYSTACK_PAYMENT_PENDING';}
    else if(d.status==='failed'){state='failed';reason='PAYSTACK_PAYMENT_FAILED';}
    else if(d.status==='success'){
     const paid=typeof d.paid_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|\+00:00)$/.test(d.paid_at)?Date.parse(d.paid_at):NaN;
     if(Number.isFinite(paid)&&(d.fees==null||Number.isSafeInteger(d.fees)&&d.fees>=0)){
      state='verified';reason=null;receipt={verified:true,status:'success',reference:o.reference,transactionId:txId,orderId:o.id,buyerId:o.buyerId,subjectId:o.subjectId,scholarId:o.scholarId,merchantAccount:o.merchantAccount,environment:config.environment,currency:'NGN',amountMinor:150000,totalChargedMinor:150000,feesMinor:d.fees??null,paidAt:Math.floor(paid/1000),refundedMinor:0,disputed:false,evidenceDigest:result.digest};
     }
    }
   }
   await recordVerification(o,{state,reason,receipt,providerTransactionId:txId||null,digest:result.digest,credentialDigest:config.credentialDigest});
   if(!receipt)throw Object.assign(new Error('Payment requires verification or review'),{code:reason,status:state==='pending'?202:409,paymentState:state});
   return receipt;
  },
 };
 providers.add(provider);return Object.freeze(provider);
}
module.exports={createTransport,createProvider,checkoutUrl,metadata,isProvider:p=>providers.has(p)};
