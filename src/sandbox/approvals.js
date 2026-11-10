'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {fail}=require('./isolation');
const {configuration,digest}=require('../services/paystackNigeria/transportConfig');
const {createWriterPolicy}=require('../services/coursePayments/writerPolicy');
function decode(envelope,key,max=32768){
  if(typeof envelope?.payload!=='string'||Buffer.byteLength(envelope.payload)>max||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature||'')||
      !crypto.verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64')))fail('SANDBOX_SIGNATURE_REQUIRED');
  return JSON.parse(envelope.payload);
}
function createApprovalReceiver({env,identity,publicKey,reviewerKey,metadata,now=Date.now,parent=os.tmpdir()}={}){
  const owner=require('./ownerPolicy');require('./isolation').settings(env);owner.ownerKey(publicKey);
  if(reviewerKey!==undefined)fail('SANDBOX_LEGACY_REVIEW_REJECTED');
  require('../services/paystackNigeria/compatibility').requireSchema(metadata);
  const directory=fs.mkdtempSync(path.join(parent,'uniclips-sandbox-'));fs.chmodSync(directory,0o700);
  const challenge=crypto.randomBytes(32).toString('hex');let sequence=0,authorizationDigest=null,lastWriterTime=-1;
  const files={authorization:path.join(directory,'authorization.json'),writer:path.join(directory,'writer.json'),metadata:path.join(directory,'metadata.json')};
  function write(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
  write(files.metadata,metadata);
  Object.assign(env,{PAYSTACK_NG_SERVICE:identity.service,PAYSTACK_NG_GENERATION:identity.generation,PAYSTACK_NG_SOURCE:identity.source,
    PAYSTACK_NG_AUTHORIZATION:files.authorization,PAYSTACK_NG_WRITER_ATTESTATION:files.writer,PAYSTACK_NG_SCHEMA_METADATA:files.metadata});
  function bound(p,kind){
    owner.approval(p);
    if(p.kind!==kind||p.version!==1||p.challenge!==challenge||
       ['service','generation','source','instance'].some(k=>p.identity?.[k]!==identity[k])||
       !Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now()||p.expiresAt<=now()||
       p.expiresAt-p.issuedAt>300000)fail('SANDBOX_PACKET_EXPIRED_OR_MISMATCHED');
  }
  function install(envelope){
    const p=decode(envelope,publicKey,65536);bound(p,'sandbox-owner-approvals-v1');
    if(!Number.isSafeInteger(p.sequence)||p.sequence<=sequence)fail('SANDBOX_PACKET_REPLAY');
    if(p.authorization?.payload===p.writer?.payload||p.authorization?.signature===p.writer?.signature)fail('SANDBOX_DUPLICATE_APPROVAL');
    const a=owner.approval(JSON.parse(p.authorization?.payload||'null'));
    const cfg=configuration({env,secret:env.PAYSTACK_NG_SECRET_KEY,webhookSecret:env.PAYSTACK_NG_WEBHOOK_SECRET,publicKey,authorization:p.authorization,identity,now});
    if(!cfg.enabled||a.schemaDigest!==require('../services/paystackNigeria/runtime').schemaDigest()||a.metadataDigest!==digest(JSON.stringify(metadata)))fail('PAYSTACK_SCHEMA_APPROVAL_REQUIRED');
    owner.approval(JSON.parse(p.writer?.payload||'null'));
    createWriterPolicy({publicKey,identity,readAttestation:()=>p.writer,mode:()=>env.PAYMENT_ARCHITECTURE,now}).assertSafe();
    const writerTime=JSON.parse(p.writer.payload).issuedAt;if(writerTime<lastWriterTime)fail('SANDBOX_WRITER_REPLAY');
    const authDigest=digest(JSON.stringify(p.authorization));
    if(authorizationDigest&&authorizationDigest!==authDigest)fail('SANDBOX_AUTHORIZATION_RESTART_REQUIRED');
    // Synchronous atomic replacements: no async work can observe half a packet.
    if(!authorizationDigest)write(files.authorization,p.authorization);
    write(files.writer,p.writer);authorizationDigest=authDigest;sequence=p.sequence;lastWriterTime=writerTime;
    Object.assign(env,{PAYSTACK_NG_SERVICE:identity.service,PAYSTACK_NG_GENERATION:identity.generation,PAYSTACK_NG_SOURCE:identity.source,
      PAYSTACK_NG_AUTHORIZATION:files.authorization,PAYSTACK_NG_WRITER_ATTESTATION:files.writer,PAYSTACK_NG_SCHEMA_METADATA:files.metadata});
    return {accepted:true,sequence,expiresAt:JSON.parse(p.writer.payload).expiresAt,approvalMode:owner.MODE,evidenceDigest:p.evidenceDigest,approvalDigest:digest(JSON.stringify(envelope))};
  }
  function zeroAuthorization(envelope){
    const p=decode(envelope,publicKey,65536);bound(p,'sandbox-owner-zero-v1');
    if(!authorizationDigest)fail('SANDBOX_ACTIVATION_APPROVAL_REQUIRED');
    const config=configuration({env,secret:env.PAYSTACK_NG_SECRET_KEY,webhookSecret:env.PAYSTACK_NG_WEBHOOK_SECRET,publicKey,authorization:JSON.parse(fs.readFileSync(files.authorization,'utf8')),identity,now});
    if(!config.enabled)fail('SANDBOX_ACTIVATION_APPROVAL_REQUIRED');
    createWriterPolicy({publicKey,identity,readAttestation:()=>JSON.parse(fs.readFileSync(files.writer,'utf8')),mode:()=>env.PAYMENT_ARCHITECTURE,now}).assertSafe();
    return p;
  }
  return {install,zeroAuthorization,
    status:()=>({approvalMode:owner.MODE,identity,challenge,sequence,schemaDigest:require('../services/paystackNigeria/runtime').schemaDigest(),metadataDigest:digest(JSON.stringify(metadata))}),
    close(){fs.rmSync(directory,{recursive:true,force:true});},files};
}
module.exports={decode,createApprovalReceiver};
