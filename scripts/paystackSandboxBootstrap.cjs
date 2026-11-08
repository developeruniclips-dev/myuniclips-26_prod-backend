'use strict';
// Preview by default. The explicit operator path accepts reviewed synthetic
// inputs on stdin; never imports production env files or creates a database/user.
const fs=require('node:fs'),B=require('../src/sandbox/bootstrap');
let stage='arguments',cleanupCode;
// Fixed codes only: never emit message, stack, SQL, paths, input or configuration.
const safeCodes=new Set((
 'EXPLICIT_AUTHORIZATION_REQUIRED MIGRATOR_REQUIRED SINGLE_OWNER_INPUT_REQUIRED STRONG_SYNTHETIC_PASSWORD_REQUIRED '+
 'SANDBOX_OWNER_MODE_REQUIRED SANDBOX_ISOLATION_REQUIRED SANDBOX_EXTERNAL_CREDENTIAL_FORBIDDEN SANDBOX_FRONTEND_REQUIRED SANDBOX_SOURCE_SYMLINK PAYSTACK_LIVE_NOT_SUPPORTED '+
 'SANDBOX_OWNER_ED25519_REQUIRED SANDBOX_OWNER_APPROVAL_REQUIRED SANDBOX_LEGACY_REVIEW_REJECTED SANDBOX_SIGNATURE_REQUIRED SANDBOX_SEED_INVALID SANDBOX_PASSWORD_HASH_REQUIRED SANDBOX_BOOTSTRAP_APPROVAL_REQUIRED SANDBOX_BOOTSTRAP_EMPTY_DATABASE_REQUIRED SANDBOX_DATABASE_IDENTITY_MISMATCH SANDBOX_DATABASE_GRANTS_UNSAFE SANDBOX_BOOTSTRAP_UNCERTAIN '+
 'DB_SSL_INVALID DB_TLS_REQUIRED DB_TLS_HOSTNAME_REQUIRED DB_TLS_CA_REQUIRED DB_TLS_CA_UNREADABLE DB_TLS_CA_INVALID '+
 'ENOENT EISDIR EACCES EPERM ENOTDIR MODULE_NOT_FOUND ERR_INVALID_URL ERR_INVALID_ARG_TYPE ERR_OSSL_UNSUPPORTED ERR_TLS_CERT_ALTNAME_INVALID CERT_HAS_EXPIRED SELF_SIGNED_CERT_IN_CHAIN DEPTH_ZERO_SELF_SIGNED_CERT UNABLE_TO_VERIFY_LEAF_SIGNATURE UNABLE_TO_GET_ISSUER_CERT_LOCALLY '+
 'ECONNREFUSED ECONNRESET ETIMEDOUT ENOTFOUND EAI_AGAIN PROTOCOL_CONNECTION_LOST PROTOCOL_SEQUENCE_TIMEOUT HANDSHAKE_SSL_ERROR '+
 'ER_ACCESS_DENIED_ERROR ER_DBACCESS_DENIED_ERROR ER_TABLEACCESS_DENIED_ERROR ER_SPECIFIC_ACCESS_DENIED_ERROR ER_BAD_DB_ERROR ER_CON_COUNT_ERROR ER_USER_LIMIT_REACHED ER_TOO_MANY_USER_CONNECTIONS '+
 'ER_TABLE_EXISTS_ERROR ER_CANT_CREATE_TABLE ER_FK_CANNOT_OPEN_PARENT ER_DUP_KEYNAME ER_COLUMN_CHECK_CONSTRAINT_REFERENCES_OTHER_COLUMN ER_CHECK_CONSTRAINT_VIOLATED ER_DUP_ENTRY ER_PARSE_ERROR ER_BAD_FIELD_ERROR ER_NO_REFERENCED_ROW_2 ER_ROW_IS_REFERENCED_2 ER_NO_SUCH_TABLE ER_LOCK_DEADLOCK ER_LOCK_WAIT_TIMEOUT'
).split(' '));
function safeCode(error){
 if(safeCodes.has(error?.code))return error.code;
 if(safeCodes.has(error?.message))return error.message;
 return error instanceof SyntaxError?'INVALID_JSON_OR_SYNTAX':'UNEXPECTED_ERROR';
}
async function main(){
 stage='arguments';cleanupCode=undefined;
 if(process.argv.length===2){console.log('-- Preview only: empty isolated test database required. No connection.');console.log(B.statements.join(';\n')+';');return;}
 if(process.argv.length===3&&process.argv[2]==='--prepare-synthetic-seed'){
  stage='seed-preparation';
  const i=JSON.parse(fs.readFileSync(0,'utf8')),security=require('../src/utils/authSecurity');
  if([i.buyerPassword,i.scholarPassword].some(p=>typeof p!=='string'||security.passwordErrors(p).length))throw Error('STRONG_SYNTHETIC_PASSWORD_REQUIRED');
  const {hashPassword}=require('../src/utils/passwordHasher');
  const seed={seedId:require('node:crypto').randomUUID(),merchantAccount:i.merchantAccount,buyerEmail:await security.normalizeEmail(i.buyerEmail),scholarEmail:await security.normalizeEmail(i.scholarEmail),buyerHash:await hashPassword(i.buyerPassword),scholarHash:await hashPassword(i.scholarPassword)};
  B.validateSeed(seed);console.log(JSON.stringify({seed,seedDigest:require('../src/services/paystackNigeria/transportConfig').digest(JSON.stringify(seed)),schemaDigest:B.schemaDigest(),source:require('../src/sandbox/isolation').sourceDigest()}));return;
 }
 if(process.argv.length!==3||process.argv[2]!=='--execute-authorized-sandbox')throw Error('EXPLICIT_AUTHORIZATION_REQUIRED');
 const env=process.env;if(env.DB_USER!=='psngsandboxmigrator')throw Error('MIGRATOR_REQUIRED');
 stage='input-read';const raw=fs.readFileSync(0,'utf8');
 stage='input-parse';const input=JSON.parse(raw);
 if(Object.keys(input).sort().join(',')!=='authorization,seed')throw Error('SINGLE_OWNER_INPUT_REQUIRED');
 stage='pool-configuration';
 const pool=require('../src/sandbox/database').createSandboxPool({env,createPool:require('mysql2/promise').createPool,requireMarker:false});
 let failed=false;
 try{
  stage='public-key-read';const publicKey=fs.readFileSync(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY);
  stage='source-identity';const source=require('../src/sandbox/isolation').sourceDigest();
  stage='bootstrap';const out=await B.bootstrap({pool,seed:input.seed,envelope:input.authorization,publicKey,source});
  stage='metadata';const metadata=await B.metadata(pool);
  stage='result-output';console.log(JSON.stringify({...out,approvalMode:'single-owner-v1',approvalDigest:require('../src/services/paystackNigeria/transportConfig').digest(JSON.stringify(input.authorization)),metadata,metadataDigest:require('../src/services/paystackNigeria/transportConfig').digest(JSON.stringify(metadata))}));
 }catch(error){failed=true;throw error;}
 finally{try{await pool.end();}catch(error){if(!failed){stage='pool-close';throw error;}cleanupCode=safeCode(error);}}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({event:'SANDBOX_BOOTSTRAP_FAILED',stage,code:safeCode(error),...(cleanupCode?{cleanupCode}:{}),instruction:'Inspect the owned test schema before any retry.'}));process.exitCode=1;});
module.exports={main};
