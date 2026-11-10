'use strict';
// Explicit owner-reviewed Live pilot, never selected by a credential prefix alone.
const crypto=require('node:crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const deny=code=>{throw Object.assign(Error('Live Paystack prerequisite unavailable'),{code,status:503});};
const MODE='single-owner-live-pilot-v1';
function settings(env){
 if(env.PAYSTACK_NG_MODE!=='live'||env.PAYSTACK_NG_APPROVAL_MODE!==MODE||env.NODE_ENV!=='production'||env.UNICLIPS_SANDBOX||env.SANDBOX_APPROVAL_MODE||env.PAYMENT_ARCHITECTURE!=='legacy_verified')deny('PAYSTACK_LIVE_ISOLATION_REQUIRED');
 if(env.PAYSTACK_NG_TEST_CHECKOUT&&env.PAYSTACK_NG_TEST_CHECKOUT!=='disabled')deny('PAYSTACK_ENVIRONMENT_CONFLICT');
 for(const name of ['LIVE_CHECKOUT','VERIFICATION','WEBHOOKS'])if(!['disabled','enabled'].includes(env['PAYSTACK_NG_'+name]||'disabled'))deny('PAYSTACK_CONTROL_INVALID');
 if(!/^[A-Za-z0-9_]+$/.test(env.DB_NAME||'')||/sandbox|^mysql$|^sys$|^information_schema$|^performance_schema$/i.test(env.DB_NAME)||!env.DB_HOST||!/^\d{1,5}$/.test(env.DB_PORT||'')||!Number.isSafeInteger(Number(env.DB_PORT))||Number(env.DB_PORT)<1||Number(env.DB_PORT)>65535||!env.DB_USER||/^(root|doadmin|psngsandboxapp|psngsandboxmigrator)$/i.test(env.DB_USER)||env.DB_SSL!=='true'||!env.DB_SSL_CA)deny('PAYSTACK_LIVE_DATABASE_REQUIRED');
 let origin;try{origin=new URL(env.FRONTEND_URL);}catch{deny('PAYSTACK_LIVE_ORIGIN_REQUIRED');}
 if(origin.protocol!=='https:'||origin.origin!==env.FRONTEND_URL||origin.username||origin.password||origin.port||/sandbox|localhost/i.test(origin.hostname)||!(env.ALLOWED_ORIGINS||'').split(',').includes(origin.origin))deny('PAYSTACK_LIVE_ORIGIN_REQUIRED');
 return {host:env.DB_HOST,port:Number(env.DB_PORT),name:env.DB_NAME,user:env.DB_USER,origin:origin.origin};
}
function ownerKey(value,fingerprint){
 if(typeof value!=='string'||Buffer.byteLength(value)>8192||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\s*$/.test(value)||!/^[a-f0-9]{64}$/.test(fingerprint||''))deny('PAYSTACK_LIVE_OWNER_KEY_REQUIRED');
 let key;try{key=crypto.createPublicKey(value);}catch{deny('PAYSTACK_LIVE_OWNER_KEY_REQUIRED');}
 if(key.asymmetricKeyType!=='ed25519'||hash(key.export({format:'der',type:'spki'}))!==fingerprint)deny('PAYSTACK_LIVE_OWNER_KEY_REQUIRED');return key;
}
function signed(envelope,key,max=65536){
 try{if(typeof envelope?.payload!=='string'||Buffer.byteLength(envelope.payload)>max||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature)||!crypto.verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64')))deny('PAYSTACK_LIVE_SIGNATURE_REQUIRED');return JSON.parse(envelope.payload);}catch{deny('PAYSTACK_LIVE_SIGNATURE_REQUIRED');}
}
function ownerReview(a){if(a?.approvalMode!==MODE||a.ownerAuthorized!==true||!/^[a-f0-9]{64}$/.test(a.evidenceDigest||''))deny('PAYSTACK_LIVE_OWNER_REVIEW_REQUIRED');return a;}
function bound(a,identity,now,max){
 if(!Number.isSafeInteger(now)||!identity||['service','generation','source','instance'].some(k=>typeof identity[k]!=='string'||a[k]!==identity[k])||!Number.isSafeInteger(a.issuedAt)||!Number.isSafeInteger(a.expiresAt)||a.issuedAt>now||a.expiresAt<=now||a.expiresAt-a.issuedAt>max)deny('PAYSTACK_LIVE_APPROVAL_EXPIRED_OR_MISMATCHED');
}
function validate({env={},secret='',webhookSecret='',publicKey,authorization,identity,now=Date.now}={}){
 const db=settings(env),clock=now();
 if(publicKey?.asymmetricKeyType!=='ed25519'||!/^sk_live_[A-Za-z0-9]{16,128}$/.test(secret)||!/^whsec_[A-Za-z0-9_-]{16,200}$/.test(webhookSecret))deny('PAYSTACK_LIVE_CREDENTIAL_CONTRACT_REQUIRED');
 const a=ownerReview(signed(authorization,publicKey,32768));bound(a,identity,clock,86400000);
 if(a.kind!=='paystack-ng-live-authorization-v1'||a.version!==1||a.environment!=='live'||a.entity!=='UNICLIPS_NIGERIA_LIMITED'||!(/^[1-9]\d{0,19}$/.test(a.merchantAccount||''))||a.credentialDigest!==hash(secret)||a.webhookCredentialDigest!==hash(webhookSecret)||a.webhookScheme!=='timestamped-v1'||a.callbackOrigin!==db.origin||a.feesAbsorbed!==true||a.noAutomaticSplits!==true||!['schemaDigest','metadataDigest','auditDigest'].every(k=>/^[a-f0-9]{64}$/.test(a[k]||''))||JSON.stringify(a.database)!==JSON.stringify({host:db.host,port:db.port,name:db.name,user:db.user}))deny('PAYSTACK_LIVE_AUTHORIZATION_REQUIRED');
 const pilot=a.pilot;if(!pilot||!['buyerId','subjectId','scholarId'].every(k=>Number.isSafeInteger(pilot[k])&&pilot[k]>0)||pilot.buyerId===pilot.scholarId)deny('PAYSTACK_LIVE_PILOT_REQUIRED');
 if(a.commercialTermsReviewed!==true||a.payoutHoldAccepted!==true)deny('PAYSTACK_LIVE_COMMERCIAL_REVIEW_REQUIRED');
 const controls={liveCheckout:env.PAYSTACK_NG_LIVE_CHECKOUT==='enabled',verification:env.PAYSTACK_NG_VERIFICATION==='enabled',webhooks:env.PAYSTACK_NG_WEBHOOKS==='enabled'};
 for(const [k,name]of Object.entries({liveCheckout:'LIVE_CHECKOUT',verification:'VERIFICATION',webhooks:'WEBHOOKS'}))if(controls[k]&&a.controls?.[name]!==true)deny('PAYSTACK_LIVE_AUTHORIZATION_REQUIRED');
 if(!Object.values(controls).some(Boolean))deny('PAYSTACK_CONTROL_DISABLED');
 const config={enabled:true,environment:'live',entity:a.entity,merchantAccount:a.merchantAccount,credentialDigest:a.credentialDigest,callbackOrigin:db.origin,webhookScheme:a.webhookScheme,schemaDigest:a.schemaDigest,metadataDigest:a.metadataDigest,auditDigest:a.auditDigest,pilot:Object.freeze({...pilot}),database:Object.freeze({...a.database}),testCheckout:false,...controls,
  assert(control){const clock=now();if(!Number.isSafeInteger(clock)||clock<a.issuedAt||clock>=a.expiresAt||!controls[control])deny('PAYSTACK_CONTROL_DISABLED');},
  assertScope(subjectId,scholarId,buyerId){if(Number(subjectId)!==pilot.subjectId||Number(scholarId)!==pilot.scholarId||buyerId!==undefined&&Number(buyerId)!==pilot.buyerId)deny('PAYSTACK_LIVE_PILOT_ONLY');},
  authorizationHeader(){return 'Bearer '+secret;},signingSecret(){return webhookSecret;}};
 return Object.freeze(config);
}
module.exports={MODE,settings,ownerKey,signed,ownerReview,bound,validate,deny,hash};
