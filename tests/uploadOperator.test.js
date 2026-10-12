'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {createUploadBarrier}=require('../src/utils/uploadBarrier'),{startUploadOperator}=require('../src/utils/uploadOperator');
const call=(p,body)=>new Promise((resolve,reject)=>{const s=net.createConnection(p),parts=[];s.on('connect',()=>s.write(body));s.on('data',x=>parts.push(x));s.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString()));}catch(e){reject(e);}});s.on('error',reject);});
test('Linux owner-only socket: status/pause/resume and refusal of stale or malformed commands',async()=>{
 assert.equal(process.platform,'linux','Run this transport suite with the pinned local Linux test runtime');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-operator-test-'));fs.chmodSync(root,0o700);
 const b=createUploadBarrier(),o=await startUploadOperator(b,{root});
 try{
  assert.equal(fs.statSync(root).mode&0o777,0o700);assert.equal(fs.statSync(o.socketPath).mode&0o777,0o600);assert.equal(fs.statSync(o.socketPath).uid,process.getuid());
  const status=await call(o.socketPath,JSON.stringify({operation:'status'})+'\n');assert(status.ok);assert(status.paused);assert.equal(status.activeTotal,0);
  assert.equal((await call(o.socketPath,JSON.stringify({operation:'resume',generation:'stale',confirmation:'RESUME UPLOADS'})+'\n')).ok,false);
  assert.equal((await call(o.socketPath,'{"operation":"status","secret":"synthetic"}\n')).ok,false);
  assert.equal((await call(o.socketPath,'not JSON\n')).ok,false);
  assert.equal((await call(o.socketPath,'{"operation":"status"}\n{"operation":"resume"}\n')).ok,false);
  assert.equal((await call(o.socketPath,'x'.repeat(1025))).ok,false);
  assert.equal((await call(o.socketPath,JSON.stringify({operation:'resume',generation:status.generation,confirmation:'RESUME UPLOADS'})+'\n')).ok,true);
  assert(!b.status().paused);
  assert.equal((await call(o.socketPath,JSON.stringify({operation:'pause',generation:status.generation})+'\n')).ok,true);assert(b.status().paused);
 }finally{await o.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('rejects group/world accessible operator directories before listening',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-unsafe-'));fs.chmodSync(root,0o755);try{await assert.rejects(startUploadOperator(createUploadBarrier(),{root}));assert.deepEqual(fs.readdirSync(root),[]);}finally{fs.rmSync(root,{recursive:true,force:true});}});
test('rejects symlinked operator directory',async()=>{const parent=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-symlink-')),real=path.join(parent,'real'),alias=path.join(parent,'alias');fs.mkdirSync(real,{mode:0o700});fs.symlinkSync(real,alias);try{await assert.rejects(startUploadOperator(createUploadBarrier(),{root:alias}));assert.deepEqual(fs.readdirSync(real),[]);}finally{fs.rmSync(parent,{recursive:true,force:true});}});
test('active lifecycle prevents operator resume over the real socket',async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-active-'));fs.chmodSync(root,0o700);const b=createUploadBarrier(),o=await startUploadOperator(b,{root});try{b.resume();const t=b.begin('video'),done=t.hold();b.pause();const r=await call(o.socketPath,JSON.stringify({operation:'resume',generation:b.status().generation,confirmation:'RESUME UPLOADS'})+'\n');assert.equal(r.ok,false);assert(b.status().paused);t.responseEnded();done();assert.equal(b.status().activeTotal,0);}finally{await o.close();fs.rmSync(root,{recursive:true,force:true});}});
