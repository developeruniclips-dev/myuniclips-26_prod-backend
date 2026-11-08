'use strict';
// Execute the actual CLI in a VM with inert files, driver, HTTP and DB modules.
// No startup call below can reach the filesystem, network, database or provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const script=path.resolve(__dirname,'../src/sandbox/start.cjs'),source=fs.readFileSync(script,'utf8');
const canary='SENSITIVE_PASSWORD_PEM_SQL_URL_ENV_STACK_CANARY';
const fault=code=>Object.assign(new Error(canary),{code,stack:canary,sql:canary,password:canary,stage:canary,toJSON(){throw Error('RAW_ERROR_SERIALIZED');}});
async function run({at,code='EACCES',error,patch={},file={},receiverCleanup,poolCleanup,asModule=false}={}){
 const calls=[],errors=[],logs=[],signals={};let poolClosed=0,receiverClosed=0,listened=0,serverClosed=0;
 const trip=stage=>{calls.push(stage);if(stage===at)throw error===undefined?fault(code):error;};
 const environment={SANDBOX_APPROVAL_MODE:'single-owner-v1',UNICLIPS_SANDBOX:'paystack-test-v1',NODE_ENV:'test',DB_NAME:'uniclipspsngsandbox',DB_USER:'psngsandboxapp',DB_HOST:'db.example.invalid',DB_PASS:canary,DB_SSL:'true',DB_SSL_CA:'inert-ca',PAYMENT_ARCHITECTURE:'legacy_verified',FRONTEND_URL:'https://sandbox.example.invalid',ALLOWED_ORIGINS:'https://sandbox.example.invalid',JWT_SECRET:canary,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY:'inert-public-key',...patch};
 const pool={query:async()=>{trip('manifest');return[[{subject_id:401,scholar_id:301,buyer_id:302,seed_digest:'synthetic'}]];},end:async()=>{poolClosed++;if(poolCleanup)throw fault(poolCleanup);}};
 const receiver={status:()=>({}),close:()=>{receiverClosed++;if(receiverCleanup)throw fault(receiverCleanup);}};
 const server={once:(name,callback)=>{assert.equal(name,'error');if(at==='listen')queueMicrotask(()=>callback(error===undefined?fault(code):error));},close:callback=>{serverClosed++;callback();}};
 const app={listen:(port,callback)=>{listened++;calls.push('listen');if(at!=='listen')queueMicrotask(callback);return server;}};
 const mocks={
  'node:fs':{lstatSync:()=>{trip('public-key-stat');return{isFile:()=>file.regular!==false,isSymbolicLink:()=>file.symlink===true,size:file.size||100};},readFileSync:()=>{trip('public-key-read');return canary;}},
  './isolation':{settings:env=>{trip('settings');return require('../src/sandbox/isolation').settings(env);},identity:()=>{trip('source-identity');return{};},fail:code=>{throw fault(code);}},
  './ownerPolicy':{ownerKey:()=>trip('public-key-validation')},
  './database':{createSandboxPool:()=>{trip('pool-configuration');return pool;}},
  'mysql2/promise':{createPool:()=>{throw Error('REAL_DRIVER_FORBIDDEN');}},
  './bootstrap':{metadata:async()=>{trip('metadata');return{};}},
  './approvals':{createApprovalReceiver:()=>{trip('approval-receiver');return receiver;}},
  './app':{createSandboxApp:()=>{trip('application');return app;}}
 };
 const mod={exports:{}},req=id=>{assert(Object.hasOwn(mocks,id),'Unexpected real module: '+id);return mocks[id];};
 req.cache={};req.resolve=id=>{assert.equal(id,'../config/db');return'inert-config-db';};req.main=asModule?{}:mod;
 const proc={env:environment,exitCode:0,once:(name,callback)=>{signals[name]=callback;}};
 vm.runInNewContext(source,{require:req,module:mod,process:proc,console:{log:v=>logs.push(v),error:v=>errors.push(v)}},{filename:script});
 let result,rejected;
 if(asModule){try{result=await mod.exports.start(environment);}catch(e){rejected=e;}}
 await new Promise(resolve=>setImmediate(resolve));
 const output=errors.join('\n');assert(!output.includes(canary),'Sensitive exception or environment leaked');
 const diagnostics=errors.map(JSON.parse);
 for(const d of diagnostics){assert.equal(d.event,'SANDBOX_STARTUP_FAILED');assert(Object.keys(d).every(k=>['event','stage','code','receiverCleanupCode','poolCleanupCode'].includes(k)));}
 return{diagnostics,logs,calls,poolClosed,receiverClosed,listened,serverClosed,signals,exitCode:proc.exitCode,result,rejected,receiver};
}
for(const [stage,code]of [
 ['settings','SANDBOX_ISOLATION_REQUIRED'],['public-key-stat','ENOENT'],['public-key-read','EACCES'],
 ['public-key-validation','SANDBOX_OWNER_ED25519_REQUIRED'],['pool-configuration','DB_TLS_CA_UNREADABLE'],
 ['pool-configuration','DB_TLS_CA_INVALID'],['pool-configuration','ERR_DLOPEN_FAILED'],
 ['metadata','ECONNREFUSED'],['metadata','ETIMEDOUT'],['metadata','ERR_TLS_CERT_ALTNAME_INVALID'],
 ['metadata','ER_ACCESS_DENIED_ERROR'],['metadata','SANDBOX_DATABASE_GRANTS_UNSAFE'],
 ['metadata','SANDBOX_DATABASE_IDENTITY_MISMATCH'],['metadata','SANDBOX_MANIFEST_REQUIRED'],
 ['manifest','ER_NO_SUCH_TABLE'],['source-identity','SANDBOX_RENDER_IDENTITY_REQUIRED'],
 ['source-identity','SANDBOX_SOURCE_SYMLINK'],['approval-receiver','SCHEMA_VERIFICATION_REQUIRED'],
 ['approval-receiver','ENOSPC'],['application','MODULE_NOT_FOUND'],['listen','EADDRINUSE']
])test('fixed startup diagnostic: '+stage+' / '+code,async()=>{
 const r=await run({at:stage,code});assert.equal(r.exitCode,1);assert.deepEqual(r.diagnostics,[{event:'SANDBOX_STARTUP_FAILED',stage,code}]);
 const hasPool=['metadata','manifest','source-identity','approval-receiver','application','listen'].includes(stage);
 assert.equal(r.poolClosed,hasPool?1:0);assert.equal(r.receiverClosed,['application','listen'].includes(stage)?1:0);
 assert.equal(r.calls.at(-1),stage);assert.equal(Object.keys(r.signals).length,0);
});
for(const [stage,patch,code]of [
 ['settings',{NODE_ENV:'production'},'SANDBOX_ISOLATION_REQUIRED'],
 ['settings',{DB_NAME:'other_schema'},'SANDBOX_ISOLATION_REQUIRED'],
 ['settings',{SANDBOX_APPROVAL_MODE:'dual-review'},'SANDBOX_OWNER_MODE_REQUIRED'],
 ['settings',{STRIPE_SECRET_KEY:canary},'SANDBOX_EXTERNAL_CREDENTIAL_FORBIDDEN'],
 ['settings',{PAYSTACK_NG_LIVE_CHECKOUT:'enabled'},'PAYSTACK_LIVE_NOT_SUPPORTED'],
 ['runtime-user',{DB_USER:'psngsandboxmigrator'},'SANDBOX_RUNTIME_USER_REQUIRED'],
 ['session-secret',{JWT_SECRET:'short'},'SANDBOX_SESSION_SECRET_REQUIRED']
])test('existing check still refuses: '+code+' / '+Object.keys(patch)[0],async()=>{
 const r=await run({patch});assert.equal(r.exitCode,1);assert.equal(r.diagnostics[0].stage,stage);assert.equal(r.diagnostics[0].code,code);assert.equal(r.poolClosed,0);assert.equal(r.listened,0);
});
for(const [file,code]of [[{regular:false},'SANDBOX_APPROVAL_FILE_NOT_REGULAR'],[{symlink:true},'SANDBOX_APPROVAL_FILE_SYMLINK'],[{size:262145},'SANDBOX_APPROVAL_FILE_TOO_LARGE']])test('public-key file constraints remain fail closed: '+JSON.stringify(file),async()=>{
 const r=await run({file});assert.equal(r.diagnostics[0].stage,'public-key-stat');assert.equal(r.diagnostics[0].code,code);assert(!r.calls.includes('public-key-read'));assert.equal(r.listened,0);
});
for(const error of [fault(canary),canary,null,undefined,{code:'EACCES '+canary},{message:'EACCES',stack:canary},{code:{toJSON(){throw Error('RAW_CODE_SERIALIZED');}},message:canary}])test('unknown/primitive errors and raw details are suppressed: '+typeof error,async()=>{
 const r=await run({at:'metadata',code:canary,error});assert.equal(r.diagnostics[0].code,'UNEXPECTED_ERROR');assert.equal(r.diagnostics[0].stage,'metadata');assert.equal(r.exitCode,1);
});
test('both cleanup failures retain primary code/stage and expose only allowlisted cleanup codes',async()=>{
 const r=await run({at:'listen',code:'EADDRINUSE',receiverCleanup:'EACCES',poolCleanup:'ECONNRESET'});
 assert.deepEqual(r.diagnostics,[{event:'SANDBOX_STARTUP_FAILED',stage:'listen',code:'EADDRINUSE',receiverCleanupCode:'EACCES',poolCleanupCode:'ECONNRESET'}]);assert.equal(r.receiverClosed,1);assert.equal(r.poolClosed,1);
});
test('unknown cleanup codes do not leak and cannot replace original failure',async()=>{
 const r=await run({at:'application',code:'MODULE_NOT_FOUND',receiverCleanup:canary,poolCleanup:canary});
 assert.equal(r.diagnostics[0].code,'MODULE_NOT_FOUND');assert.equal(r.diagnostics[0].stage,'application');assert.equal(r.diagnostics[0].receiverCleanupCode,'UNEXPECTED_ERROR');assert.equal(r.diagnostics[0].poolCleanupCode,'UNEXPECTED_ERROR');
});
test('successful inert CLI keeps readiness message and graceful shutdown handlers',async()=>{
 const r=await run();assert.equal(r.exitCode,0);assert.deepEqual(r.diagnostics,[]);assert.deepEqual(r.logs,['Synthetic Paystack sandbox ready; signed approvals required']);assert.equal(r.poolClosed,0);assert.deepEqual(Object.keys(r.signals),['SIGTERM','SIGINT']);
});
test('exported start retains success/close interface and synthetic scope',async()=>{
 const r=await run({asModule:true});assert.equal(r.rejected,undefined);assert.deepEqual(Object.keys(r.result),['app','server','pool','receiver','close']);assert.equal(r.receiver.status().syntheticScope.subjectId,401);await r.result.close();await r.result.close();
});
test('exported start rejection is also sanitized and contains no raw cause',async()=>{
 const r=await run({asModule:true,at:'metadata',code:'ER_ACCESS_DENIED_ERROR'});assert.equal(r.rejected.code,'ER_ACCESS_DENIED_ERROR');assert.equal(r.rejected.stage,'metadata');assert.equal(r.rejected.message,'Sandbox startup refused');assert.equal(r.rejected.cause,undefined);assert(!JSON.stringify(r.rejected).includes(canary));
});
