'use strict';
const {verify,createHash}=require('node:crypto');
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error('Paystack configuration is unavailable'),{code,status:503});};
const configs=new WeakSet();
function configuration({env={},secret='',webhookSecret='',publicKey,authorization,identity,now=Date.now}={}){
 if(env.PAYSTACK_NG_LIVE_CHECKOUT&&env.PAYSTACK_NG_LIVE_CHECKOUT!=='disabled')fail('PAYSTACK_LIVE_NOT_SUPPORTED');
 const requested=['TEST_CHECKOUT','VERIFICATION','WEBHOOKS'].filter(k=>env['PAYSTACK_NG_'+k]==='enabled');
 if(!requested.length)return Object.freeze({enabled:false,liveCheckout:false});
 try{
  if(!['test','development'].includes(env.NODE_ENV)||!identity||!['service','generation','source'].every(k=>typeof identity[k]==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(identity[k]))||!publicKey||!/^sk_test_[A-Za-z0-9]{16,128}$/.test(secret)||typeof authorization?.payload!=='string'||authorization.payload.length>16384||!verify(null,Buffer.from(authorization.payload),publicKey,Buffer.from(authorization.signature||'','base64')))fail('PAYSTACK_AUTHORIZATION_REQUIRED');
  const a=JSON.parse(authorization.payload),clock=now();
  if(!Number.isSafeInteger(clock)||a.version!==1||a.environment!=='test'||a.entity!=='UNICLIPS_NIGERIA_LIMITED'||!(/^[1-9]\d{0,19}$/.test(a.merchantAccount))||a.credentialDigest!==digest(secret)||a.service!==identity.service||a.generation!==identity.generation||a.source!==identity.source||!Number.isSafeInteger(a.issuedAt)||!Number.isSafeInteger(a.expiresAt)||a.issuedAt>clock||a.expiresAt<=clock||a.expiresAt-a.issuedAt>86400000||a.feesAbsorbed!==true||a.noAutomaticSplits!==true||requested.some(k=>a.controls?.[k]!==true))fail('PAYSTACK_AUTHORIZATION_REQUIRED');
  const origin=new URL(a.callbackOrigin);if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash)fail('PAYSTACK_CALLBACK_CONFIGURATION');
  if(!['timestamped-v1','legacy-sha512'].includes(a.webhookScheme))fail('PAYSTACK_WEBHOOK_CONTRACT_REQUIRED');
  if(a.webhookScheme==='timestamped-v1'&&(!/^whsec_[A-Za-z0-9_-]{16,200}$/.test(webhookSecret)||a.webhookCredentialDigest!==digest(webhookSecret)))fail('PAYSTACK_WEBHOOK_CONTRACT_REQUIRED');
  if(!/^[a-f0-9]{64}$/.test(a.schemaDigest||''))fail('PAYSTACK_SCHEMA_APPROVAL_REQUIRED');
  const config={enabled:true,environment:'test',entity:a.entity,merchantAccount:a.merchantAccount,credentialDigest:a.credentialDigest,callbackOrigin:origin.origin,webhookScheme:a.webhookScheme,schemaDigest:a.schemaDigest,
   testCheckout:requested.includes('TEST_CHECKOUT'),verification:requested.includes('VERIFICATION'),webhooks:requested.includes('WEBHOOKS'),liveCheckout:false,
   assert(control){if(now()>=a.expiresAt||!this[control])fail('PAYSTACK_CONTROL_DISABLED');},
   authorizationHeader(){return 'Bearer '+secret;},signingSecret(){return a.webhookScheme==='timestamped-v1'?webhookSecret:secret;}};
  configs.add(config);return Object.freeze(config);
 }catch(e){if(e.status)throw e;fail('PAYSTACK_CONFIGURATION_UNVERIFIED');}
}
module.exports={configuration,digest,fail,isConfiguration:c=>configs.has(c)};
