'use strict';
const {generateKeyPairSync,sign}=require('node:crypto');
const {createWriterPolicy,ENTRY_POINTS}=require('../../src/services/coursePayments/writerPolicy');
module.exports=function fixtureWriter({now=Date.now,patch={}}={}){
 const keys=generateKeyPairSync('ed25519'),identity={service:'synthetic',generation:'fixture',source:'offline'};
 const issuedAt=now();
 let payload=JSON.stringify({version:1,mode:'legacy_verified',environment:'test',issuedAt,expiresAt:issuedAt+300000,...identity,phase2aWriters:0,unknownWriters:0,entryPoints:ENTRY_POINTS,...patch});
 const envelope={payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64')};
 return createWriterPolicy({publicKey:keys.publicKey,readAttestation:()=>envelope,identity,mode:()=> 'legacy_verified',now});
};
