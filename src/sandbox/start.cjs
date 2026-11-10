'use strict';
// Explicit separate start command: node src/sandbox/start.cjs. No dotenv import,
// no production startup, migrations, embedded credentials or Stripe SDK.
const fs=require('node:fs');
// Fixed diagnostic vocabulary only. Never serialize an exception or its message.
const stages=new Set(('settings runtime-user session-secret public-key-delivery public-key-stat public-key-read public-key-validation pool-configuration metadata manifest source-identity approval-receiver application listen').split(' '));
const codes=new Set((
 'SANDBOX_OWNER_MODE_REQUIRED SANDBOX_ISOLATION_REQUIRED SANDBOX_EXTERNAL_CREDENTIAL_FORBIDDEN PAYSTACK_LIVE_NOT_SUPPORTED SANDBOX_FRONTEND_REQUIRED '+
 'SANDBOX_RUNTIME_USER_REQUIRED SANDBOX_SESSION_SECRET_REQUIRED SANDBOX_APPROVAL_FILE_INVALID SANDBOX_APPROVAL_FILE_SYMLINK SANDBOX_APPROVAL_FILE_NOT_REGULAR SANDBOX_APPROVAL_FILE_TOO_LARGE SANDBOX_OWNER_ED25519_REQUIRED '+
 'SANDBOX_DATABASE_IDENTITY_MISMATCH SANDBOX_DATABASE_GRANTS_UNSAFE SANDBOX_MANIFEST_REQUIRED SANDBOX_SOURCE_SYMLINK SANDBOX_RENDER_IDENTITY_REQUIRED SANDBOX_LEGACY_REVIEW_REJECTED SCHEMA_VERIFICATION_REQUIRED '+
 'DB_SSL_INVALID DB_TLS_REQUIRED DB_TLS_HOSTNAME_REQUIRED DB_TLS_CA_REQUIRED DB_TLS_CA_UNREADABLE DB_TLS_CA_INVALID '+
 'SANDBOX_KEY_DIRECTORY_UNSAFE SANDBOX_KEY_PUBLIC_PEM_REQUIRED SANDBOX_KEY_ED25519_REQUIRED SANDBOX_KEY_DELIVERY_SCOPE_REQUIRED SANDBOX_KEY_NOFOLLOW_REQUIRED SANDBOX_KEY_DESTINATION_UNSAFE SANDBOX_KEY_DESTINATION_CHANGED '+
 'SANDBOX_KEY_TEMP_DIRECTORY_WRITABLE SANDBOX_KEY_PUBLIC_ENV_REQUIRED SANDBOX_KEY_FINGERPRINT_REQUIRED SANDBOX_KEY_FINGERPRINT_MISMATCH '+
 'ENOENT EISDIR EACCES EPERM EEXIST ELOOP ENOTDIR ENOSPC EMFILE MODULE_NOT_FOUND ERR_DLOPEN_FAILED ERR_INVALID_URL ERR_INVALID_ARG_TYPE ERR_OSSL_UNSUPPORTED '+
 'ERR_TLS_CERT_ALTNAME_INVALID CERT_HAS_EXPIRED SELF_SIGNED_CERT_IN_CHAIN DEPTH_ZERO_SELF_SIGNED_CERT UNABLE_TO_VERIFY_LEAF_SIGNATURE UNABLE_TO_GET_ISSUER_CERT_LOCALLY '+
 'ECONNREFUSED ECONNRESET ETIMEDOUT ENOTFOUND EAI_AGAIN PROTOCOL_CONNECTION_LOST PROTOCOL_SEQUENCE_TIMEOUT HANDSHAKE_SSL_ERROR '+
 'ER_ACCESS_DENIED_ERROR ER_DBACCESS_DENIED_ERROR ER_TABLEACCESS_DENIED_ERROR ER_SPECIFIC_ACCESS_DENIED_ERROR ER_BAD_DB_ERROR ER_CON_COUNT_ERROR ER_USER_LIMIT_REACHED ER_TOO_MANY_USER_CONNECTIONS ER_NO_SUCH_TABLE ER_BAD_FIELD_ERROR ER_PARSE_ERROR ER_LOCK_DEADLOCK ER_LOCK_WAIT_TIMEOUT EADDRINUSE'
).split(' '));
const safeCode=error=>codes.has(error?.code)?error.code:'UNEXPECTED_ERROR';
async function start(env=process.env){
 let stage='settings',pool,receiver,server,delivered;
 try{
 const {settings,identity,fail}=require('./isolation');
 const isolated=settings(env);
 stage='runtime-user';if(env.DB_USER!=='psngsandboxapp')fail('SANDBOX_RUNTIME_USER_REQUIRED');
 stage='session-secret';
 if(typeof env.JWT_SECRET!=='string'||env.JWT_SECRET.length<32)fail('SANDBOX_SESSION_SECRET_REQUIRED');
 if(env.RENDER==='true'){
  stage='public-key-delivery';delivered=require('./publicKeyEnvironment').deliverRenderPublicKeyFromEnvironment(env);
  env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY=delivered.file;
  delete env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM;
 }
 const read=file=>{stage='public-key-stat';const st=fs.lstatSync(file);if(st.isSymbolicLink())fail('SANDBOX_APPROVAL_FILE_SYMLINK');if(!st.isFile())fail('SANDBOX_APPROVAL_FILE_NOT_REGULAR');if(st.size>262144)fail('SANDBOX_APPROVAL_FILE_TOO_LARGE');stage='public-key-read';return fs.readFileSync(file,'utf8');};
 delivered?.assertUnchanged();
 const publicKey=read(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY);
 delivered?.assertUnchanged(publicKey);
 stage='public-key-validation';
 require('./ownerPolicy').ownerKey(publicKey);
 stage='pool-configuration';
 pool=require('./database').createSandboxPool({env,createPool:require('mysql2/promise').createPool});
 stage='metadata';
  const metadata=await require('./bootstrap').metadata(pool);
 stage='manifest';
  const manifest=(await pool.query('SELECT * FROM sandbox_manifest WHERE singleton=1'))[0][0];
 stage='source-identity';
  const id=identity(env);
 stage='approval-receiver';
  receiver=require('./approvals').createApprovalReceiver({env,identity:id,publicKey,metadata});
  const status=receiver.status;receiver.status=()=>({...status(),syntheticScope:{subjectId:manifest.subject_id,scholarId:manifest.scholar_id,buyerId:manifest.buyer_id,seedDigest:manifest.seed_digest}});
  // Inject only into this dedicated process before auth/payment composition.
 stage='application';
  const file=require.resolve('../config/db');require.cache[file]={id:file,filename:file,loaded:true,exports:{pool,initializeDatabase:async()=>undefined}};
  const app=require('./app').createSandboxApp({pool,receiver,publicKey,origin:isolated.origin});
 stage='listen';
  server=await new Promise((resolve,reject)=>{const s=app.listen(env.PORT||3001,()=>resolve(s));s.once('error',reject);});
  let closing=false;const close=async()=>{if(closing)return;closing=true;await new Promise(r=>server.close(r));await pool.end();receiver.close();delivered?.cleanup();};
  process.once('SIGTERM',()=>{close().catch(()=>{process.exitCode=1;});});process.once('SIGINT',()=>{close().catch(()=>{process.exitCode=1;});});
  return {app,server,pool,receiver,close};
 }catch(error){
  const diagnostic={stage,code:safeCode(error)};
  // Cleanup must not replace the original failure; attempt both resources.
  try{receiver?.close();}catch(e){diagnostic.receiverCleanupCode=safeCode(e);}
  try{await pool?.end();}catch(e){diagnostic.poolCleanupCode=safeCode(e);}
  try{delivered?.cleanup();}catch(e){diagnostic.keyCleanupCode=safeCode(e);}
  throw Object.assign(new Error('Sandbox startup refused'),diagnostic);
 }
}
if(require.main===module)start().then(()=>console.log('Synthetic Paystack sandbox ready; signed approvals required')).catch(error=>{
 console.error(JSON.stringify({event:'SANDBOX_STARTUP_FAILED',stage:stages.has(error?.stage)?error.stage:'unknown',code:safeCode(error),
  ...(error?.receiverCleanupCode?{receiverCleanupCode:safeCode({code:error.receiverCleanupCode})}:{}),
  ...(error?.keyCleanupCode?{keyCleanupCode:safeCode({code:error.keyCleanupCode})}:{}),
  ...(error?.poolCleanupCode?{poolCleanupCode:safeCode({code:error.poolCleanupCode})}:{})}));
 process.exitCode=1;
});
module.exports={start};
