'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {inputs,response,signature,fixture}=require('./fixtures/paystackTransport.cjs');
const {configuration}=require('../src/services/paystackNigeria/transportConfig'),{decode,transactionId}=require('../src/services/paystackNigeria/transportJson');
const {createProvider,createTransport,checkoutUrl}=require('../src/services/paystackNigeria/provider'),{authenticate,event}=require('../src/services/paystackNigeria/webhooks');
const pause=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
test('activation requires signed test-only configuration; flags/live keys/merchant mismatch never activate',()=>{
 assert.equal(configuration().enabled,false);
 for(const options of [{envPatch:{NODE_ENV:'production'}},{envPatch:{PAYSTACK_NG_LIVE_CHECKOUT:'enabled'}},{patch:{credentialDigest:'0'.repeat(64)}},{patch:{environment:'live'}},{patch:{expiresAt:0}},{patch:{feesAbsorbed:false}},{patch:{noAutomaticSplits:false}},{patch:{callbackOrigin:'https://user@ui.example.invalid'}},{patch:{webhookScheme:'guess'}}])assert.throws(()=>inputs(options).config());
 assert.throws(()=>configuration({env:{NODE_ENV:'test',PAYSTACK_NG_TEST_CHECKOUT:'enabled'}}));
 const f=inputs({envPatch:{PAYSTACK_NG_TEST_CHECKOUT:'disabled'}}).config();assert.throws(()=>f.assert('testCheckout'));f.assert('webhooks');assert.equal(f.liveCheckout,false);
});
test('lossless decoder preserves unsigned64 IDs and rejects duplicate keys/invalid UTF8/budget violations',()=>{
 assert.equal(decode(Buffer.from('{"id":18446744073709551615}')).id,'18446744073709551615');
 assert.equal(transactionId('18446744073709551615'),'18446744073709551615');
 for(const id of [9007199254740992,'18446744073709551616','-1','1e5',null])assert.throws(()=>transactionId(id));
 for(const text of ['{"id":1,"id":2}','{"x":01}','{"__proto__":{}}','[1,]','1e999','['.repeat(34)])assert.throws(()=>decode(Buffer.from(text)));
 assert.throws(()=>decode(Buffer.from([255])));assert.throws(()=>decode(Buffer.alloc(262145)));
});
test('provider initialization sends documented fields only, NGN subunits, immutable metadata and server callback',async()=>{
 const f=fixture(),r=await f.api.checkout(f.input);assert.equal(r.state,'ready');assert.equal(f.store.state().purchases.length,0);
 const post=f.calls[0];assert.deepEqual(Object.keys(post.body).sort(),['amount','callback_url','currency','email','metadata','reference']);assert.equal(post.body.amount,'150000');assert.equal(post.body.currency,'NGN');assert.match(post.body.reference,/^psng-[a-f0-9-]+$/);assert.match(post.body.callback_url,/^https:\/\/ui.example.invalid\/course\/10\/20\?payment=paystack&order=/);
 assert.equal((await f.api.checkout(f.input)).url,r.url);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 for(const u of ['https://checkout.paystack.com.evil.invalid/x','http://checkout.paystack.com/x','https://user@checkout.paystack.com/x','https://checkout.paystack.com/x?next=evil','https://paystack.com/x'])assert.equal(checkoutUrl(u),null);
});
test('uncertain initialization and duplicate concurrent requests never issue a second initialization',async()=>{
 const f=fixture();f.state.initFailure=true;const r=await f.api.checkout(f.input);assert.equal(r.state,'pending');assert.equal(r.url,null);await f.api.checkout(f.input);assert.equal(f.calls.length,1);
 const g=fixture(),gate=pause();g.state.initPause=gate.promise;const first=g.api.checkout(g.input);await new Promise(r=>setImmediate(r));await assert.rejects(g.api.checkout(g.input),{code:'READ_CAPACITY_UNAVAILABLE'});assert.equal(g.api.budget.status().active,1);gate.resolve();await first;assert.equal(g.api.budget.status().active,0);
});
test('authoritative verification grants exactly once with held NGN shares at global99/100/101 and five months',async()=>{
 for(const n of [98,99,100]){const f=fixture({history:n}),o=await f.api.checkout(f.input),r=await f.api.verify(o.orderId,1);assert.equal(r.state,'fulfilled');assert.equal(f.store.state().allocations[0].ordinal,n+1);assert.equal(f.store.state().allocations[0].scholarMinor,n<100?105000:75000);assert.equal(f.store.state().allocations[0].payoutState,'held');
 const before=f.store.state();await f.api.verify(o.orderId,1);assert.equal(f.store.state().purchases.length,before.purchases.length);assert.equal(f.store.state().purchases.at(-1).expiresAt,before.purchases.at(-1).expiresAt);assert.equal(f.verifications[0].receipt.transactionId,'18446744073709551615');
 const replay=await f.api.checkout(f.input);assert.equal(replay.state,'fulfilled');assert.equal(replay.url,undefined);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}
});
test('wrong amount/currency/reference/domain/merchant metadata/email/ID/split cannot grant access',async()=>{
 for(const patch of [{amount:150001},{currency:'EUR'},{reference:'other'},{domain:'live'},{metadata:{}},{metadata:'{malformed'},{integration:999},{customer:{email:'other@example.invalid'}},{id:9007199254740992},{split:{id:1}},{subaccount:{id:1}},{status:'reversed'}]){
 const f=fixture(),o=await f.api.checkout(f.input);f.state.verifyPatch=patch;const r=await f.api.verify(o.orderId,1);assert.equal(r.state,'review');assert.equal(f.store.state().purchases.length,0);assert.equal(f.store.state().allocations.length,0);assert.equal(f.verifications.length,1);}
});
test('pending and failed responses remain unfulfilled; browser confirmation never substitutes for verification',async()=>{
 for(const status of ['pending','ongoing','processing','queued','abandoned','failed']){const f=fixture(),o=await f.api.checkout(f.input);f.state.verifyPatch={status};const r=await f.api.verify(o.orderId,1);assert.equal(r.state,status==='failed'?'failed':'pending');assert.equal(r.success,false);assert.equal(f.store.state().evidence.length,0);}
});
test('verification timeout is durable unknown evidence, and pending webhook retries are safe read-only re-verification',async()=>{
 const f=fixture(),o=await f.api.checkout(f.input);f.state.verifyFailure=true;await assert.rejects(f.api.verify(o.orderId,1),{code:'PAYSTACK_VERIFICATION_UNAVAILABLE'});assert.equal(f.verifications.at(-1).state,'pending');assert.equal(f.verifications.at(-1).digest,null);assert.equal(f.store.state().purchases.length,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
 f.state.verifyFailure=false;f.state.verifyPatch={status:'pending'};const raw=Buffer.from(JSON.stringify({event:'charge.success',data:response(f.store.state().orders[0]).data}));await assert.rejects(f.api.webhook(raw,signature(raw,f.configInput)),{code:'PAYSTACK_VERIFICATION_PENDING'});assert.equal(f.events.values().next().value.state,'pending');f.state.verifyPatch={};await f.api.webhook(raw,signature(raw,f.configInput));assert.equal(f.store.state().purchases.length,1);
});
test('missing historical approval before initialization prevents API calls; loss after payment leaves review without a grant',async()=>{
 const f=fixture();f.state.audited=false;await assert.rejects(f.api.checkout(f.input));assert.equal(f.calls.length,0);
 const g=fixture(),o=await g.api.checkout(g.input);g.state.audited=false;const r=await g.api.verify(o.orderId,1);assert.equal(r.state,'review');assert.equal(g.store.state().purchases.length,0);assert.equal(g.verifications.length,1);
});
test('all ledger write failures roll back access/allocation while durable verification remains; replay resolves commit failure',async()=>{
 for(const stage of ['saveEvidence','grant','allocate','appendSaleProof','advance','complete','commit']){const f=fixture(),o=await f.api.checkout(f.input);f.store.controls.failAt=stage;await assert.rejects(f.api.verify(o.orderId,1));assert.equal(f.store.state().purchases.length,0);assert.equal(f.store.state().allocations.length,0);assert.equal(f.verifications.length,1);f.store.controls.failAt=null;assert.equal((await f.api.verify(o.orderId,1)).state,'fulfilled');}
});
test('modern and explicitly pinned legacy signatures validate exact bytes with no fallback or timestamp replay',()=>{
 const raw=Buffer.from('{ "event":"charge.success", "data":{"id":1} }');
 for(const scheme of ['timestamped-v1','legacy-sha512']){const f=inputs({scheme}),h=signature(raw,f);authenticate(raw,h,f.config());assert.throws(()=>authenticate(Buffer.from('{}'),h,f.config()),{status:401});assert.throws(()=>authenticate(raw,{},f.config()),{status:401});}
 const f=inputs(),h=signature(raw,f,Math.floor(Date.now()/1000)-301);assert.throws(()=>authenticate(raw,h,f.config()),{status:401});
 const legacy=inputs({scheme:'legacy-sha512'});assert.throws(()=>authenticate(raw,{...signature(raw,legacy),'paystack-signature':'invalid'},legacy.config()),{status:401});
 const modern=signature(raw,f);authenticate(raw,{'paystack-signature':modern['paystack-signature']+',v1=whk_old:'+'0'.repeat(128)},f.config());assert.throws(()=>authenticate(raw,{'paystack-signature':modern['paystack-signature']+',t=1'},f.config()));
});
test('webhook durable inbox, replay, re-signing and out-of-order review never double fulfill',async()=>{
 const f=fixture(),o=await f.api.checkout(f.input),order=f.store.state().orders[0];
 const raw=Buffer.from(JSON.stringify({event:'charge.success',data:response(order).data}));await assert.rejects(f.api.webhook(raw,{}));assert.equal(f.events.size,0);
 assert.equal((await f.api.webhook(raw,signature(raw,f.configInput))).state,'processed');await f.api.webhook(raw,signature(raw,f.configInput));assert.equal(f.events.size,1);assert.equal(f.store.state().purchases.length,1);
 const refund=Buffer.from(JSON.stringify({event:'refund.processed',data:{id:123,reference:order.reference,domain:'test'}}));assert.equal((await f.api.webhook(refund,signature(refund,f.configInput))).state,'review');assert.equal(f.store.state().purchases.length,1);assert.equal(f.store.state().allocations[0].payoutState,'held');
 const other=fixture(),p=await other.api.checkout(other.input),ref=other.store.state().orders[0].reference,bad=Buffer.from(JSON.stringify({event:'charge.success',data:{id:5,reference:ref,domain:'test',amount:1,currency:'NGN'}}));assert.equal((await other.api.webhook(bad,signature(bad,other.configInput))).state,'review');assert.equal(other.store.state().purchases.length,0);
 assert.equal(event(raw).key,event(Buffer.from(JSON.stringify({event:'charge.success',data:{...response(order).data,delivery_time:123}}))).key);
});
test('HTTPS transport uses strict TLS, bounded response, no redirects/retries and waits for destroyed request close',async()=>{
 let count=0,lastOptions,closed;
 const request=(options,callback)=>{count++;lastOptions=options;const req=new EventEmitter();req.write=()=>{};req.end=()=>{};req.destroy=()=>{closed=()=>req.emit('close');};return req;};
 const read=createTransport({request,deadlineMs:10}),pending=read('GET','/transaction/verify/fixture','Bearer synthetic');let settled=false;pending.catch(()=>{settled=true;});await new Promise(r=>setTimeout(r,25));assert.equal(settled,false);assert.equal(count,1);assert.equal(lastOptions.hostname,'api.paystack.co');assert.equal(lastOptions.rejectUnauthorized,true);assert.equal(lastOptions.minVersion,'TLSv1.2');closed();await assert.rejects(pending,{code:'PAYSTACK_DEADLINE_EXCEEDED'});
 for(const status of [200,302,503]){let calls=0;const send=createTransport({request:(options,callback)=>{calls++;const req=new EventEmitter();req.write=()=>{};req.destroy=()=>queueMicrotask(()=>req.emit('close'));req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':'application/json'};res.destroy=()=>{};callback(res);if(status===200){res.complete=true;res.emit('data',Buffer.from('{"status":true}'));res.emit('end');}});return req;}});if(status===200)assert.equal((await send('GET','/transaction/verify/x','Bearer synthetic')).data.status,true);else await assert.rejects(send('GET','/transaction/verify/x','Bearer synthetic'));assert.equal(calls,1);}
});

test('refund arriving before local transaction evidence blocks later success; unlinkable financial exceptions quarantine fulfillment',async()=>{
 for(const linked of [true,false]){const f=fixture(),o=await f.api.checkout(f.input),data={id:123,domain:'test',amount:150000,currency:'NGN',...(linked?{transaction:'18446744073709551615'}:{})},raw=Buffer.from(JSON.stringify({event:'refund.processed',data}));
 assert.equal((await f.api.webhook(raw,signature(raw,f.configInput))).state,'review');assert.equal((await f.api.verify(o.orderId,1)).state,'review');assert.equal(f.store.state().purchases.length,0);assert.equal(f.store.state().allocations.length,0);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);}
});
test('transport rejects oversized/malformed responses and connection errors without leaking diagnostics',async()=>{
 for(const [body,error,expected]of [[Buffer.alloc(262145),false,'PAYSTACK_RESPONSE_LIMIT'],[Buffer.from('{"status":'),false,'PAYSTACK_INVALID_RESPONSE'],[null,true,'PAYSTACK_TRANSPORT_UNCERTAIN']]){
  const send=createTransport({request:(options,callback)=>{const req=new EventEmitter();req.write=()=>{};req.destroy=()=>queueMicrotask(()=>req.emit('close'));req.end=()=>queueMicrotask(()=>{if(error){req.emit('error',Error('PRIVATE_PROVIDER_TOKEN'));req.emit('close');return;}const res=new EventEmitter();res.headers={'content-type':'application/json'};res.statusCode=200;res.destroy=()=>{};callback(res);res.emit('data',body);res.complete=true;res.emit('end');});return req;}});
  await assert.rejects(send('GET','/transaction/verify/fixture','Bearer synthetic'),e=>e.code===expected&&!e.message.includes('PRIVATE'));
 }
});
