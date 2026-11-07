'use strict';
const {createHmac,timingSafeEqual,createHash}=require('node:crypto');
const {decode,transactionId}=require('./transportJson'),{fail}=require('./transportConfig');
const hash=value=>createHash('sha256').update(value).digest('hex');
function authenticate(raw,headers,config,now=Date.now){
 config.assert('webhooks');if(!Buffer.isBuffer(raw)||raw.length>262144)fail('PAYSTACK_RAW_BODY_REQUIRED');
 const bad=()=>{throw Object.assign(new Error('Invalid webhook signature'),{code:'PAYSTACK_INVALID_SIGNATURE',status:401});};
 const check=(expected,hex)=>typeof hex==='string'&&/^[0-9a-f]{128}$/.test(hex)&&timingSafeEqual(expected,Buffer.from(hex,'hex'));
 if(config.webhookScheme==='timestamped-v1'){
  const h=headers['paystack-signature'];if(typeof h!=='string'||h.length>2048)bad();const parts=h.split(',').map(p=>p.trim()),times=parts.filter(p=>p.startsWith('t='));
  if(times.length!==1||!/^t=[1-9]\d{0,12}$/.test(times[0]))bad();const t=times[0].slice(2);if(Math.abs(Math.floor(now()/1000)-Number(t))>300)bad();
  const signatures=parts.filter(p=>p.startsWith('v1='));if(!signatures.length||signatures.length>4)bad();
  const expected=createHmac('sha512',config.signingSecret()).update(t+'.').update(raw).digest();
  if(!signatures.some(s=>{const m=/^v1=whk_[A-Za-z0-9_-]{1,128}:([a-f0-9]{128})$/.exec(s);return m&&check(expected,m[1]);}))bad();
 }else{
  // Explicit legacy-only contract. Never downgrade a failed modern signature.
  if(headers['paystack-signature'])bad();
  if(!check(createHmac('sha512',config.signingSecret()).update(raw).digest(),headers['x-paystack-signature']))bad();
 }
}
function event(raw){
 let e;try{e=decode(raw);}catch{throw Object.assign(Error('Invalid webhook event'),{status:400,code:'PAYSTACK_INVALID_EVENT'});}
 if(typeof e?.event!=='string'||!/^[a-z][a-z0-9_.]{0,99}$/.test(e.event)||!e.data||typeof e.data!=='object')throw Object.assign(Error('Invalid webhook event'),{status:400,code:'PAYSTACK_INVALID_EVENT'});
 const d=e.data;let txId=null;try{txId=transactionId(d.id);}catch{/* Retain invalid claims for review, never fulfill them. */}
 const ref=typeof d.reference==='string'?d.reference:typeof d.transaction?.reference==='string'?d.transaction.reference:null;
 const reference=typeof ref==='string'&&/^[A-Za-z0-9.=-]{1,100}$/.test(ref)?ref:null;
 let relatedTransactionId=null;try{if(e.event!=='charge.success')relatedTransactionId=transactionId(d.transaction?.id??d.transaction);}catch{/* Unknown linkage remains durable review. */}
 const resourceId=txId||hash(raw),claims={type:e.event,resourceId,reference,domain:d.domain??null,amount:d.amount??null,currency:d.currency??null,integration:d.integration==null?null:String(d.integration)};
 claims.relatedTransactionId=relatedTransactionId;
 return {...claims,type:e.event,transactionId:e.event==='charge.success'?txId:null,claims,claimsDigest:hash(JSON.stringify(claims)),digest:hash(raw),key:hash(JSON.stringify([e.event,resourceId]))};
}
module.exports={authenticate,event};
