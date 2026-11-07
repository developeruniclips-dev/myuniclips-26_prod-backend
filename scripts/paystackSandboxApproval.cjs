'use strict';
// Offline issuance only. No key generation, network, dotenv or provider client.
const fs=require('node:fs'),crypto=require('node:crypto');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function draft(kind,i,now=Date.now()){
 const c=i.challenge;
 const bound=type=>({kind:type,version:1,identity:c.identity,challenge:c.challenge,issuedAt:now,expiresAt:now+300000});
 if(kind==='bootstrap')return {kind:'sandbox-bootstrap-v1',host:i.host,database:'uniclipspsngsandbox',source:i.prepared.source,seedDigest:i.prepared.seedDigest,schemaDigest:i.prepared.schemaDigest,issuedAt:now,expiresAt:now+300000};
 if(kind==='authorization'){
  if(i.independentlyReviewed!==true||!c||!/^https:\/\//.test(i.callbackOrigin)||!/^[1-9]\d{0,19}$/.test(i.merchantAccount||''))throw Error('INDEPENDENT_REVIEW_REQUIRED');
  const external=file=>{const p=fs.realpathSync(file),root=require('node:path').resolve(__dirname,'../../..');if(p.toLowerCase().startsWith(root.toLowerCase()+require('node:path').sep))throw Error('SECRET_MUST_BE_EXTERNAL');return fs.readFileSync(p,'utf8').trim();};
  const secret=external(i.testSecretFile),webhook=external(i.webhookSecretFile);
  if(!/^sk_test_[A-Za-z0-9]{16,128}$/.test(secret)||!/^whsec_[A-Za-z0-9_-]{16,200}$/.test(webhook))throw Error('TEST_CREDENTIAL_CONTRACT_REQUIRED');
  return{kind:'authorization',value:{version:1,environment:'test',entity:'UNICLIPS_NIGERIA_LIMITED',merchantAccount:i.merchantAccount,...c.identity,issuedAt:now,expiresAt:now+86400000,credentialDigest:digest(secret),webhookCredentialDigest:digest(webhook),callbackOrigin:i.callbackOrigin,webhookScheme:'timestamped-v1',feesAbsorbed:true,noAutomaticSplits:true,controls:{TEST_CHECKOUT:true,VERIFICATION:true,WEBHOOKS:true},schemaDigest:c.schemaDigest,metadataDigest:c.metadataDigest}};
 }
 if(kind==='writer'){
  const points=require('../src/services/coursePayments/writerPolicy').ENTRY_POINTS;
  if(!Array.isArray(i.observations)||i.observations.length!==points.length||points.some(k=>i.observations.filter(o=>o.entryPoint===k&&o.conclusion==='legacy-only-or-absent'&&/^[a-f0-9]{64}$/.test(o.evidenceDigest||'')&&Number.isSafeInteger(o.checkedAt)&&o.checkedAt<=now&&now-o.checkedAt<300000).length!==1))throw Error('FRESH_INDEPENDENT_ROSTER_EVIDENCE_REQUIRED');
  return{kind:'writer',value:{version:1,mode:'legacy_verified',environment:'test',...c.identity,issuedAt:now,expiresAt:now+300000,phase2aWriters:0,unknownWriters:0,entryPoints:points,rosterEvidenceDigest:digest(JSON.stringify(i.observations))}};
 }
 if(kind==='packet')return{...bound('sandbox-approvals-v1'),sequence:c.sequence+1,authorization:i.authorization,writer:i.writer};
 if(kind==='zero-audit')return{kind:'audit',value:{subjectId:c.syntheticScope.subjectId,scholarId:c.syntheticScope.scholarId,reviewVersion:1,reviewId:crypto.randomUUID(),sourceRevision:c.syntheticScope.seedDigest,writerMode:'legacy_verified',facts:[]}};
 if(kind==='zero-review'){
  if(i.independentlyReviewed!==true)throw Error('INDEPENDENT_REVIEW_REQUIRED');
  return{...bound('sandbox-zero-review-v1'),seedDigest:c.syntheticScope.seedDigest,auditDigest:digest(JSON.stringify(i.audit))};
 }
 throw Error('UNKNOWN_DRAFT_KIND');
}
function signReviewed(payload,key){
 if(!payload||!['sandbox-bootstrap-v1','sandbox-approvals-v1','sandbox-zero-review-v1','authorization','writer','audit'].includes(payload.kind))throw Error('EXPLICIT_PACKET_KIND_REQUIRED');
 const body=payload.kind==='authorization'||payload.kind==='writer'||payload.kind==='audit'?payload.value:payload;
 if(body.environment==='live'||body.mode==='phase2a'||body.writerMode==='phase2a')throw Error('TEST_ONLY');
 if(payload.kind==='audit'&&(!Array.isArray(body.facts)||body.facts.length))throw Error('SYNTHETIC_ZERO_ONLY');
 if(payload.kind==='writer'&&(body.phase2aWriters!==0||body.unknownWriters!==0))throw Error('WRITER_ROSTER_UNSAFE');
 if(payload.kind!=='audit'){
  const max=payload.kind==='authorization'?86400000:300000;
  if(!Number.isSafeInteger(body.issuedAt)||!Number.isSafeInteger(body.expiresAt)||body.expiresAt<=Date.now()||body.issuedAt>Date.now()||body.expiresAt-body.issuedAt>max)throw Error('INVALID_APPROVAL_WINDOW');
 }
 const text=JSON.stringify(body);return {payload:text,signature:crypto.sign(null,Buffer.from(text),key).toString('base64')};
}
if(require.main===module){
 const [command,file,keyFile]=process.argv.slice(2);
 if(command==='draft'&&file&&keyFile&&process.argv.length===5){try{process.stdout.write(JSON.stringify(draft(file,JSON.parse(fs.readFileSync(keyFile,'utf8'))))+'\n');}catch{console.error('Approval draft refused');process.exitCode=1;}}
 else if(command!=='sign-reviewed'||!file||!keyFile||process.argv.length!==5){console.log('Offline only: draft <bootstrap|authorization|writer|packet|zero-audit|zero-review> <request.json>; sign-reviewed <reviewed-payload.json> <private-key-file-outside-repository>. No key is created.');process.exitCode=1;}
 else{try{const repo=require('node:path').resolve(__dirname,'../../..'),keyPath=fs.realpathSync(keyFile);if(keyPath.toLowerCase().startsWith(repo.toLowerCase()+require('node:path').sep))throw Error('KEY_MUST_BE_EXTERNAL');const key=crypto.createPrivateKey(fs.readFileSync(keyPath));if(key.asymmetricKeyType!=='ed25519')throw Error('ED25519_REQUIRED');process.stdout.write(JSON.stringify(signReviewed(JSON.parse(fs.readFileSync(file,'utf8')),key))+'\n');}catch{console.error('Approval signing refused');process.exitCode=1;}}
}
module.exports={signReviewed,draft};
