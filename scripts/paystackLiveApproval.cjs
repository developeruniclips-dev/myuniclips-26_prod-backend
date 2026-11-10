'use strict';
// Owner-operated offline drafting/signing only. No key generation, DB or network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),L=require('../src/services/paystackNigeria/liveConfiguration');
const readExternal=file=>{const s=fs.lstatSync(file),p=fs.realpathSync(file),root=path.resolve(__dirname,'../../..');if(!s.isFile()||s.isSymbolicLink()||s.size>32768||p.toLowerCase().startsWith(root.toLowerCase()+path.sep))L.deny('LIVE_PRIVATE_INPUT_MUST_BE_EXTERNAL');return fs.readFileSync(p,'utf8');};
function draft(kind,i,now=Date.now()){
 L.ownerReview(i);const c=i.challenge;
 if(kind==='authorization'&&(i.commercialTermsReviewed!==true||i.payoutHoldAccepted!==true))L.deny('LIVE_OWNER_REVIEW_INCOMPLETE');
 if(c?.approvalMode!==L.MODE||!['source','schemaDigest','metadataDigest','authorityFingerprint'].every(k=>/^[a-f0-9]{64}$/.test(k==='source'?c.identity?.source:c[k]||'')))L.deny('LIVE_CHALLENGE_REQUIRED');
 const common={approvalMode:L.MODE,ownerAuthorized:true,evidenceDigest:i.evidenceDigest,authorityFingerprint:c.authorityFingerprint};
 if(kind==='authorization'){
  const secret=readExternal(i.liveSecretFile).trim(),webhook=readExternal(i.webhookSecretFile).trim();
  if(!/^sk_live_[A-Za-z0-9]{16,128}$/.test(secret)||!/^whsec_[A-Za-z0-9_-]{16,200}$/.test(webhook)||!(/^[1-9]\d{0,19}$/.test(i.merchantAccount||''))||!['buyerId','subjectId','scholarId'].every(k=>Number.isSafeInteger(i.pilot?.[k])&&i.pilot[k]>0)||i.pilot.buyerId===i.pilot.scholarId||!/^[a-f0-9]{64}$/.test(i.auditDigest||'')||i.feesAbsorbed!==true||i.noAutomaticSplits!==true)L.deny('LIVE_OWNER_REVIEW_INCOMPLETE');
  return {kind:'authorization',value:{...common,kind:'paystack-ng-live-authorization-v1',version:1,environment:'live',entity:'UNICLIPS_NIGERIA_LIMITED',...c.identity,issuedAt:now,expiresAt:now+86400000,merchantAccount:i.merchantAccount,database:c.database,pilot:i.pilot,auditDigest:i.auditDigest,schemaDigest:c.schemaDigest,metadataDigest:c.metadataDigest,credentialDigest:L.hash(secret),webhookCredentialDigest:L.hash(webhook),webhookScheme:'timestamped-v1',callbackOrigin:i.callbackOrigin,feesAbsorbed:true,noAutomaticSplits:true,commercialTermsReviewed:true,payoutHoldAccepted:true,controls:{LIVE_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true}}};
 }
 if(kind==='writer'){
  const points=require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS;
  if(!Array.isArray(i.observations)||i.observations.length!==points.length||points.some(k=>i.observations.filter(o=>o.entryPoint===k&&o.conclusion==='legacy-only-or-absent'&&/^[a-f0-9]{64}$/.test(o.evidenceDigest||'')&&Number.isSafeInteger(o.checkedAt)&&o.checkedAt<=now&&now-o.checkedAt<300000).length!==1)||!i.authorization?.payload||!i.authorization?.signature)L.deny('FRESH_LIVE_WRITER_REVIEW_REQUIRED');
  return {kind:'writer',value:{...common,kind:'paystack-ng-live-writer-v1',version:1,environment:'live',mode:'legacy_verified',...c.identity,issuedAt:now,expiresAt:now+300000,authorizationDigest:L.hash(JSON.stringify(i.authorization)),phase2aWriters:0,unknownWriters:0,entryPoints:points,rosterEvidenceDigest:L.hash(JSON.stringify(i.observations))}};
 }
 if(kind==='packet')return {...common,kind:'paystack-ng-live-packet-v1',version:1,identity:c.identity,challenge:c.challenge,sequence:c.sequence+1,issuedAt:now,expiresAt:now+300000,authorization:i.authorization,writer:i.writer};
 L.deny('LIVE_DRAFT_KIND_REFUSED');
}
function signReviewed(draft,key,now=Date.now()){
 const body=['authorization','writer'].includes(draft?.kind)?draft.value:draft;
 L.ownerReview(body);
 if(!['paystack-ng-live-authorization-v1','paystack-ng-live-writer-v1','paystack-ng-live-packet-v1'].includes(body.kind)||key.asymmetricKeyType!=='ed25519'||L.hash(crypto.createPublicKey(key).export({type:'spki',format:'der'}))!==body.authorityFingerprint)L.deny('LIVE_SIGNING_REVIEW_REQUIRED');
 const max=body.kind==='paystack-ng-live-authorization-v1'?86400000:300000;
 if(!Number.isSafeInteger(body.issuedAt)||!Number.isSafeInteger(body.expiresAt)||body.issuedAt>now||body.expiresAt<=now||body.expiresAt-body.issuedAt>max||body.environment&&body.environment!=='live')L.deny('INVALID_LIVE_APPROVAL_WINDOW');
 if(body.kind==='paystack-ng-live-writer-v1'&&(body.phase2aWriters!==0||body.unknownWriters!==0||body.mode!=='legacy_verified'))L.deny('LIVE_WRITER_ROSTER_UNSAFE');
 const payload=JSON.stringify(body);return {payload,signature:crypto.sign(null,Buffer.from(payload),key).toString('base64')};
}
if(require.main===module){
 try{const [command,kind,file]=process.argv.slice(2);if(process.argv.length!==5)L.deny('EXPLICIT_LIVE_COMMAND_REQUIRED');
  if(command==='draft')console.log(JSON.stringify(draft(kind,JSON.parse(fs.readFileSync(file,'utf8')))));
  else if(command==='sign-reviewed')console.log(JSON.stringify(signReviewed(JSON.parse(fs.readFileSync(kind,'utf8')),crypto.createPrivateKey(readExternal(file)))));
  else L.deny('EXPLICIT_LIVE_COMMAND_REQUIRED');
 }catch{console.error('Live approval command refused; details suppressed.');process.exitCode=1;}
}
module.exports={draft,signReviewed};
