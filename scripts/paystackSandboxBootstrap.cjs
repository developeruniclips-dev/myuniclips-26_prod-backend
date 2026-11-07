'use strict';
// Preview by default. The explicit operator path accepts reviewed synthetic
// inputs on stdin; never imports production env files or creates a database/user.
const fs=require('node:fs'),B=require('../src/sandbox/bootstrap');
async function main(){
 if(process.argv.length===2){console.log('-- Preview only: empty isolated test database required. No connection.');console.log(B.statements.join(';\n')+';');return;}
 if(process.argv.length===3&&process.argv[2]==='--prepare-synthetic-seed'){
  const i=JSON.parse(fs.readFileSync(0,'utf8')),security=require('../src/utils/authSecurity');
  if([i.buyerPassword,i.scholarPassword].some(p=>typeof p!=='string'||security.passwordErrors(p).length))throw Error('STRONG_SYNTHETIC_PASSWORD_REQUIRED');
  const {hashPassword}=require('../src/utils/passwordHasher');
  const seed={seedId:require('node:crypto').randomUUID(),merchantAccount:i.merchantAccount,buyerEmail:await security.normalizeEmail(i.buyerEmail),scholarEmail:await security.normalizeEmail(i.scholarEmail),buyerHash:await hashPassword(i.buyerPassword),scholarHash:await hashPassword(i.scholarPassword)};
  B.validateSeed(seed);console.log(JSON.stringify({seed,seedDigest:require('../src/services/paystackNigeria/transportConfig').digest(JSON.stringify(seed)),schemaDigest:B.schemaDigest(),source:require('../src/sandbox/isolation').sourceDigest()}));return;
 }
 if(process.argv.length!==3||process.argv[2]!=='--execute-authorized-sandbox')throw Error('EXPLICIT_AUTHORIZATION_REQUIRED');
 const env=process.env;if(env.DB_USER!=='psngsandboxmigrator')throw Error('MIGRATOR_REQUIRED');
 const input=JSON.parse(fs.readFileSync(0,'utf8'));
 const pool=require('../src/sandbox/database').createSandboxPool({env,createPool:require('mysql2/promise').createPool,requireMarker:false});
 try{const out=await B.bootstrap({pool,seed:input.seed,envelope:input.authorization,review:input.independentReview,publicKey:fs.readFileSync(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY),reviewerKey:fs.readFileSync(env.SANDBOX_REVIEWER_PUBLIC_KEY),source:require('../src/sandbox/isolation').sourceDigest()});const metadata=await B.metadata(pool);console.log(JSON.stringify({...out,metadata,metadataDigest:require('../src/services/paystackNigeria/transportConfig').digest(JSON.stringify(metadata))}));}
 finally{await pool.end();}
}
if(require.main===module)main().catch(()=>{console.error('Synthetic bootstrap refused or incomplete; inspect the owned test schema before any retry.');process.exitCode=1;});
module.exports={main};
