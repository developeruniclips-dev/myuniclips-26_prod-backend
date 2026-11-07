'use strict';
// Explicit separate start command: node src/sandbox/start.cjs. No dotenv import,
// no production startup, migrations, embedded credentials or Stripe SDK.
const fs=require('node:fs');
const {settings,identity,fail}=require('./isolation');
async function start(env=process.env){
 const isolated=settings(env);if(env.DB_USER!=='psngsandboxapp')fail('SANDBOX_RUNTIME_USER_REQUIRED');
 if(typeof env.JWT_SECRET!=='string'||env.JWT_SECRET.length<32)fail('SANDBOX_SESSION_SECRET_REQUIRED');
 const read=file=>{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>262144)fail('SANDBOX_APPROVAL_FILE_INVALID');return fs.readFileSync(file,'utf8');};
 const publicKey=read(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY);
 require('./ownerPolicy').ownerKey(publicKey);
 const pool=require('./database').createSandboxPool({env,createPool:require('mysql2/promise').createPool});
 let receiver,server;
 try{
  const metadata=await require('./bootstrap').metadata(pool);
  const manifest=(await pool.query('SELECT * FROM sandbox_manifest WHERE singleton=1'))[0][0];
  const id=identity(env);
  receiver=require('./approvals').createApprovalReceiver({env,identity:id,publicKey,metadata});
  const status=receiver.status;receiver.status=()=>({...status(),syntheticScope:{subjectId:manifest.subject_id,scholarId:manifest.scholar_id,buyerId:manifest.buyer_id,seedDigest:manifest.seed_digest}});
  // Inject only into this dedicated process before auth/payment composition.
  const file=require.resolve('../config/db');require.cache[file]={id:file,filename:file,loaded:true,exports:{pool,initializeDatabase:async()=>undefined}};
  const app=require('./app').createSandboxApp({pool,receiver,publicKey,origin:isolated.origin});
  server=await new Promise((resolve,reject)=>{const s=app.listen(env.PORT||3001,()=>resolve(s));s.once('error',reject);});
  let closing=false;const close=async()=>{if(closing)return;closing=true;await new Promise(r=>server.close(r));await pool.end();receiver.close();};
  process.once('SIGTERM',()=>{close().catch(()=>{process.exitCode=1;});});process.once('SIGINT',()=>{close().catch(()=>{process.exitCode=1;});});
  return {app,server,pool,receiver,close};
 }catch(e){receiver?.close();await pool.end();throw e;}
}
if(require.main===module)start().then(()=>console.log('Synthetic Paystack sandbox ready; signed approvals required')).catch(()=>{console.error('Sandbox startup refused');process.exitCode=1;});
module.exports={start};
