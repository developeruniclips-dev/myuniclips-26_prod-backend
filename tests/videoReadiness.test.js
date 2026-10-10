const test=require('node:test'),assert=require('node:assert/strict');
const {classify,createVideoReadiness}=require('../src/services/videoReadiness');
const {syntheticVimeo}=require('./fixtures/vimeoPolicy');
test('transfer completion alone never asserts playable; explicit completion of both stages does',()=>{assert.equal(classify({upload:{status:'complete'},transcode:{status:'in_progress'}}),'PROCESSING');assert.equal(classify({upload:{status:'complete'},transcode:{status:'complete'}}),'READY');for(const body of [null,{}, {upload:{status:'complete'}}])assert.equal(classify(body),'UNKNOWN');assert.equal(classify({upload:{status:'error'}}),'FAILED');assert.equal(classify({transcode:{status:'error'}}),'FAILED');});
test('coalesced/cache denial is bounded; READY is never cached as a future privacy grant',async()=>{
 let time=0,processing=true;const adapter=syntheticVimeo({state:()=>({processing})}),s=createVideoReadiness(adapter,{now:()=>time});
 const [one,two]=await Promise.all([s.read('https://vimeo.com/123'),s.read('https://vimeo.com/123')]);assert.equal(one.state,'PROCESSING');assert.deepEqual(one,two);assert.equal(adapter.calls.length,3);
 await s.read('https://vimeo.com/123');assert.equal(adapter.calls.length,3);time=31000;processing=false;assert.equal((await s.read('https://vimeo.com/123')).state,'READY');
 adapter.asset(123).privacy.view='anybody';assert.equal((await s.read('https://vimeo.com/123')).policyVerified,false);
});
test('provider failures, timeout, rate-limit and invalid URI fail closed without raw errors',async()=>{
 for(const mode of ['error','timeout','429']){const s=createVideoReadiness({request(o,done){if(mode==='error')done(Error('SECRET_PROVIDER_TOKEN'),{},500);if(mode==='429')done(null,{},429);}},{timeoutMs:5});const r=await s.read('https://vimeo.com/123');assert.equal(r.state,'UNKNOWN');assert.equal(r.policyVerified,false);assert.doesNotMatch(JSON.stringify(r),/SECRET/);}
 assert.equal((await createVideoReadiness({request(){assert.fail();}}).read('https://evil.example/123')).policyVerified,false);
});
test('readiness traffic budget cannot bypass policy or create unbounded reads',async()=>{
 const adapter=syntheticVimeo(),s=createVideoReadiness(adapter,{maxReads:1});assert.equal((await s.read('https://vimeo.com/123')).state,'READY');assert.equal((await s.read('https://vimeo.com/124')).state,'UNKNOWN');assert.equal(adapter.calls.length,3);
});
