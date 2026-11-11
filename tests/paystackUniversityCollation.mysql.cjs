'use strict';
// Disposable fixture only. Match the recorded production column collations;
// do not change any hosted database, source schema or real account.
const assert=require('node:assert/strict');
module.exports=async({pool,exec,test,scope,store,report,input})=>{
 assert.match(input.database,/^paystack_ng_phase2d_test_[a-f0-9]{12}$/,'Owned disposable fixture database required');
 await exec('ALTER TABLE universities MODIFY name VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci, MODIFY short_name VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
 await exec('ALTER TABLE scholar_profile MODIFY university VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci, MODIFY degree VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
 await exec('ALTER TABLE subjects MODIFY degree_programmes VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
 const sc=await scope();const [[application]]=await pool.query('SELECT id FROM scholar_subjects WHERE subject_id=? AND scholar_user_id=7',[sc.subjectId]);sc.offeringId=Number(application.id);const offer=()=>store().transaction(tx=>tx.offering(sc.subjectId,7,'fixture_merchant','live'));
 await test('original university column comparison reproduces production ER_CANT_AGGREGATE_2COLLATIONS',async()=>{await assert.rejects(pool.query('SELECT sp.university=u.name AS matched FROM scholar_profile sp JOIN universities u ON u.id=2 WHERE sp.user_id=7'),e=>e.code==='ER_CANT_AGGREGATE_2COLLATIONS');});
 await test('unchanged approved NG offering is eligible with production mixed collations',async()=>{const o=await offer();assert.equal(o.currency,'NGN');assert.equal(o.totalMinor,150000);assert.equal(o.countryCode,'NG');});
 await test('full university name and name plus abbreviation remain accepted',async()=>{for(const name of ['Fixture NG University','Fixture NG University (FNG)']){await exec('UPDATE scholar_profile SET university=? WHERE user_id=7',[name]);assert.equal((await offer()).totalMinor,150000);}});
 await test('wrong university remains blocked without weakening the academic check',async()=>{await exec("UPDATE scholar_profile SET university='Different University' WHERE user_id=7");await assert.rejects(offer(),e=>e.code==='OFFERING_UNAVAILABLE');await exec("UPDATE scholar_profile SET university='Fixture NG University (FNG)' WHERE user_id=7");});
 await test('wrong degree remains blocked',async()=>{await exec("UPDATE scholar_profile SET degree='Different Programme' WHERE user_id=7");await assert.rejects(offer(),e=>e.code==='OFFERING_UNAVAILABLE');await exec("UPDATE scholar_profile SET degree='Engineering' WHERE user_id=7");});
 await test('unpublished offering remains blocked',async()=>{await exec("UPDATE course_workflows SET state='DRAFT' WHERE offering_id=?",[sc.offeringId]);await assert.rejects(offer(),e=>e.code==='OFFERING_UNAVAILABLE');await exec("UPDATE course_workflows SET state='PUBLISHED' WHERE offering_id=?",[sc.offeringId]);});
 await test('unapproved profile remains blocked',async()=>{await exec('UPDATE scholar_profile SET approved=0 WHERE user_id=7');await assert.rejects(offer(),e=>e.code==='OFFERING_UNAVAILABLE');await exec('UPDATE scholar_profile SET approved=1 WHERE user_id=7');});
 await test('unapproved application remains blocked',async()=>{await exec('UPDATE scholar_subjects SET approved=0 WHERE id=?',[sc.offeringId]);await assert.rejects(offer(),e=>e.code==='OFFERING_UNAVAILABLE');await exec('UPDATE scholar_subjects SET approved=1 WHERE id=?',[sc.offeringId]);});
 await test('offering inspection preserves the seeded audit and creates no order, purchase, ordinal or allocation',async()=>{for(const table of ['paystack_ng_orders','subject_purchases','paystack_ng_allocations','paystack_ng_sale_counters','course_sale_audits','course_sale_proofs']){const [[r]]=await pool.query('SELECT COUNT(*) AS n FROM '+table);assert.equal(Number(r.n),table==='course_sale_audits'?1:0,table);}});
 report.observations.productionCollationRegression=true;report.observations.hostedDatabaseConnections=0;report.observations.providerRequests=0;
};
