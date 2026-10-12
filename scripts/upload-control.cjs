'use strict';
// Shell-owned local IPC only; never loads application config, secrets, DB or provider SDK.
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const {ROOT}=require('../src/utils/uploadOperator');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function parse(args){
 const [operation,generation,confirmation,reconciliationConfirmation]=args;
 if(operation==='status'&&args.length===1)return {operation};
 if(!uuid.test(generation||''))throw Error();
 if(operation==='pause'&&args.length===2)return {operation,generation};
 if(operation==='resume'&&confirmation==='RESUME UPLOADS'&&args.length===3)return {operation,generation,confirmation};
 if(operation==='resume'&&confirmation==='RESUME UPLOADS'&&reconciliationConfirmation==='RECONCILIATION VERIFIED'&&args.length===4)return {operation,generation,confirmation,reconciliationConfirmation};
 throw Error();
}
async function operate(input,{root=ROOT,expectedCommit=process.env.RENDER_GIT_COMMIT}={}){
 if(process.platform!=='linux'||typeof process.getuid!=='function'||!/^[a-f0-9]{40}$/.test(expectedCommit||''))throw Error();
 const dir=fs.lstatSync(root);
 if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid()||(dir.mode&0o077)!==0)throw Error();
 const names=fs.readdirSync(root);
 // Ambiguous/stale entries require inspection; never ignore/delete them or retry a mutation.
 if(names.length!==1||!/^\d+-[a-f0-9-]{36}\.sock$/.test(names[0]))throw Error();
 const socketPath=path.join(root,names[0]),meta=fs.lstatSync(socketPath);
 if(!meta.isSocket()||meta.isSymbolicLink()||meta.uid!==process.getuid()||(meta.mode&0o777)!==0o600)throw Error();
 const selectedGeneration=names[0].replace(/^\d+-/,'').replace(/\.sock$/,'');
 if(!uuid.test(selectedGeneration)||(input.operation!=='status'&&input.generation!==selectedGeneration))throw Error();
 async function request(body){return new Promise((resolve,reject)=>{
  const socket=net.createConnection(socketPath);let data='',done=false;
  const timer=setTimeout(()=>end(true),4000);
  function end(error,value){if(done)return;done=true;clearTimeout(timer);socket.destroy();if(error)reject(Error());else resolve(value);}
  socket.on('connect',()=>socket.write(JSON.stringify(body)+'\n'));
  socket.on('error',()=>end(true));
  socket.on('data',chunk=>{data+=chunk.toString('utf8');if(Buffer.byteLength(data)>4096)end(true);});
  socket.on('end',()=>{try{end(false,JSON.parse(data));}catch{end(true);}});
 });}
 function validate(result){
 const keys=['ok','paused','shuttingDown','generation','commit','activeTotal','activeHandlers','observedCleanupFailures','lifecycleInvariantFailures'];
 if(!result||result.ok!==true||Object.keys(result).length!==keys.length||Object.keys(result).some(k=>!keys.includes(k))||
  result.generation!==selectedGeneration||result.commit!==expectedCommit||typeof result.paused!=='boolean'||typeof result.shuttingDown!=='boolean'||
  !result.activeHandlers||Object.keys(result.activeHandlers).sort().join(',')!=='image,taskCard,video'||
  !['activeTotal','observedCleanupFailures','lifecycleInvariantFailures'].every(k=>Number.isSafeInteger(result[k])&&result[k]>=0)||
  !Object.values(result.activeHandlers).every(n=>Number.isSafeInteger(n)&&n>=0)||
  result.activeTotal!==Object.values(result.activeHandlers).reduce((a,b)=>a+b,0))throw Error();
 return result;
 }
 const before=validate(await request({operation:'status'}));
 if(input.operation==='status')return before;
 return validate(await request(input)); // One mutation only; outcome uncertainty stops.
}
if(require.main===module){
 let input;try{input=parse(process.argv.slice(2));}catch{console.log(JSON.stringify({ok:false,code:'LOCAL_OPERATOR_INPUT_REJECTED'}));process.exitCode=1;}
 if(input)operate(input).then(result=>console.log(JSON.stringify(result))).catch(()=>{
  console.log(JSON.stringify({ok:false,code:'LOCAL_OPERATOR_STOP_RECONCILE_OUTCOME_NO_RETRY'}));process.exitCode=1;
 });
}
module.exports={parse,operate};
