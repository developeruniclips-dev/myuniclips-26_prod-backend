'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createUploadBarrier}=require('../src/utils/uploadBarrier'),{startUploadOperator}=require('../src/utils/uploadOperator');
const {parse,operate}=require('../scripts/upload-control.cjs');
const commit='a'.repeat(40);
async function fixture(work){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-client-test-'));fs.chmodSync(root,0o700);
 const barrier=createUploadBarrier({commit}),operator=await startUploadOperator(barrier,{root});
 try{await work({root,barrier,operator,options:{root,expectedCommit:commit}});}
 finally{await operator.close();fs.rmSync(root,{recursive:true,force:true});}
}
test('client restricts its command shape and requires explicit resume confirmation',()=>{
 const generation='12345678-1234-1234-1234-123456789012';
 assert.deepEqual(parse(['status']),{operation:'status'});
 assert.deepEqual(parse(['pause',generation]),{operation:'pause',generation});
 assert.throws(()=>parse(['status','extra']));assert.throws(()=>parse(['resume',generation]));assert.throws(()=>parse(['pause','stale']));
});
test('client verifies instance/commit before one mutation and reads aggregate status only',async()=>fixture(async({barrier,options})=>{
 const before=await operate({operation:'status'},options);assert(before.paused);
 await assert.rejects(operate(parse(['resume',before.generation,'RESUME UPLOADS']),{...options,expectedCommit:'b'.repeat(40)}));
 assert(barrier.status().paused,'Wrong reviewed build must never be resumed');
 const resumed=await operate(parse(['resume',before.generation,'RESUME UPLOADS']),options);assert(!resumed.paused);
 const paused=await operate(parse(['pause',before.generation]),options);assert(paused.paused);
 await assert.rejects(operate(parse(['pause','12345678-1234-1234-1234-123456789012']),options));
}));
test('client stops on ambiguous entries and bad modes without mutation',async()=>fixture(async({root,barrier,operator,options})=>{
 const extra=path.join(root,'unexpected');fs.writeFileSync(extra,'synthetic');
 await assert.rejects(operate({operation:'status'},options));fs.unlinkSync(extra);
 fs.chmodSync(operator.socketPath,0o666);await assert.rejects(operate({operation:'status'},options));fs.chmodSync(operator.socketPath,0o600);
 fs.chmodSync(root,0o755);await assert.rejects(operate({operation:'status'},options));fs.chmodSync(root,0o700);
 assert(barrier.status().paused);
}));
test('operator socket loss pauses previously resumed admission',async()=>fixture(async({barrier,operator})=>{
 barrier.resume();await new Promise(resolve=>operator.server.close(resolve));assert(barrier.status().paused);
}));
