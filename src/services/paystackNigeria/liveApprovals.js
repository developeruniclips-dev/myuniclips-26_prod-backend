'use strict';
const crypto=require('node:crypto'),L=require('./liveConfiguration'),{liveConfiguration}=require('./transportConfig');
function writerPolicy({publicKey,identity,readAttestation,authorizationDigest,now=Date.now}={}){
 return {assertSafe(){
  const a=L.ownerReview(L.signed(readAttestation(),publicKey,16384));L.bound(a,identity,now(),300000);
  const points=require('../coursePayments/writerPolicy').ENTRY_POINTS;
  if(a.kind!=='paystack-ng-live-writer-v1'||a.version!==1||a.environment!=='live'||a.mode!=='legacy_verified'||a.authorizationDigest!==authorizationDigest||a.phase2aWriters!==0||a.unknownWriters!==0||!Array.isArray(a.entryPoints)||a.entryPoints.length!==points.length||points.some(p=>a.entryPoints.filter(x=>x===p).length!==1)||!/^[a-f0-9]{64}$/.test(a.rosterEvidenceDigest||''))L.deny('WRITER_SAFETY_UNVERIFIED');
  return {mode:a.mode,expiresAt:a.expiresAt,generation:a.generation};
 }};
}
function createReceiver({env,pool,identity,publicKey,metadata,now=Date.now,createService=require('./checkoutService').createCheckoutService}={}){
 L.settings(env);require('./liveSchema').requireLiveSchema(metadata);
 if(publicKey?.asymmetricKeyType!=='ed25519')L.deny('PAYSTACK_LIVE_OWNER_KEY_REQUIRED');
 const challenge=crypto.randomBytes(32).toString('hex'),metadataDigest=L.hash(JSON.stringify(metadata)),schemaDigest=require('./liveSchema').schemaDigest();
 let sequence=0,lastWriter=-1,authorizationDigest=null,active=null,activePolicy=null;
 function status(){return {approvalMode:L.MODE,identity,challenge,sequence,schemaDigest,metadataDigest,authorityFingerprint:L.hash(publicKey.export({type:'spki',format:'der'})),database:((d)=>({host:d.host,port:d.port,name:d.name,user:d.user}))(L.settings(env))};}
 function install(envelope){
  const p=L.ownerReview(L.signed(envelope,publicKey));L.bound({...p,service:p.identity?.service,generation:p.identity?.generation,source:p.identity?.source,instance:p.identity?.instance},identity,now(),300000);
  if(p.kind!=='paystack-ng-live-packet-v1'||p.version!==1||p.challenge!==challenge||!Number.isSafeInteger(p.sequence)||p.sequence<=sequence)L.deny('PAYSTACK_LIVE_PACKET_REPLAY_OR_MISMATCH');
  if(p.authorization?.payload===p.writer?.payload||p.authorization?.signature===p.writer?.signature)L.deny('PAYSTACK_LIVE_DUPLICATE_APPROVAL');
  const config=liveConfiguration({env,secret:env.PAYSTACK_NG_SECRET_KEY,webhookSecret:env.PAYSTACK_NG_WEBHOOK_SECRET,publicKey,authorization:p.authorization,identity,now});
  if(config.schemaDigest!==schemaDigest||config.metadataDigest!==metadataDigest)L.deny('PAYSTACK_SCHEMA_APPROVAL_REQUIRED');
  const nextDigest=L.hash(JSON.stringify(p.authorization));if(authorizationDigest&&authorizationDigest!==nextDigest)L.deny('PAYSTACK_LIVE_AUTHORIZATION_RESTART_REQUIRED');
  const policy=writerPolicy({publicKey,identity,authorizationDigest:nextDigest,readAttestation:()=>p.writer,now});policy.assertSafe();
  const issued=L.signed(p.writer,publicKey).issuedAt;if(issued<lastWriter)L.deny('PAYSTACK_LIVE_WRITER_REPLAY');
  // Construct before swapping the entire active packet. Nothing is signed here.
  const store=require('./store').createMysqlStore({pool,schemaMetadata:metadata,resolveHistoricalSales:require('./liveReadiness').historicalResolver(config)});
  const service=createService({config,pool,ledgerStore:store,writerPolicy:policy});
  active=service;activePolicy=policy;authorizationDigest=nextDigest;sequence=p.sequence;lastWriter=issued;
  return {accepted:true,sequence,expiresAt:L.signed(p.writer,publicKey).expiresAt,approvalDigest:L.hash(JSON.stringify(envelope)),evidenceDigest:p.evidenceDigest};
 }
 return {status,install,runtime(){if(!active)L.deny('PAYSTACK_LIVE_APPROVAL_REQUIRED');activePolicy.assertSafe();return active;}};
}
module.exports={createReceiver,writerPolicy};
