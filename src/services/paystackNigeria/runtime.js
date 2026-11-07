'use strict';
// No activation from a flag alone. Live operation is unsupported by code/schema.
const fs=require('node:fs'),{configuration,digest,fail}=require('./transportConfig');
function document(file,max=262144){if(!file)fail('PAYSTACK_SIGNED_CONFIGURATION_REQUIRED');const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)fail('PAYSTACK_SIGNED_CONFIGURATION_REQUIRED');return fs.readFileSync(file,'utf8');}
function schemaDigest(){return digest(JSON.stringify([...require('./schema').statements,...require('../coursePayments/schema').statements,...require('./transportSchema').statements]));}
let cached;
function paymentRuntime(){
 if(cached)return cached;
 const env=process.env;
 if(!['TEST_CHECKOUT','VERIFICATION','WEBHOOKS'].some(k=>env['PAYSTACK_NG_'+k]==='enabled')){
  if(env.PAYSTACK_NG_LIVE_CHECKOUT&&env.PAYSTACK_NG_LIVE_CHECKOUT!=='disabled')fail('PAYSTACK_LIVE_NOT_SUPPORTED');return {enabled:false};
 }
 try{
  const identity={service:env.PAYSTACK_NG_SERVICE,generation:env.PAYSTACK_NG_GENERATION,source:env.PAYSTACK_NG_SOURCE};
  const publicKey=document(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY,8192),authorization=JSON.parse(document(env.PAYSTACK_NG_AUTHORIZATION,32768));
  const config=configuration({env,secret:env.PAYSTACK_NG_SECRET_KEY,webhookSecret:env.PAYSTACK_NG_WEBHOOK_SECRET,publicKey,authorization,identity});
  if(config.schemaDigest!==schemaDigest())fail('PAYSTACK_SCHEMA_APPROVAL_REQUIRED');
  const schemaMetadata=JSON.parse(document(env.PAYSTACK_NG_SCHEMA_METADATA));
  const metadataDigest=digest(JSON.stringify(schemaMetadata));if(JSON.parse(authorization.payload).metadataDigest!==metadataDigest)fail('PAYSTACK_SCHEMA_APPROVAL_REQUIRED');
  const writerPolicy=require('../coursePayments/writerPolicy').createWriterPolicy({publicKey,identity,mode:()=>env.PAYMENT_ARCHITECTURE||'legacy_verified',readAttestation:()=>JSON.parse(document(env.PAYSTACK_NG_WRITER_ATTESTATION,16384))});
  const {pool}=require('../../config/db');
  const ledgerStore=require('./store').createMysqlStore({pool,schemaMetadata,resolveHistoricalSales:require('../coursePayments/historicalResolver').resolveHistoricalSales});
  cached=require('./checkoutService').createCheckoutService({config,pool,ledgerStore,writerPolicy});return cached;
 }catch(e){if(e.status)throw e;fail('PAYSTACK_CONFIGURATION_UNVERIFIED');}
}
module.exports={paymentRuntime,schemaDigest};
