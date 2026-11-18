'use strict';
const S=require('./security'),A=require('../../utils/authSecurity');
const {verifyPassword}=require('../../utils/passwordHasher');
const {sharedAuthAdmission}=require('../../middleware/authAdmission');

function createService({pool,provider,protection,sendMail,merchant,environment,clock=()=>new Date(),passwordVerifier=verifyPassword}){
 const now=()=>new Date(clock()),plus=ms=>new Date(now().getTime()+ms);
 const one=async(db,sql,args=[])=>(await db.query(sql,args))[0][0];
 async function tx(work){
  const db=await pool.getConnection();
  try{await db.beginTransaction();const value=await work(db);await db.commit();return value;}
  catch(e){try{await db.rollback();}catch{}throw e;}finally{db.release();}
 }
 async function actor(db,claims){
  const u=await one(db,'SELECT *,refresh_token_expires>UTC_TIMESTAMP() AS refresh_valid,TIMESTAMPDIFF(SECOND,last_activity,UTC_TIMESTAMP()) AS idle_seconds,locked_until>UTC_TIMESTAMP() AS account_locked FROM users WHERE id=? FOR UPDATE',[claims.id]);
  const configured=Number(process.env.SESSION_TIMEOUT_MINUTES||30);
  const idle=Number.isFinite(configured)&&configured>0&&configured<=1440?configured:30;
  if(!u||!/^sha256:[a-f0-9]{64}$/.test(u.refresh_token||'')||!u.refresh_valid||u.account_locked||u.idle_seconds==null||Number(u.idle_seconds)>idle*60||!A.equalHex(claims.session,A.credentialBinding(u)))
   S.fail(401,'BANK_SESSION_EXPIRED','Sign in again before managing payout details');
  const [roles]=await db.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[u.id]);
  return {...u,roles:roles.map(r=>r.name),sessionHash:S.hash(claims.session),emailHash:S.hash(u.email)};
 }
 async function scholar(db,a){
  const [rows]=await db.query(
   'SELECT c.code FROM scholar_profile sp JOIN universities u ON '+
   '(CONVERT(sp.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONVERT(u.name USING utf8mb4) COLLATE utf8mb4_unicode_ci '+
   "OR CONVERT(sp.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONVERT(CONCAT(u.name,' (',u.short_name,')') USING utf8mb4) COLLATE utf8mb4_unicode_ci) "+
   'JOIN countries c ON c.id=u.country_id WHERE sp.user_id=? AND sp.approved=1',[a.id]);
  if(!a.roles.includes('Scholar')||rows.length!==1||rows[0].code!=='NG')
   S.fail(403,'BANK_SCHOLAR_REQUIRED','Payout bank details are available to approved Nigerian Scholars');
 }
 async function run(claims,work,{owner=false,rate,max=20}={}){
  const result=await tx(async db=>{
   const a=await actor(db,claims);
   if(owner){if(!a.roles.includes('SuperAdmin'))S.fail(403,'BANK_AUTHORITY_REQUIRED','SuperAdmin access is required');}
   else await scholar(db,a);
   if(rate){
    const bucket=Math.floor(now().getTime()/600000);
    await db.query('INSERT INTO ng_bank_limits(actor_id,action,bucket,attempts) VALUES(?,?,?,1) ON DUPLICATE KEY UPDATE attempts=attempts+1',[a.id,rate,bucket]);
    const r=await one(db,'SELECT attempts FROM ng_bank_limits WHERE actor_id=? AND action=? AND bucket=?',[a.id,rate,bucket]);
    if(Number(r.attempts)>max)return {failure:'rate'};
   }
   return work(db,a);
  });
  if(result?.failure==='rate')S.fail(429,'BANK_RATE_LIMIT','Too many attempts. Wait ten minutes before trying again');
  if(result?.failure==='proof')S.fail(403,'BANK_REAUTH_FAILED','Password or second factor could not be verified');
  return result;
 }
 async function profile(db,id){
  await db.query('INSERT IGNORE INTO ng_bank_profiles(scholar_id,merchant,environment,created_at,updated_at) VALUES(?,?,?,?,?)',[id,merchant,environment,now(),now()]);
  const p=await one(db,'SELECT * FROM ng_bank_profiles WHERE scholar_id=? FOR UPDATE',[id]);
  if(p.merchant!==merchant||p.environment!==environment)S.fail(409,'BANK_PROFILE_SCOPE','Payout destination scope needs review');
  return p;
 }
 async function initialOnly(db,p){
  if(p.destination_id)S.fail(409,'BANK_ALREADY_REGISTERED','Your payout account is already registered. Contact support about any required change.');
  if(await one(db,"SELECT id FROM ng_bank_challenges WHERE scholar_id=? AND state IN ('creating','uncertain') LIMIT 1",[p.scholar_id]))
   S.fail(409,'BANK_RECIPIENT_REVIEW','An earlier recipient operation needs security review. Do not submit again.');
 }
 async function event(db,actorId,scholarId,action,details={}){
  await db.query('INSERT INTO ng_bank_events(scholar_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?)',[scholarId,actorId,action,JSON.stringify(details),now()]);
 }
 async function proof(db,a,token,purpose='setup',target='',consume=false){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))S.fail(403,'BANK_REAUTH_REQUIRED','Confirm your password and enrolled second factor first');
  const p=await one(db,'SELECT * FROM ng_bank_proofs WHERE token_hash=? FOR UPDATE',[S.hash(token)]);
  if(!p||p.actor_id!==a.id||p.session_hash!==a.sessionHash||p.email_hash!==a.emailHash||p.purpose!==purpose||p.target!==target||p.used_at||new Date(p.expires_at)<=now())
   S.fail(403,'BANK_REAUTH_REQUIRED','Fresh authentication expired or does not match this action');
  if(consume)await db.query('UPDATE ng_bank_proofs SET used_at=? WHERE token_hash=?',[now(),S.hash(token)]);
 }
 async function reauthenticate(claims,input){
  const purpose=input.purpose||'setup',target=input.target||'';
  if(!['setup','reconcile'].includes(purpose)||typeof target!=='string'||target.length>64||!A.passwordInput(input.password))
   S.fail(400,'BANK_INPUT_INVALID','Invalid authentication request');
  return sharedAuthAdmission.run(()=>run(claims,async(db,a)=>{
   const verified=await passwordVerifier(input.password,a.password);let valid=verified.valid;
   if(Number(a.two_factor_enabled)===1){
    const state=A.factorState(a.two_factor_backup_codes);
    valid=valid&&A.consumeFactor(a,state,{token:input.token,backupCode:input.backupCode},now().getTime());
    if(valid)await db.query('UPDATE users SET two_factor_backup_codes=? WHERE id=?',[JSON.stringify(state),a.id]);
   }
   if(!valid){
    await db.query('UPDATE users SET locked_until=CASE WHEN COALESCE(failed_login_attempts,0)>=4 THEN DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE) ELSE locked_until END,failed_login_attempts=COALESCE(failed_login_attempts,0)+1,last_failed_login=UTC_TIMESTAMP() WHERE id=?',[a.id]);
    return {failure:'proof'};
   }
   if(purpose==='reconcile'&&Number(a.two_factor_enabled)!==1)S.fail(403,'BANK_SECOND_FACTOR_REQUIRED','Enable two-factor authentication before reviewing recipient registration');
   const token=S.opaque(),expires=plus(300000);
   await db.query('INSERT INTO ng_bank_proofs(token_hash,actor_id,session_hash,email_hash,purpose,target,expires_at) VALUES(?,?,?,?,?,?,?)',[S.hash(token),a.id,a.sessionHash,a.emailHash,purpose,target,expires]);
   return {proof:token,expiresAt:expires};
  },{owner:purpose==='reconcile',rate:'reauth',max:5}));
 }
 async function status(claims){
  return run(claims,async(db,a)=>{
   const p=await profile(db,a.id),d=p.destination_id?await one(db,'SELECT * FROM ng_bank_destinations WHERE id=?',[p.destination_id]):null;
   const operation=await one(db,"SELECT id FROM ng_bank_challenges WHERE scholar_id=? AND state IN ('creating','uncertain') LIMIT 1",[a.id]);
   const mail=await one(db,"SELECT id FROM ng_bank_mail WHERE scholar_id=? AND state<>'sent' LIMIT 1",[a.id]);
   return {enabled:true,destination:d?{bankName:d.bank_name,accountLast4:d.account_last4,accountNameMasked:d.account_name_masked,createdAt:d.created_at}:null,
    recipientReview:!!operation,notificationPending:!!mail,payoutsHeld:true,bankRequiredOnlyBeforePayout:true};
  });
 }
 async function banks(claims){
  await run(claims,async()=>true,{rate:'banks',max:30});
  return provider.banks();
 }
 async function resolve(claims,input){
  S.accountInput(input.bankCode,input.accountNumber);
  const expected=await run(claims,async(db,a)=>{
   const p=await profile(db,a.id);await initialOnly(db,p);await proof(db,a,input.proof);
   return {revision:p.revision,session:a.sessionHash,email:a.emailHash};
  },{rate:'resolve',max:5});
  const list=await provider.banks(),bank=list.find(b=>b.code===input.bankCode);
  if(!bank)S.fail(400,'BANK_INPUT_INVALID','Choose an available Nigerian bank');
  const resolved=await provider.resolve(input.bankCode,input.accountNumber),id=S.uuid();
  const fingerprint=protection.fingerprint(environment+':'+merchant+':'+bank.code+':'+resolved.accountNumber);
  return run(claims,async(db,a)=>{
   const p=await profile(db,a.id);await initialOnly(db,p);await proof(db,a,input.proof);
   if(p.revision!==expected.revision||a.sessionHash!==expected.session||a.emailHash!==expected.email)
    S.fail(409,'BANK_STATE_CHANGED','Payout security state changed. Start again.');
   if(await one(db,'SELECT id FROM ng_bank_destinations WHERE merchant=? AND environment=? AND fingerprint=? LIMIT 1',[merchant,environment,fingerprint]))
    S.fail(409,'BANK_DESTINATION_REVIEW','This payout destination needs support review before registration.');
   await db.query("UPDATE ng_bank_challenges SET state='cancelled',cipher=NULL WHERE scholar_id=? AND state='resolved'",[a.id]);
   await db.query("INSERT INTO ng_bank_challenges(id,scholar_id,profile_revision,session_hash,email_hash,state,cipher,fingerprint,bank_code,bank_name,account_last4,account_name_masked,created_at,expires_at) VALUES(?,?,?,?,?,'resolved',?,?,?,?,?,?,?,?)",
    [id,a.id,p.revision,a.sessionHash,a.emailHash,protection.encrypt(resolved,'challenge:'+id),fingerprint,bank.code,bank.name,resolved.accountNumber.slice(-4),S.maskedName(resolved.accountName),now(),plus(600000)]);
   await event(db,a.id,a.id,'account_resolved',{challenge:id});
   return {challengeId:id,bankName:bank.name,accountName:resolved.accountName,accountLast4:resolved.accountNumber.slice(-4),expiresAt:plus(600000)};
  });
 }
 async function uncertain(id){
  await pool.query("UPDATE ng_bank_challenges SET state='uncertain' WHERE id=? AND state='creating'",[id]);
 }
 async function confirm(claims,input){
  if(input.confirmation!=='USE THIS ACCOUNT FOR UNICLIPS PAYOUTS')S.fail(400,'BANK_CONFIRMATION_REQUIRED','Explicitly confirm this payout account');
  const reserved=await run(claims,async(db,a)=>{
   const p=await profile(db,a.id);
   const c=await one(db,'SELECT * FROM ng_bank_challenges WHERE id=? AND scholar_id=? FOR UPDATE',[input.challengeId||'',a.id]);
   if(c?.state==='confirmed')return {already:true};
   await initialOnly(db,p);
   if(!c||c.state!=='resolved'||c.email_hash!==a.emailHash||c.session_hash!==a.sessionHash||c.profile_revision!==p.revision||new Date(c.expires_at)<=now())
    S.fail(409,'BANK_CHALLENGE_EXPIRED','Bank verification expired or changed. Start again.');
   await proof(db,a,input.proof,'setup','',true);
   const details=protection.decrypt(c.cipher,'challenge:'+c.id);
   await db.query("UPDATE ng_bank_challenges SET state='creating' WHERE id=?",[c.id]);
   await event(db,a.id,a.id,'recipient_registration_started',{challenge:c.id});
   return {c,details};
  },{rate:'confirm',max:10});
  if(reserved.already)return {confirmed:true,duplicate:true};
  const {c,details}=reserved;let code;
  try{code=await provider.create({...details,bankCode:c.bank_code,operationId:c.id});}
  catch{await uncertain(c.id);S.fail(502,'BANK_RECIPIENT_REVIEW','Recipient registration needs security review. Do not resubmit.');}
  try{
   const result=await run(claims,async(db,a)=>{
    const p=await profile(db,a.id),current=await one(db,'SELECT * FROM ng_bank_challenges WHERE id=? FOR UPDATE',[c.id]);
    if(p.destination_id||p.revision!==c.profile_revision||current.state!=='creating'||current.email_hash!==a.emailHash||current.session_hash!==a.sessionHash||new Date(c.expires_at)<=now())
     S.fail(409,'BANK_STATE_CHANGED','Payout security state changed during registration');
    const id=S.uuid();
    await db.query('INSERT INTO ng_bank_destinations(id,scholar_id,merchant,environment,recipient_code,bank_code,bank_name,account_last4,account_name_masked,fingerprint,operation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
     [id,a.id,merchant,environment,code,c.bank_code,c.bank_name,c.account_last4,c.account_name_masked,c.fingerprint,c.id,now()]);
    await db.query('UPDATE ng_bank_profiles SET destination_id=?,revision=revision+1,updated_at=? WHERE scholar_id=? AND destination_id IS NULL',[id,now(),a.id]);
    await db.query("UPDATE ng_bank_challenges SET state='confirmed',cipher=NULL,recipient_code=? WHERE id=?",[code,c.id]);
    const mailId=S.uuid();
    await db.query("INSERT INTO ng_bank_mail(id,scholar_id,kind,cipher,state,next_attempt,created_at) VALUES(?,?,'registered',?,'pending',?,?)",
     [mailId,a.id,protection.encrypt({email:a.email},'mail:'+mailId),now(),now()]);
    await event(db,a.id,a.id,'destination_registered',{destination:id,challenge:c.id});
    return {confirmed:true};
   });
   await flush();return result;
  }catch(e){await uncertain(c.id);throw e;}
 }
 async function flush(limitCount=10){
  for(let i=0;i<limitCount;i++){
   const item=await tx(async db=>{
    const r=await one(db,"SELECT * FROM ng_bank_mail WHERE ((state='pending' AND next_attempt<=?) OR (state='sending' AND lease_until<=?)) AND attempts<12 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",[now(),now()]);
    if(!r)return null;
    await db.query("UPDATE ng_bank_mail SET state='sending',attempts=attempts+1,lease_until=? WHERE id=?",[plus(60000),r.id]);return r;
   });
   if(!item)break;
   try{
    const payload=protection.decrypt(item.cipher,'mail:'+item.id);
    await sendMail({...payload,id:item.id,kind:item.kind});
    await pool.query("UPDATE ng_bank_mail SET state='sent',cipher=NULL,sent_at=?,lease_until=NULL WHERE id=?",[now(),item.id]);
   }catch{
    await pool.query("UPDATE ng_bank_mail SET state=IF(attempts>=12,'review','pending'),next_attempt=?,lease_until=NULL WHERE id=? AND state='sending'",
     [plus(60000*Math.min(60,2**Math.min(6,item.attempts))),item.id]);
   }
  }
 }
 async function operations(claims){
  return run(claims,async db=>{
   const [operations]=await db.query("SELECT id,scholar_id,state,bank_name,account_last4,created_at FROM ng_bank_challenges WHERE state IN ('creating','uncertain') ORDER BY created_at LIMIT 50");
   const [mail]=await db.query("SELECT id,scholar_id,state,attempts FROM ng_bank_mail WHERE state<>'sent' ORDER BY created_at LIMIT 50");
   return {operations,mail};
  },{owner:true});
 }
 async function reconcile(claims,id,input){
  const c=await run(claims,async(db,a)=>{
   await proof(db,a,input.proof,'reconcile',id,true);
   const c=await one(db,'SELECT * FROM ng_bank_challenges WHERE id=? FOR UPDATE',[id]);
   if(!c||!['uncertain','creating'].includes(c.state)||new Date(c.created_at).getTime()>now().getTime()-60000)
    S.fail(409,'BANK_RECONCILE_STATE','Only an unresolved recipient operation older than one minute can be reconciled');
   if(a.id===c.scholar_id)S.fail(403,'BANK_SELF_APPROVAL','A different SuperAdmin must review this operation');
   await event(db,a.id,c.scholar_id,'recipient_reconciliation_started',{challenge:id});return c;
  },{owner:true});
  const data=await provider.inspect(input.recipientCode);
  const number=String(data.details?.account_number||'');
  provider.checkRecipient(data,{bankCode:c.bank_code,accountNumber:number,accountName:data.name||''});
  if(protection.fingerprint(environment+':'+merchant+':'+c.bank_code+':'+number)!==c.fingerprint||data.metadata?.uniclips_bank_operation!==c.id)
   S.fail(409,'BANK_RECIPIENT_MISMATCH','Provider identity does not match this unresolved operation');
  return run(claims,async(db,a)=>{
   const p=await profile(db,c.scholar_id),current=await one(db,'SELECT * FROM ng_bank_challenges WHERE id=? FOR UPDATE',[id]);
   if(p.destination_id||p.revision!==c.profile_revision||!['uncertain','creating'].includes(current.state))
    S.fail(409,'BANK_STATE_CHANGED','Payout details changed during review');
   // Quarantine the orphan. This NEVER creates/activates/replaces a destination.
   await db.query("UPDATE ng_bank_challenges SET state='cancelled',cipher=NULL,recipient_code=? WHERE id=?",[data.recipient_code,id]);
   await event(db,a.id,c.scholar_id,'recipient_reconciled_quarantined',{challenge:id,note:S.bounded(input.note,2000,true)});
   return {reconciled:true,activated:false};
  },{owner:true});
 }
 async function maintenance(){
  await pool.query("UPDATE ng_bank_challenges SET cipher=NULL,state=CASE WHEN state='resolved' THEN 'expired' WHEN state='creating' THEN 'uncertain' ELSE state END WHERE expires_at<=? AND (cipher IS NOT NULL OR state='creating')",[now()]);
  await pool.query('DELETE FROM ng_bank_proofs WHERE expires_at<?',[plus(-86400000)]);
  await pool.query('DELETE FROM ng_bank_limits WHERE bucket<?',[Math.floor(now().getTime()/600000)-144]);
  // Queue metadata remains for incident review; undeliverable mailbox ciphertext
  // has a bounded lifetime. Never retain full bank details in the mail payload.
  await pool.query("UPDATE ng_bank_mail SET state='review',cipher=NULL WHERE created_at<? AND state<>'sent'",[plus(-30*86400000)]);
  await flush();
 }
 async function payoutGuard(scholarId){
  return tx(async db=>{
   const p=await profile(db,scholarId);
   // Deliberately never eligible. Future separately approved payouts must snapshot
   // immutable destination id + revision, and check all security holds atomically.
   return {eligible:false,reason:p.destination_id?'PAYOUTS_HELD':'BANK_DETAILS_REQUIRED',destinationId:p.destination_id,revision:p.revision};
  });
 }
 return {reauthenticate,status,banks,resolve,confirm,flush,maintenance,operations,reconcile,payoutGuard};
}
module.exports={createService};
