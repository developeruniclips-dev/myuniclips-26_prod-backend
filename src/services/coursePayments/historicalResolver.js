'use strict';
const {createHash,verify}=require('node:crypto');
const {toMinor,allocation}=require('../payments/money');
const deny=code=>{throw Object.assign(new Error('Historical sale review required'),{code,status:409});};
const integer=n=>{if(!/^\d+$/.test(String(n))||!Number.isSafeInteger(Number(n)))deny('INVALID_PROOF_NUMBER');return Number(n);};
function fact(r){return [integer(r.purchase_id),integer(r.subject_id),integer(r.scholar_id),integer(r.sale_ordinal),r.provider,r.entity,r.merchant_account,r.environment,r.provider_reference,r.currency,integer(r.gross_minor),integer(r.scholar_rate),integer(r.scholar_minor),r.source_kind,r.source_key,r.evidence_digest,r.provider_transaction_id];}
function digest(rows){return createHash('sha256').update(JSON.stringify([...rows].sort((a,b)=>Number(a.sale_ordinal)-Number(b.sale_ordinal)).map(fact))).digest('hex');}
function validateFacts(rows,scope){
 if(!Array.isArray(rows)||rows.length>10000)deny('BASELINE_REVIEW_REQUIRED');
 const purchases=new Set(),references=new Set(),transactions=new Set();
 [...rows].sort((a,b)=>Number(a.sale_ordinal)-Number(b.sale_ordinal)).forEach((r,i)=>{
  const f=fact(r),rate=i<100?70:50,key=JSON.stringify([r.provider,r.merchant_account,r.environment,r.provider_reference]),transaction=JSON.stringify([r.provider,r.merchant_account,r.environment,r.provider_transaction_id]);
  if(f[0]<1||f[1]!==scope.subjectId||f[2]!==scope.scholarId||f[3]!==i+1||purchases.has(f[0])||references.has(key)||transactions.has(transaction))deny('BASELINE_ORDINAL_CONFLICT');
  if(typeof r.provider_transaction_id!=='string'||!r.provider_transaction_id||typeof r.source_key!=='string'||!r.source_key)deny('INVALID_SALE_PROOF');
  if(!['stripe','paystack'].includes(r.provider)||!['EUR','NGN'].includes(r.currency)||!['test','live'].includes(r.environment)||!r.entity||!r.merchant_account||!r.provider_reference||!/^[a-f0-9]{64}$/.test(r.evidence_digest)||f[10]<=0||f[11]!==rate||f[12]!==allocation(f[10],f[3]).scholar)deny('INVALID_SALE_PROOF');
  if(r.provider==='paystack'&&(r.currency!=='NGN'||f[10]!==150000||r.entity!=='UNICLIPS_NIGERIA_LIMITED'||r.source_kind!=='paystack_ng'))deny('INVALID_NG_PROOF');
  if(r.provider==='stripe'&&(r.currency!=='EUR'||!['legacy_verified','phase2a','audited_opening'].includes(r.source_kind)))deny('INVALID_STRIPE_PROOF');
  purchases.add(f[0]);references.add(key);transactions.add(transaction);
 });return rows;
}
async function auditedFacts(db,scope){
 const [audits]=await db.query('SELECT * FROM course_sale_audits WHERE subject_id=? AND scholar_id=? ORDER BY review_version DESC LIMIT 1',[scope.subjectId,scope.scholarId]);
 const audit=audits[0];
 const [rows]=await db.query('SELECT * FROM course_sale_proofs WHERE subject_id=? AND scholar_id=? ORDER BY sale_ordinal LIMIT 10001',[scope.subjectId,scope.scholarId]);
 return validateAudit(audit,rows,scope);
}
function validateAudit(audit,rows,scope){
 if(!audit||audit.state!=='approved'||audit.writer_mode!=='legacy_verified')deny('BASELINE_AUDIT_REQUIRED');
 validateFacts(rows,scope);const count=integer(audit.baseline_count);
 if(rows.length<count||digest(rows.slice(0,count))!==audit.baseline_digest)deny('BASELINE_AUDIT_MISMATCH');
 return {audit,rows};
}
async function resolveHistoricalSales(db,purchases,scope){
 const {rows}=await auditedFacts(db,scope),byId=new Map(rows.map(r=>[integer(r.purchase_id),r]));
 return purchases.map(p=>{const r=byId.get(p.id);if(!r||r.provider_reference!==p.transactionId||r.currency!==p.currency||integer(r.gross_minor)!==p.amountMinor)deny('BASELINE_VERIFICATION_REQUIRED');
  return {purchaseId:p.id,verified:true,provenance:r.source_kind+':'+r.evidence_digest,provider:r.provider,reference:r.provider_reference,currency:r.currency,amountMinor:integer(r.gross_minor),ordinal:integer(r.sale_ordinal)};
 });
}
// Explicit offline importer. No startup import, environment loading or DB creation.
// A signed owner review AND an independently supplied source verifier are required.
function createAuditImporter({pool,publicKey,verifyProvenance,validateScope}={}){
 const verifySource=require('./historicalSources').createStoredSourceVerifier({verifyProvenance});
 return async envelope=>{
 if(!pool||!publicKey||typeof verifyProvenance!=='function'||typeof envelope?.payload!=='string'||envelope.payload.length>8000000||!verify(null,Buffer.from(envelope.payload),publicKey,Buffer.from(envelope.signature||'','base64')))deny('SIGNED_AUDIT_REQUIRED');
 const batch=JSON.parse(envelope.payload),scope={subjectId:integer(batch.subjectId),scholarId:integer(batch.scholarId)};
 validateFacts(batch.facts,scope);if(batch.writerMode!=='legacy_verified'||!Number.isSafeInteger(batch.reviewVersion)||batch.reviewVersion<1||!batch.reviewId||!batch.sourceRevision)deny('INVALID_AUDIT');
 const db=await pool.getConnection();let started=false,destroyed=false,pendingIsolation=false;
 try{const [[zone]]=await db.query('SELECT @@session.time_zone AS zone');if(!['UTC','+00:00'].includes(zone.zone))deny('UTC_SESSION_REQUIRED');pendingIsolation=true;await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');await db.beginTransaction();started=true;pendingIsolation=false;
  const [subjects]=await db.query('SELECT id FROM subjects WHERE id=? FOR UPDATE NOWAIT',[scope.subjectId]);if(subjects.length!==1)deny('INVALID_AUDIT_SCOPE');
  if(validateScope!==undefined){if(typeof validateScope!=='function')deny('INVALID_SCOPE_VALIDATOR');if(await validateScope(db,Object.freeze({...scope}))===false)deny('INVALID_AUDIT_SCOPE');}
  const [purchases]=await db.query('SELECT * FROM subject_purchases WHERE subject_id=? AND scholar_id=? ORDER BY id LIMIT 10001',[scope.subjectId,scope.scholarId]);
  if(purchases.length!==batch.facts.length)deny('AUDIT_PURCHASE_CENSUS_MISMATCH');
  for(const p of purchases){const r=batch.facts.find(f=>Number(f.purchase_id)===Number(p.id));if(!r||r.provider_reference!==p.transaction_id||r.currency!==p.currency||integer(r.gross_minor)!==toMinor(p.amount,p.currency)||!await verifySource(db,Object.freeze({...r}),Object.freeze({...p})))deny('AUDIT_SOURCE_UNVERIFIED');}
  const [existing]=await db.query('SELECT * FROM course_sale_proofs WHERE subject_id=? AND scholar_id=? ORDER BY sale_ordinal LIMIT 10001',[scope.subjectId,scope.scholarId]);
  if(existing.some(r=>digest([r])!==digest(batch.facts.filter(f=>Number(f.purchase_id)===Number(r.purchase_id)))))deny('AUDIT_PROOF_CONFLICT');
  await db.query("INSERT INTO course_sale_audits (subject_id,scholar_id,review_version,baseline_count,baseline_digest,source_revision,review_id,writer_mode,state) VALUES (?,?,?,?,?,?,?,'legacy_verified','approved')",[scope.subjectId,scope.scholarId,batch.reviewVersion,batch.facts.length,digest(batch.facts),batch.sourceRevision,batch.reviewId]);
  const present=new Set(existing.map(r=>Number(r.purchase_id)));
  for(const r of batch.facts)if(!present.has(Number(r.purchase_id)))await appendProof(db,r,batch.reviewVersion);
  await db.commit();started=false;return {count:batch.facts.length,digest:digest(batch.facts)};
 }catch(e){if(started){try{await db.rollback();}catch{destroyed=true;db.destroy();throw Object.assign(new Error('Audit transaction uncertain'),{code:'AUDIT_TRANSACTION_UNCERTAIN'});}}if(pendingIsolation){destroyed=true;db.destroy();}throw e;}finally{if(!destroyed)db.release();}
};}
async function appendProof(db,r,version){await db.query(`INSERT INTO course_sale_proofs (purchase_id,subject_id,scholar_id,sale_ordinal,provider,entity,merchant_account,environment,provider_reference,currency,gross_minor,scholar_rate,scholar_minor,source_kind,source_key,evidence_digest,provider_transaction_id,review_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[...fact(r),version]);}
module.exports={integer,digest,validateFacts,validateAudit,auditedFacts,resolveHistoricalSales,appendProof,createAuditImporter};
