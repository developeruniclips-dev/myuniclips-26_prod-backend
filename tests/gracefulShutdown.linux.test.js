'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http'),net=require('node:net'),{spawn}=require('node:child_process');
assert.equal(process.platform,'linux','Use the pinned Linux runtime for actual SIGTERM tests');
const childSource="\nconst path=require('node:path'),fs=require('node:fs'),os=require('node:os'),http=require('node:http');\nconst root=process.argv[1],mode=process.argv[2];\nconst express=require(path.join(root,'node_modules/express'));\nconst {createUploadBarrier}=require(path.join(root,'src/utils/uploadBarrier'));\nconst {createGracefulShutdown}=require(path.join(root,'src/utils/gracefulShutdown'));\nconst {startUploadOperator,command}=require(path.join(root,'src/utils/uploadOperator'));\nconst b=createUploadBarrier(),events=[],folder=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-shutdown-'));\nlet release,shutdown;\nconst gate=()=>new Promise(r=>{release=r;process.send({kind:'stage',active:b.status().activeTotal});});\nprocess.on('message',m=>{\n if(m==='release')release?.();\n if(m==='probe'){let rejected=false;try{command(b,{operation:'resume',generation:b.status().generation,confirmation:'RESUME UPLOADS'});}catch{rejected=true;}process.send({kind:'probe',...shutdown.snapshot(),paused:b.status().paused,rejected,events});}\n});\nshutdown=createGracefulShutdown({barrier:b,pool:{end:async()=>{events.push('pool');}},diagnosticDelayMs:80,report:r=>{\n if(r.event==='SHUTDOWN_COMPLETE'){process.send({kind:'complete',events,...r});fs.rmSync(folder,{recursive:true,force:true});process.disconnect();}\n else process.send({kind:'report',...r});\n}});\nconst app=express();app.use(shutdown.admit);\napp.post('/work',...(mode==='webhook'?[]:[b.ingress('video')]),b.wrap(async(req,res)=>{\n try{\n  events.push('provider');await gate();\n  if(mode==='failure'){events.push('reconciliation');await new Promise(r=>setTimeout(r,40));}\n  else events.push('database');\n  if(!res.destroyed)res.end('ok');\n }finally{events.push('cleanup');await new Promise(r=>setTimeout(r,40));events.push('cleaned');}\n}));\napp.get('/new',(_req,res)=>{events.push('unexpected-new-handler');res.end('unexpected');});\nshutdown.instrument(app);\n(async()=>{\n const op=await startUploadOperator(b,{root:folder});\n const close=op.close;op.close=async()=>{events.push('operator');await close();};\n b.resume();\n const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));\n shutdown.ready(server,op);process.send({kind:'ready',port:server.address().port});\n})().catch(()=>{process.send({kind:'setup-failed'});process.exitCode=1;});\n";
async function fixture(mode,work){
 const child=spawn(process.execPath,['-e',childSource,path.resolve(__dirname,'..'),mode],{stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
 const messages=[],waiters=[];let errors='',exited=false;
 child.stderr.on('data',c=>{errors+=c;});child.on('exit',()=>{exited=true;});
 child.on('message',m=>{messages.push(m);for(const w of [...waiters])if(w.match(m)){clearTimeout(w.timer);waiters.splice(waiters.indexOf(w),1);w.resolve(m);}});
 const get=match=>{const prior=messages.find(match);if(prior)return Promise.resolve(prior);return new Promise((resolve,reject)=>{const w={match,resolve,timer:setTimeout(()=>reject(Error('Synthetic child observation timed out')),6000)};waiters.push(w);});};
 try{const ready=await get(m=>m.kind==='ready');await work({child,port:ready.port,get,messages});await new Promise((resolve,reject)=>{if(exited)return resolve();child.once('exit',(code,signal)=>code===0&&!signal?resolve():reject(Error('Shutdown child failed')));});assert.equal(errors,'');}
 finally{for(const w of waiters)clearTimeout(w.timer);if(!exited)child.kill('SIGKILL');}
}
for(const mode of ['provider','failure','webhook'])test('real SIGTERM waits for '+mode+' work after disconnect, then cleanup before resources',{timeout:15000},async()=>fixture(mode,async({child,port,get})=>{
 const req=http.request({host:'127.0.0.1',port,path:'/work',method:'POST'});req.on('error',()=>{});req.end();
 await get(m=>m.kind==='stage');req.destroy();
 child.kill('SIGTERM');await get(m=>m.event==='SHUTDOWN_STARTED');
 child.kill('SIGTERM');child.send('probe');
 const probe=await get(m=>m.kind==='probe');assert(probe.paused);assert(probe.rejected);assert(probe.shuttingDown);assert.equal(probe.events.includes('pool'),false);
 const incomplete=await get(m=>m.event==='SHUTDOWN_INCOMPLETE');assert(incomplete.activeHttp>0);assert.equal(incomplete.activeUploads,mode==='webhook'?0:1);
 child.send('release');const done=await get(m=>m.kind==='complete');
 assert.equal(done.activeHttp,0);assert.equal(done.activeUploads,0);
 assert(done.events.indexOf('cleaned')<done.events.indexOf('operator'));assert(done.events.indexOf('operator')<done.events.indexOf('pool'));
 assert(done.events.includes(mode==='failure'?'reconciliation':'database'));
}));
test('SIGTERM rejects a new pipelined request on an existing connection',{timeout:15000},async()=>fixture('provider',async({child,port,get})=>{
 const socket=net.createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});let data='';socket.on('data',c=>data+=c);
 await new Promise(r=>socket.once('connect',r));socket.write('POST /work HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n');
 await get(m=>m.kind==='stage');child.kill('SIGTERM');await get(m=>m.event==='SHUTDOWN_STARTED');
 socket.write('GET /new HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
 await get(m=>m.event==='SHUTDOWN_INCOMPLETE');child.send('release');const done=await get(m=>m.kind==='complete');
 assert(!done.events.includes('unexpected-new-handler'));assert.match(data,/503 Service Unavailable/);socket.destroy();
}));
