'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {inputs,response,signature}=require('./paystackTransport.cjs'),W=require('./courseWriterPolicy.cjs');
const {event}=require('../../src/services/paystackNigeria/webhooks');
const {createCheckoutService}=require('../../src/services/paystackNigeria/checkoutService'),{createTransportStore}=require('../../src/services/paystackNigeria/transportStore'),{digest}=require('../../src/services/paystackNigeria/transportConfig');
module.exports=async({pool,exec,test,scope,seedAudited,store,report})=>{
 let sequence=9007199254740993n;
 async function newScope(n=0){const sc=await scope();await exec("UPDATE paystack_ng_offerings SET merchant_account='100043' WHERE subject_id=?",[sc.subjectId]);if(n)await seedAudited(sc,n);return sc;}
 function workflow({ledgerPool=pool,transportPool=pool,f=inputs(),writerPolicy=W()}={}){
  const config=f.config(),records=new Map(),calls=[],state={patch:{},uncertain:false,pause:null};
  const transport=async(method,path,auth,body)=>{
   calls.push({method,path});if(method==='POST'){
    const [[row]]=await pool.query('SELECT id FROM paystack_ng_orders WHERE reference=?',[body.reference]);const o=await store().readOrder(row.id);records.set(o.reference,{o,email:body.email,id:String(sequence++)});
    assert.equal(body.amount,'150000');assert.equal(body.currency,'NGN');assert.equal(new URL(body.callback_url).origin,'https://ui.example.invalid');
    if(state.pause)await state.pause;if(state.uncertain)throw Error('SYNTHETIC_PROVIDER_TIMEOUT');
    return {data:{status:true,data:{authorization_url:'https://checkout.paystack.com/synthetic-token',access_code:'synthetic-token',reference:o.reference}},digest:digest('synthetic init')};
   }
   const reference=decodeURIComponent(path.slice(path.lastIndexOf('/')+1)),r=records.get(reference);assert(r,'only a durable synthetic initialized reference can be verified');
   const data=response(r.o,r.email,{id:r.id,...state.patch});return {data,digest:digest(JSON.stringify(data))};
  };
  const api=createCheckoutService({config,pool,ledgerStore:store(ledgerPool),writerPolicy,transport,transportStore:createTransportStore({pool:transportPool,config})});return {api,state,calls,records,f};
 }
 const checkout=(w,sc,buyerId=20,key=crypto.randomUUID())=>w.api.checkout({...sc,buyerId,idempotencyKey:key});
 const counts=async sc=>{const r={};for(const t of ['subject_purchases','paystack_ng_allocations','paystack_ng_transactions','course_sale_proofs']){const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM '+t+' WHERE '+(t==='paystack_ng_transactions'?'order_id IN (SELECT id FROM paystack_ng_orders WHERE subject_id=?)':'subject_id=?'),[sc.subjectId]);r[t]=Number(n.n);}return r;};
 await test('new checkout/verification DDL validates against actual academic/order schema; preview is not executed against existing DBs',async()=>{
  for(const sql of require('../../src/services/paystackNigeria/transportSchema').statements)await exec(sql);
  const [r]=await pool.query("SELECT TABLE_NAME,ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN('paystack_ng_checkouts','paystack_ng_verifications')");assert.equal(r.length,2);assert(r.every(r=>r.ENGINE==='InnoDB'));
 });
 await test('complete initialized/verified checkout at global99/100/101 grants exactly once with held allocations and original receipt',async()=>{
  for(const baseline of [98,99,100]){const sc=await newScope(baseline),w=workflow(),o=await checkout(w,sc);assert.equal((await w.api.verify(o.orderId,20)).state,'fulfilled');const [[a]]=await pool.query('SELECT * FROM paystack_ng_allocations WHERE order_id=?',[o.orderId]);assert.equal(Number(a.sale_ordinal),baseline+1);assert.equal(Number(a.scholar_minor),baseline<100?105000:75000);assert.equal(a.payout_state,'held');
   const before=await counts(sc);await w.api.verify(o.orderId,20);assert.deepEqual(await counts(sc),before);const [[e]]=await pool.query('SELECT provider_transaction_id,receipt FROM paystack_ng_verifications WHERE order_id=? LIMIT 1',[o.orderId]);assert.equal(typeof e.provider_transaction_id,'string');assert(BigInt(e.provider_transaction_id)>9007199254740991n);assert.equal(e.receipt.reference,w.records.values().next().value.o.reference);assert.equal(w.calls.filter(c=>c.method==='POST').length,1);
   const original=w.records.values().next().value.o;const replay=await checkout(w,sc,20,original.idempotencyKey);assert.equal(replay.state,'fulfilled');assert.equal(replay.url,undefined);assert.equal(w.calls.filter(c=>c.method==='POST').length,1);
   assert.equal((await createTransportStore({pool,config:w.f.config()}).beginInitialization({...original,state:'created'})).fulfilled,true);
  }
 });
 await test('durable init timeout and duplicate calls reuse one attempt, and verified success can resolve an uncertain POST',async()=>{
  const sc=await newScope(),w=workflow(),key=crypto.randomUUID();w.state.uncertain=true;const o=await checkout(w,sc,20,key);assert.equal(o.url,null);await checkout(w,sc,20,key);assert.equal(w.calls.length,1);assert.equal((await w.api.verify(o.orderId,20)).state,'fulfilled');
 });
 await test('missing audit prevents initialization; changed audit after initialization preserves payment for review without access',async()=>{
  for(const before of [true,false]){const sc=await newScope(),w=workflow();let o;if(!before)o=await checkout(w,sc);await exec("UPDATE course_sale_audits SET state='blocked' WHERE subject_id=?",[sc.subjectId]);
   if(before){await assert.rejects(checkout(w,sc));assert.equal(w.calls.length,0);}else{assert.equal((await w.api.verify(o.orderId,20)).state,'review');assert.equal((await counts(sc)).subject_purchases,0);const[[n]]=await pool.query('SELECT COUNT(*) AS n FROM paystack_ng_verifications WHERE order_id=?',[o.orderId]);assert.equal(Number(n.n),1);}
  }
 });
 await test('wrong provider evidence never enters entitlement or Scholar allocation tables',async()=>{
  for(const patch of [{amount:150001},{currency:'EUR'},{reference:'wrong'},{domain:'live'},{metadata:{}},{metadata:'{malformed'},{integration:999},{status:'reversed'},{split:{id:1}}]){const sc=await newScope(),w=workflow(),o=await checkout(w,sc);w.state.patch=patch;assert.equal((await w.api.verify(o.orderId,20)).state,'review');assert.equal((await counts(sc)).subject_purchases,0);}
 });
 await test('real inbox uniqueness, fresh delivery signatures, refund linkage and conflicting replay retain one grant',async()=>{
  const sc=await newScope(),w=workflow(),o=await checkout(w,sc),r=[...w.records.values()][0];const body=Buffer.from(JSON.stringify({event:'charge.success',data:response(r.o,r.email,{id:r.id}).data}));
  await assert.rejects(w.api.webhook(body,{}),{status:401});assert.equal((await w.api.webhook(body,signature(body,w.f))).state,'processed');await w.api.webhook(body,signature(body,w.f));assert.equal((await counts(sc)).subject_purchases,1);
  const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM paystack_ng_events WHERE order_id=?',[o.orderId]);assert.equal(Number(n.n),1);
  const refund=Buffer.from(JSON.stringify({event:'refund.processed',data:{id:100,transaction:r.id,amount:150000,currency:'NGN',domain:'test'}}));assert.equal((await w.api.webhook(refund,signature(refund,w.f))).state,'review');assert.equal((await w.api.status(o.orderId,20)).state,'review');assert.equal((await counts(sc)).subject_purchases,1);
  const conflict=Buffer.from(JSON.stringify({event:'charge.success',data:response(r.o,r.email,{id:r.id,amount:1}).data}));assert.equal((await w.api.webhook(conflict,signature(conflict,w.f))).state,'review');const [[a]]=await pool.query('SELECT payout_state FROM paystack_ng_allocations WHERE order_id=?',[o.orderId]);assert.equal(a.payout_state,'held');
 });
 await test('concurrent buyers serialize global100/101; every started verification settles and explicit replay is safe',async()=>{
  const sc=await newScope(99),w=workflow(),one=await checkout(w,sc,20),two=await checkout(w,sc,21);const results=await Promise.allSettled([w.api.verify(one.orderId,20),w.api.verify(two.orderId,21)]);assert(results.some(r=>r.status==='fulfilled'));assert.equal(w.api.budget.status().active,0);
  for(const [o,b]of [[one,20],[two,21]])await w.api.verify(o.orderId,b);
  const [rows]=await pool.query('SELECT sale_ordinal,scholar_minor FROM paystack_ng_allocations WHERE subject_id=? ORDER BY sale_ordinal',[sc.subjectId]);assert.deepEqual(rows.map(r=>[Number(r.sale_ordinal),Number(r.scholar_minor)]),[[100,105000],[101,75000]]);
 });
 await test('a durable review inbox item cannot be promoted by later delivery of the same authenticated event',async()=>{
  const sc=await newScope(),w=workflow(),o=await checkout(w,sc),r=[...w.records.values()][0],raw=Buffer.from(JSON.stringify({event:'charge.success',data:response(r.o,r.email,{id:r.id}).data}));
  const inbox=createTransportStore({pool,config:w.f.config()}),claim=event(raw);await inbox.recordEvent(claim);await inbox.completeEvent(claim.key,'review');
  const before=w.calls.length;assert.equal((await w.api.webhook(raw,signature(raw,w.f))).state,'review');assert.equal(w.calls.length,before);assert.equal((await counts(sc)).subject_purchases,0);
 });
 function brokenPool({afterWrite,afterCommit}){let fired=false;return {async getConnection(){const c=await pool.getConnection();let grant=false;return new Proxy(c,{get(t,k){if(k==='query')return async(sql,args)=>{const text=typeof sql==='string'?sql:sql.sql;const result=await t.query(sql,args);if(/INSERT INTO subject_purchases/.test(text))grant=true;if(!fired&&afterWrite&&text.includes(afterWrite)){fired=true;throw Error('SYNTHETIC_AFTER_WRITE');}return result;};if(k==='commit')return async()=>{await t.commit();if(!fired&&afterCommit&&grant){fired=true;throw Error('LOST_COMMIT_ACK');}};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}};}
 await test('failure after every ledger write rolls back access/ordinal/share while transport verification evidence survives',async()=>{
  for(const pattern of ['INSERT INTO paystack_ng_transactions','INSERT INTO subject_purchases','INSERT INTO paystack_ng_allocations','INSERT INTO course_sale_proofs','INSERT INTO paystack_ng_sale_counters',"UPDATE paystack_ng_orders SET state='fulfilled'"]){const sc=await newScope(),w=workflow({ledgerPool:brokenPool({afterWrite:pattern})}),o=await checkout(w,sc);const before=await counts(sc);await assert.rejects(w.api.verify(o.orderId,20));assert.deepEqual(await counts(sc),before);assert.equal((await w.api.verify(o.orderId,20)).state,'fulfilled');}
 });
 await test('lost real commit acknowledgement resolves through owned status/replay without extending access',async()=>{
  const sc=await newScope(),w=workflow({ledgerPool:brokenPool({afterCommit:true})}),o=await checkout(w,sc);await assert.rejects(w.api.verify(o.orderId,20),/LOST_COMMIT_ACK/);assert.equal((await w.api.status(o.orderId,20)).state,'fulfilled');const [[before]]=await pool.query('SELECT access_expires_at FROM subject_purchases WHERE subject_id=?',[sc.subjectId]);await w.api.verify(o.orderId,20);const [[after]]=await pool.query('SELECT access_expires_at FROM subject_purchases WHERE subject_id=?',[sc.subjectId]);assert.equal(String(after.access_expires_at),String(before.access_expires_at));assert.equal((await counts(sc)).subject_purchases,1);
 });
 await test('incompatible writer refuses before initialization; ownership and duplicate/expired purchase protections remain',async()=>{
  const sc=await newScope(),bad=workflow({writerPolicy:W({patch:{phase2aWriters:1}})});await assert.rejects(checkout(bad,sc));assert.equal(bad.calls.length,0);
  const w=workflow(),o=await checkout(w,sc);await assert.rejects(w.api.verify(o.orderId,21));await w.api.verify(o.orderId,20);await exec("UPDATE subject_purchases SET is_access_active=0,access_expires_at='2000-01-01' WHERE subject_id=?",[sc.subjectId]);await assert.rejects(checkout(w,sc));await w.api.verify(o.orderId,20);assert.equal((await counts(sc)).subject_purchases,1);
  const [[n]]=await pool.query('SELECT COUNT(*) AS n FROM payment_transfers');assert.equal(Number(n.n),0);const[[p]]=await pool.query('SELECT COUNT(*) AS n FROM scholar_payouts');assert.equal(Number(p.n),0);
 });
 await test('refund before local payment evidence is linked by exact transaction identity; unlinkable financial exceptions quarantine fulfillment',async()=>{
  for(const linked of [true,false]){const sc=await newScope(),w=workflow(),o=await checkout(w,sc),r=[...w.records.values()][0],raw=Buffer.from(JSON.stringify({event:'refund.processed',data:{id:linked?1001:1002,domain:'test',amount:150000,currency:'NGN',...(linked?{transaction:r.id}:{})}}));
   assert.equal((await w.api.webhook(raw,signature(raw,w.f))).state,'review');const [[inbox]]=await pool.query('SELECT order_id,transaction_identity FROM paystack_ng_events WHERE event_key=?',[event(raw).key]);assert.equal(inbox.order_id,null);assert.equal(inbox.transaction_identity,linked?r.id:null);
   assert.equal((await w.api.verify(o.orderId,20)).state,'review');assert.equal((await counts(sc)).subject_purchases,0);assert.equal((await counts(sc)).paystack_ng_allocations,0);assert.equal(w.calls.filter(c=>c.method==='POST').length,1);
  }
 });
 report.observations.transport={externalRequests:0,createdPayments:0,automaticPayouts:0,host:'inert function only',liveEnabled:false};
};
