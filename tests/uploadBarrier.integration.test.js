'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {createUploadBarrier}=require('../src/utils/uploadBarrier'),{createUpload}=require('../src/middleware/uploadSecurity');
const fixtures=require('./fixtures/uploadFiles');
let server,base,barrier,root,authorizationCalls=0,held,cleanup;
test.before(async()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-barrier-test-'));barrier=createUploadBarrier();const app=express();
 app.post('/video',barrier.ingress('video'),barrier.wrap(async(req,res,next)=>{authorizationCalls++;if(req.headers.authorization!=='synthetic-scholar')return res.status(401).json({message:'Denied'});req.user={id:7};next();}),
 barrier.wrap(createUpload('video',{root,barrier})),barrier.wrap(async(req,res)=>{
  req.uploadState.processing=true;
  try{await new Promise(r=>{held=r;});res.status(201).json({ok:true});}
  finally{await new Promise(r=>{cleanup=r;});await req.uploadState.finish();}
 }));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
const settle=()=>new Promise(r=>setTimeout(r,10));
async function upload(auth='synthetic-scholar',signal){const form=new FormData();form.append('video',new Blob([fixtures.mp4],{type:'video/mp4'}),'synthetic.mp4');return fetch(base+'/video',{method:'POST',headers:{authorization:auth},body:form,signal});}
test('real multipart rejection occurs before authorization/storage',async()=>{const r=await upload();assert.equal(r.status,503);assert.equal(authorizationCalls,0);assert.deepEqual(fs.readdirSync(root),[]);});
test('unpaused route still denies unauthorized caller without storage',async()=>{barrier.resume();assert.equal((await upload('invalid')).status,401);assert.equal(barrier.status().activeTotal,0);assert.deepEqual(fs.readdirSync(root),[]);});
test('client disconnect and pause keep real parser/controller/cleanup counted',async()=>{
 const abort=new AbortController(),response=upload('synthetic-scholar',abort.signal).catch(()=>null);
 while(!held)await settle();assert.equal(barrier.status().activeTotal,1);assert.equal(fs.readdirSync(root).length,1);
 abort.abort();await response;barrier.pause();assert.equal((await upload()).status,503);assert.equal(barrier.status().activeTotal,1);
 held();while(!cleanup)await settle();assert.equal(barrier.status().activeTotal,1);
 cleanup();for(let i=0;i<100&&barrier.status().activeTotal;i++)await settle();
 assert.equal(barrier.status().activeTotal,0);assert.deepEqual(fs.readdirSync(root),[]);
});
