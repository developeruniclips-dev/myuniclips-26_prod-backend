'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../src/services/coursePayments/historicalResolver'),W=require('../src/services/coursePayments/writerPolicy'),reporting=require('../src/services/coursePayments/reporting');
const fixtureWriter=require('./fixtures/courseWriterPolicy.cjs');
const {createMemoryStore}=require('./fixtures/paystackNigeriaMemory.cjs'),{createServices}=require('../src/services/paystackNigeria/services'),{createPolicy}=require('../src/services/paystackNigeria/policy');
const fact=(n=1,patch={})=>({purchase_id:n,subject_id:10,scholar_id:20,sale_ordinal:n,provider:'stripe',entity:'UNICLIPS_OY',merchant_account:'synthetic-merchant',environment:'test',provider_transaction_id:'pi-'+n,provider_reference:'pi-'+n,currency:'EUR',gross_minor:600,scholar_rate:n<=100?70:50,scholar_minor:n<=100?420:300,source_kind:'legacy_verified',source_key:'release-'+n,evidence_digest:'a'.repeat(64),...patch});
const scope={subjectId:10,scholarId:20};
function dbFor(rows,audit={}){return {query:async sql=>[sql.includes('FROM course_sale_audits')?[{state:'approved',writer_mode:'legacy_verified',baseline_count:rows.length,baseline_digest:H.digest(rows),review_version:1,...audit}]:rows]};}
test('audited lifetime ordinals 99/100/101 across providers retain exact gross shares',async()=>{
 const facts=Array.from({length:100},(_,i)=>fact(i+1));facts.push(fact(101,{provider:'paystack',entity:'UNICLIPS_NIGERIA_LIMITED',provider_reference:'psng-101',currency:'NGN',gross_minor:150000,scholar_minor:75000,source_kind:'paystack_ng'}));
 H.validateFacts(facts,scope);const proofs=await H.resolveHistoricalSales(dbFor(facts),facts.map(r=>({id:r.purchase_id,transactionId:r.provider_reference,currency:r.currency,amountMinor:r.gross_minor})),scope);assert.equal(proofs[100].ordinal,101);assert.equal(proofs.length,101);
 for(const patch of [{sale_ordinal:100},{scholar_minor:105000},{gross_minor:150001},{currency:'EUR'}])assert.throws(()=>H.validateFacts([...facts.slice(0,100),{...facts[100],...patch}],scope));
});
test('missing audit, blocked audit, altered digest, deleted proof and conflicting purchase evidence refuse zero/reset',async()=>{
 const rows=[fact()];for(const db of [{query:async()=>[[]]},dbFor(rows,{state:'blocked'}),dbFor(rows,{baseline_digest:'b'.repeat(64)}),dbFor([],{baseline_count:1})])await assert.rejects(H.resolveHistoricalSales(db,[],scope));
 await assert.rejects(H.resolveHistoricalSales(dbFor(rows),[{id:1,transactionId:'wrong',currency:'EUR',amountMinor:600}],scope),{code:'BASELINE_VERIFICATION_REQUIRED'});
 assert.deepEqual(await H.resolveHistoricalSales(dbFor([]),[],scope),[]);
});
test('writer gate rejects absent/expired/tampered/phase2a/unknown/old-generation evidence, environment alone never suffices',()=>{
 assert.throws(()=>W.createWriterPolicy({mode:()=> 'legacy_verified'}).assertSafe(),{code:'WRITER_SAFETY_UNVERIFIED'});
 for(const patch of [{expiresAt:0},{phase2aWriters:1},{unknownWriters:1},{mode:'phase2a'},{generation:'old'},{entryPoints:[]},{environment:'live'}])assert.throws(()=>fixtureWriter({patch}).assertSafe(),{code:'WRITER_SAFETY_UNVERIFIED'});
 assert.equal(fixtureWriter().assertSafe().mode,'legacy_verified');
});
test('all NG fulfillment including replay is fenced before provider or database work',async()=>{
 let calls=0;const service=createServices({store:{readOrder(){calls++;}},provider:{kind:'offline-double',verify(){calls++;}},policy:createPolicy({enabled:true,merchantAccount:'synthetic'})});
 await assert.rejects(service.fulfill({orderId:'00000000-0000-0000-0000-000000000001',buyerId:1}),{code:'WRITER_SAFETY_UNVERIFIED'});assert.equal(calls,0);
});
test('pending academic context changes refuse fulfillment; new references are provider-compatible; proof append failure rolls back',async()=>{
 const store=createMemoryStore(),policy=createPolicy({enabled:true,merchantAccount:'synthetic'}),now=Date.now(),provider={kind:'offline-double',async verify(reference){const o=store.state().orders.find(o=>o.reference===reference);return {verified:true,status:'success',reference,orderId:o.id,buyerId:o.buyerId,subjectId:o.subjectId,scholarId:o.scholarId,merchantAccount:o.merchantAccount,environment:'test',transactionId:'18446744073709551615',evidenceDigest:'a'.repeat(64),totalChargedMinor:150000,amountMinor:150000,currency:'NGN',feesMinor:200000,refundedMinor:0,disputed:false,paidAt:Math.floor(now/1000)};}};
 const service=createServices({store,provider,policy,now:()=>now,writerPolicy:fixtureWriter()}),o=await service.createOrder({buyerId:1,subjectId:10,scholarId:20,idempotencyKey:'synthetic-request-key'});assert.match(o.reference,/^[A-Za-z0-9.=-]+$/);
 store.controls.academic={countryId:10};await assert.rejects(service.fulfill({orderId:o.id,buyerId:1}),{code:'ORDER_CONTEXT_CHANGED'});assert.equal(store.state().purchases.length,0);
 store.controls.academic={};store.controls.failAt='appendSaleProof';await assert.rejects(service.fulfill({orderId:o.id,buyerId:1}));assert.equal(store.state().evidence.length,0);assert.equal(store.state().allocations.length,0);
 store.controls.failAt=null;assert.equal((await service.fulfill({orderId:o.id,buyerId:1})).scholarMinor,105000);
});
test('currency/provider/entity totals never combine unlike money; unknown earnings are not payable',()=>{
 const rows=[{amount:'6.00',currency:'EUR',provider:'stripe',entity:'UNICLIPS_OY',verificationState:'verified',scholarMinor:420},{amount:'1500.00',currency:'NGN',provider:'paystack',entity:'UNICLIPS_NIGERIA_LIMITED',verificationState:'verified',scholarMinor:75000,payoutState:'held'},{amount:'1500.00',currency:'NGN',provider:'unreconciled',entity:null,verificationState:'unreconciled'}];
 const groups=reporting.summarize(rows);assert.equal(groups.length,3);assert.equal(groups[0].verifiedGrossMinor,600);assert.equal(groups[1].heldScholarMinor,75000);assert.equal(groups[2].unreconciledSales,1);assert.equal(groups[2].scholarMinor,0);assert(groups.every(g=>g.feesMinor===null&&g.platformNetMinor===null));
});
test('audit importer requires signed review and independent source verifier before any DB work',async()=>{
 let calls=0;const importer=H.createAuditImporter({pool:{getConnection(){calls++;}}});await assert.rejects(importer({payload:'{}',signature:''}),{code:'SIGNED_AUDIT_REQUIRED'});assert.equal(calls,0);
});
test('stored historical source verification requires independent provenance and exact legacy/phase2a context',async()=>{
 const {createStoredSourceVerifier}=require('../src/services/coursePayments/historicalSources'),f=fact(),p={id:1,subject_id:10,scholar_id:20,buyer_user_id:11,transaction_id:f.provider_reference,currency:'EUR',amount:'6.00'};
 let calls=0;const i={kind:'uniclips_legacy_verified_v1',purchaseId:1,paymentId:f.provider_reference,account:f.merchant_account,livemode:false,currency:'EUR',amountMinor:420,grossMinor:600,ordinal:1,rate:70};
 const db={query:async()=>{calls++;return [[{amount:'4.20',currency:'eur',description:JSON.stringify(i)}]];}};
 assert.equal(await createStoredSourceVerifier()(db,f,p),false);assert.equal(calls,0);
 const check=createStoredSourceVerifier({verifyProvenance:async()=>true});assert.equal(await check(db,f,p),true);
 for(const [key,value]of [['paymentId','other'],['ordinal',101],['livemode',true],['account','other'],['amountMinor',300]]){const copy={...i,[key]:value};assert.equal(await check({query:async()=>[[{amount:'4.20',currency:'eur',description:JSON.stringify(copy)}]]},f,p),false);}
 const modern={...f,source_kind:'phase2a',source_key:'order-1'},order={provider:'stripe',state:'fulfilled',buyer_id:11,subject_id:10,scholar_id:20,provider_account:f.merchant_account,livemode:0,payment_id:f.provider_reference,currency:'EUR',amount_minor:600,gross_minor:600,sale_ordinal:1,scholar_minor:420,scholar_rate:70};
 assert.equal(await check({query:async()=>[[order]]},modern,p),true);assert.equal(await check({query:async()=>[[{...order,scholar_minor:300}]]},modern,p),false);
});
module.exports={fact};
