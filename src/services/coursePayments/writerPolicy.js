'use strict';
const {verify}=require('node:crypto');
const ENTRY_POINTS=Object.freeze(['checkout-confirmation','stripe-webhooks','admin-reconciliation','old-generations','workers']);
const denied=()=>Object.assign(new Error('Financial writer safety is not established'),{code:'WRITER_SAFETY_UNVERIFIED',status:503});
// An environment flag is never an attestation. The caller must independently
// establish, sign and supply the current writer roster. No runtime signer exists.
function createWriterPolicy({publicKey,readAttestation,identity,mode=()=>undefined,now=Date.now}={}){
 return {assertSafe(){
  try{
   if(mode()!=='legacy_verified'||!identity||!publicKey||typeof readAttestation!=='function')throw denied();
   const envelope=readAttestation();if(typeof envelope?.payload!=='string'||envelope.payload.length>8192||typeof envelope.signature!=='string'||!verify(null,Buffer.from(envelope.payload),publicKey,Buffer.from(envelope.signature,'base64')))throw denied();
   const a=JSON.parse(envelope.payload),clock=now();
   if(!Number.isSafeInteger(clock)||a.version!==1||a.mode!=='legacy_verified'||a.environment!=='test'||!Number.isSafeInteger(a.issuedAt)||!Number.isSafeInteger(a.expiresAt)||a.issuedAt>clock||a.expiresAt<=clock||a.expiresAt-a.issuedAt>300000||a.service!==identity.service||a.generation!==identity.generation||a.source!==identity.source||a.phase2aWriters!==0||a.unknownWriters!==0||!Array.isArray(a.entryPoints)||ENTRY_POINTS.some(k=>!a.entryPoints.includes(k)))throw denied();
   return Object.freeze({mode:a.mode,expiresAt:a.expiresAt,generation:a.generation});
  }catch{throw denied();}
 }};
}
module.exports={createWriterPolicy,ENTRY_POINTS};
