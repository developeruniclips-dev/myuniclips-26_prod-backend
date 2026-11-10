'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../src/services/coursePayments/routing');
const base={id:123,scholar_id:7,university_id:55,country_id:9,university_country_code:'NG',country_occurrences:1,bundle_price:'6.00',application_approved:1,profile_approved:1,workflow_state:'PUBLISHED',has_content:1};
test('university country alone routes FUNAAB/HAMK and future universities for every buyer location',()=>{
 for(const university_id of [1,55,189,987])for(const university_country_code of ['FI','NG'])for(const buyer_country of ['NG','FI','GB','US','other',null]){
  const p=R.paymentDecision({...base,university_id,university_country_code,buyer_country,ip_country:buyer_country,nationality:buyer_country,name:'Misleading university label'},{stripeReady:true});
  assert.equal(p.currency,university_country_code==='NG'?'NGN':'EUR');assert.equal(p.amountMinor,university_country_code==='NG'?150000:600);assert.equal(p.provider,university_country_code==='NG'?'paystack':'stripe');assert.equal(p.checkoutEnabled,university_country_code==='FI');
 }
});
test('invalid relationships, unsupported countries, publication and prices fail closed',()=>{
 for(const patch of [{id:null},{university_id:null},{country_id:null},{university_country_code:'US'},{university_country_code:'ng'},{application_approved:0},{profile_approved:0},{workflow_state:'DRAFT'},{has_content:0}])assert.equal(R.paymentDecision({...base,...patch},{stripeReady:true}).checkoutEnabled,false);
 for(const price of [null,'','-1','NaN','0.01'])assert.equal(R.paymentDecision({...base,university_country_code:'FI',bundle_price:price},{stripeReady:true}).checkoutEnabled,false);
 assert.equal(R.paymentDecision({...base,university_country_code:'FI'},{stripeReady:false}).checkoutEnabled,false);
});
test('checkout ignores no overrides; requires current context, FI-only and available configuration',async()=>{
 const db={query:async()=>[[{...base,university_country_code:'FI'}]]};
 for(const key of ['currency','provider','amount','country','buyerCountry','entity'])assert.throws(()=>R.checkoutInput({subjectId:123,scholarId:7,[key]:'spoof'}),{code:'CLIENT_PAYMENT_OVERRIDE'});
 const o=await R.requireStripeOffering(db,{subjectId:123,scholarId:7},{stripeReady:true});assert.equal(o.payment.currency,'EUR');
 await assert.rejects(R.requireStripeOffering(db,{subjectId:123,scholarId:7,contextVersion:'old'},{stripeReady:true}),{code:'PAYMENT_CONTEXT_CHANGED'});
 db.query=async()=>[[base]];await assert.rejects(R.requireStripeOffering(db,{subjectId:123,scholarId:7},{stripeReady:true}),{code:'PAYSTACK_CHECKOUT_DISABLED'});
 db.query=async()=>[[base,base]];await assert.rejects(R.offering(db,123,7),{code:'OFFERING_UNAVAILABLE'});
});
test('catalogue metadata uses one bounded batch, rejects duplicate contexts, no provider call',async()=>{
 let calls=0;const rows=[{subject_id:123,scholar_user_id:7},{subject_id:124,scholar_user_id:8}];const db={query:async(q,args)=>{calls++;assert.match(q.sql,/universities u/);assert.equal(q.timeout,10000);return [[base,{...base,id:124,scholar_id:8,university_country_code:'FI'}]];}};
 const result=await R.attachPayments(db,rows,{stripeReady:true});assert.equal(calls,1);assert.equal(result[0].payment.currency,'NGN');assert.equal(result[1].payment.currency,'EUR');
 db.query=async()=>[[base,base]];assert.equal((await R.attachPayments(db,rows))[0].payment.checkoutEnabled,false);
});
test('dormant subject creation requires explicit academic identity and approved FI price; NG inherits fixed policy',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');const file=path.resolve(__dirname,'../src/models/subject.js'),module={exports:{}},real=createRequire(file);let country='NG',inserts=[];
 const pool={query:async(sql,args)=>{if(sql.startsWith('SELECT u.id'))return [[{id:189,code:country}]];inserts.push(args);return [{insertId:123}];}};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:n=>n==='../config/db'?{pool}:real(n)});const M=module.exports.SubjectModel;
 await assert.rejects(M.create('name only'),e=>e.status===400);const input={name:'Future course',degreeProgramme:'Engineering',universityId:189};
 await M.create(input);assert.equal(inserts[0][3],null);country='FI';await assert.rejects(M.create(input));await M.create({...input,approvedEurPrice:'7.00'});assert.equal(inserts[1][3],'7.00');country='US';await assert.rejects(M.create(input));assert.equal(inserts.length,2);
});
