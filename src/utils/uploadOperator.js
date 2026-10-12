'use strict';
// Local OS-owner control only. No HTTP route, bearer credential, DB or provider access.
const fs=require('node:fs'),net=require('node:net'),path=require('node:path');
const ROOT='/tmp/uniclips-upload-control';
function command(barrier,input){
 const allowed=['operation','generation','confirmation','reconciliationConfirmation'];
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw Error('INVALID_COMMAND');
 if(input.operation==='status'&&Object.keys(input).length===1)return barrier.status();
 const current=barrier.status();
 if(input.generation!==current.generation)throw Error('INSTANCE_MISMATCH');
 if(input.operation==='pause'&&Object.keys(input).length===2)return barrier.pause();
 if(input.operation==='resume'&&input.confirmation==='RESUME UPLOADS'){
  if(Object.keys(input).length===3)return barrier.resume();
  if(Object.keys(input).length===4&&input.reconciliationConfirmation==='RECONCILIATION VERIFIED')return barrier.resume({acknowledgeCleanupFailures:true});
 }
 throw Error('INVALID_COMMAND');
}
async function startUploadOperator(barrier,{root=ROOT}={}){
 if(process.platform!=='linux'||typeof process.getuid!=='function')throw Error('LOCAL_OPERATOR_UNSUPPORTED');
 try{fs.mkdirSync(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const meta=fs.lstatSync(root);
 if(!meta.isDirectory()||meta.isSymbolicLink()||meta.uid!==process.getuid()||(meta.mode&0o077)!==0)throw Error('LOCAL_OPERATOR_DIRECTORY_UNSAFE');
 const generation=barrier.status().generation;
 if(!/^[a-f0-9-]{36}$/.test(generation))throw Error('LOCAL_OPERATOR_GENERATION_INVALID');
 const socketPath=path.join(root,process.pid+'-'+generation+'.sock');
 const server=net.createServer(socket=>{
  socket.setTimeout(3000,()=>socket.destroy());
  let data='',finished=false;
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
   if(finished)return;
   data+=chunk.toString('utf8');
   if(Buffer.byteLength(data)>1024){finished=true;socket.end(JSON.stringify({ok:false,code:'INVALID_COMMAND'})+'\n');return;}
   if(!data.includes('\n'))return;
   finished=true;
   try{
    if(data.indexOf('\n')!==data.length-1)throw Error();
    const result=command(barrier,JSON.parse(data));
    socket.end(JSON.stringify({ok:true,...result})+'\n');
   }catch{socket.end(JSON.stringify({ok:false,code:'OPERATOR_COMMAND_REJECTED'})+'\n');}
  });
 });
 server.maxConnections=4;
 await new Promise((resolve,reject)=>{
  server.once('error',reject);server.listen(socketPath,()=>{try{fs.chmodSync(socketPath,0o600);resolve();}catch(e){server.close();reject(e);}});
 });
 server.removeAllListeners('error');
 server.on('error',()=>{barrier.pause();});
 server.on('close',()=>{barrier.pause();});
 return {server,socketPath,async close(){await new Promise(r=>server.close(r));try{fs.unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
module.exports={command,startUploadOperator,ROOT};
