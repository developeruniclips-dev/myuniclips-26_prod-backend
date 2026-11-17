'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto');
const {database}=require('./fixtures/scholarBankMysql.cjs');
let db;test.before(async()=>{db=await database();});test.after(async()=>{await db?.close();});
const confirmed='USE THIS ACCOUNT FOR UNICLIPS PAYOUTS';
test('first registration resolves, explicitly confirms, stores minimal metadata and emails existing account address',async()=>{
 const w=await db.scope(),before=await w.financial(),{c}=await w.setup();
 a.equal(c.accountName,'SYNTHETIC ACCOUNT HOLDER');a.equal(c.accountLast4,'0001');
 const status=await w.service.status(w.user);a(status.destination);a.equal(status.payoutsHeld,true);
 a(!JSON.stringify(status).includes('RCP_'));a(!JSON.stringify(status).includes('0000000001'));
 a.equal(w.state.createCalls,1);a.equal(w.state.mails.length,1);a.equal(w.state.mails[0].email,'fixture'+w.id+'@example.invalid');
 const [[challenge]]=await db.pool.query('SELECT * FROM ng_bank_challenges WHERE id=?',[c.challengeId]);a.equal(challenge.cipher,null);a.equal(challenge.state,'confirmed');
 a.deepEqual(await w.financial(),before);a.equal((await w.service.payoutGuard(w.id)).eligible,false);
});
test('existing destination cannot be replaced through any new resolve/confirm and held earnings stay unchanged',async()=>{
 const w=await db.scope();await w.setup();const before=await w.service.status(w.user),financial=await w.financial(),proof=await w.fresh();
 await a.rejects(w.resolve(proof,'0000000002'),{code:'BANK_ALREADY_REGISTERED'});
 a.deepEqual(await w.service.status(w.user),before);a.deepEqual(await w.financial(),financial);a.equal(w.state.createCalls,1);
});
test('confirmation is mandatory and consumed proof cannot register twice',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:'yes'}),{code:'BANK_CONFIRMATION_REQUIRED'});
 a.equal(w.state.createCalls,0);await w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed});
 a.equal((await w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed})).duplicate,true);a.equal(w.state.createCalls,1);
});
test('concurrent duplicate confirmation has one provider attempt and one immutable destination',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);
 const results=await Promise.allSettled(Array.from({length:8},()=>w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed})));
 a(results.some(r=>r.status==='fulfilled'));a.equal(w.state.createCalls,1);
 const [[n]]=await db.pool.query('SELECT COUNT(*) AS n FROM ng_bank_destinations WHERE scholar_id=?',[w.id]);a.equal(n.n,1);
});
test('lost provider acknowledgement blocks retry and new setup instead of duplicating recipient creation',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);w.state.failCreate=true;
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}),{code:'BANK_RECIPIENT_REVIEW'});
 await a.rejects(w.resolve(await w.fresh()),{code:'BANK_RECIPIENT_REVIEW'});a.equal(w.state.createCalls,1);
 a.equal((await w.service.status(w.user)).destination,null);a.equal((await w.service.status(w.user)).recipientReview,true);
});
test('expired challenges purge encrypted account data and expired proofs cannot be used',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);w.state.time+=601000;await w.service.maintenance();
 const [[r]]=await db.pool.query('SELECT cipher,state FROM ng_bank_challenges WHERE id=?',[c.challengeId]);a.deepEqual(r,{cipher:null,state:'expired'});
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}),{code:'BANK_CHALLENGE_EXPIRED'});a.equal(w.state.createCalls,0);
});
test('provider resolution refusal creates no registration, destination or email',async()=>{
 const w=await db.scope();w.state.failResolve=true;await a.rejects(w.resolve(),{code:'BANK_RESOLUTION_FAILED'});
 a.equal(w.state.createCalls,0);a.equal(w.state.mails.length,0);a.equal((await w.service.status(w.user)).destination,null);
});
test('newer resolve invalidates older challenge and prevents stale account confirmation',async()=>{
 const w=await db.scope(),proof=await w.fresh(),old=await w.resolve(proof);await w.resolve(proof,'0000000002');
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:old.challengeId,confirmation:confirmed}),{code:'BANK_CHALLENGE_EXPIRED'});a.equal(w.state.createCalls,0);
});
test('session rotation, password changes, changed email, revoked Scholar role and foreign country fail closed',async()=>{
 for(const mutation of ["UPDATE users SET refresh_token=CONCAT('sha256:',REPEAT('a',64)) WHERE id=?","UPDATE users SET password='changed' WHERE id=?","UPDATE users SET email='changed@example.invalid' WHERE id=?","DELETE FROM user_roles WHERE user_id=?","UPDATE scholar_profile SET university='Synthetic Finland University (SFI)' WHERE user_id=?"]){
  const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);await db.pool.query(mutation,[w.id]);
  await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}));a.equal(w.state.createCalls,0);
 }
});
test('a different Scholar cannot confirm another account challenge or use its proof',async()=>{
 const first=await db.scope(),other=await db.scope(),proof=await first.fresh(),c=await first.resolve(proof);
 await a.rejects(other.service.confirm(other.user,{proof,challengeId:c.challengeId,confirmation:confirmed}));a.equal(other.state.createCalls,0);
});
test('mail failure retains durable encrypted queue and retry delivers without a second recipient or financial write',async()=>{
 const w=await db.scope(),before=await w.financial();w.state.mailFailure=true;await w.setup();
 a.equal((await w.service.status(w.user)).notificationPending,true);w.state.mailFailure=false;w.state.time+=121000;await w.service.flush();
 a.equal(w.state.mails.length,1);a.equal(w.state.createCalls,1);a.equal((await w.service.status(w.user)).notificationPending,false);a.deepEqual(await w.financial(),before);
});
test('late recipient completion after session revocation is quarantined, never activated',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);let release;w.state.pause=new Promise(r=>release=r);
 const pending=w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed});
 for(let i=0;i<30&&w.state.createCalls===0;i++)await new Promise(r=>setTimeout(r,10));
 a.equal(w.state.createCalls,1);await db.pool.query('UPDATE users SET refresh_token=NULL WHERE id=?',[w.id]);release();await a.rejects(pending);
 const [[p]]=await db.pool.query('SELECT destination_id FROM ng_bank_profiles WHERE scholar_id=?',[w.id]);a.equal(p.destination_id,null);
 const [[r]]=await db.pool.query('SELECT state FROM ng_bank_challenges WHERE id=?',[c.challengeId]);a.equal(r.state,'uncertain');
});
test('SuperAdmin with fresh second factor can quarantine an orphan; Admin cannot approve or activate anything',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);w.state.failCreate=true;
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}));w.state.time+=61000;
 await a.rejects(w.service.operations(w.admin),{code:'BANK_AUTHORITY_REQUIRED'});
 const code=[...w.state.records.keys()][0],ownerProof=await w.fresh(w.owner,'reconcile',c.challengeId);
 a.deepEqual(await w.service.reconcile(w.owner,c.challengeId,{proof:ownerProof,recipientCode:code,note:'Synthetic orphan reviewed and quarantined'}),{reconciled:true,activated:false});
 a.equal((await w.service.status(w.user)).destination,null);await a.rejects(w.service.reconcile(w.owner,c.challengeId,{proof:ownerProof,recipientCode:code,note:'Replay'}));
});
test('five failed password attempts persist lockout and per-account limits do not block another Scholar',async()=>{
 const w=await db.scope();for(let i=0;i<5;i++)await a.rejects(w.service.reauthenticate(w.user,{purpose:'setup',password:'wrong'}));
 const [[u]]=await db.pool.query('SELECT failed_login_attempts,locked_until FROM users WHERE id=?',[w.id]);a.equal(u.failed_login_attempts,5);a(u.locked_until);
 const other=await db.scope();a((await other.fresh()).length===64);
});
test('AES-GCM binds ciphertext to its challenge and HMAC fingerprints do not expose numbers',async()=>{
 const w=await db.scope(),value=w.protect.encrypt({accountNumber:'0000000001'},'challenge:first');
 a(!value.includes('0000000001'));a.throws(()=>w.protect.decrypt(value,'challenge:second'));
 a.equal(w.protect.fingerprint('0000000001').length,64);a.notEqual(w.protect.fingerprint('0000000001'),crypto.createHash('sha256').update('0000000001').digest('hex'));
});
function interruptedPool(pool,{afterInsert=false,lostCommit=false}={}){
 let fired=false;
 return {query:pool.query.bind(pool),async getConnection(){
  const db=await pool.getConnection();let destination=false;
  return new Proxy(db,{get(target,key){
   if(key==='query')return async(sql,args)=>{const result=await db.query(sql,args);if(sql.startsWith('INSERT INTO ng_bank_destinations')){destination=true;if(afterInsert&&!fired){fired=true;throw Error('SYNTHETIC_ROLLBACK_AFTER_INSERT');}}return result;};
   if(key==='commit')return async()=>{await db.commit();if(destination&&lostCommit&&!fired){fired=true;throw Error('SYNTHETIC_LOST_ACK_AFTER_COMMIT');}};
   const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
 }};
}
test('rollback after destination insert preserves all tables and quarantines external recipient without retry',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof),financial=await w.financial();
 const api=w.makeService({pool:interruptedPool(db.pool,{afterInsert:true})});
 await a.rejects(api.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}),/SYNTHETIC_ROLLBACK/);
 a.equal((await w.service.status(w.user)).destination,null);a.equal((await w.service.status(w.user)).recipientReview,true);
 a.equal(w.state.createCalls,1);a.equal(w.state.mails.length,0);a.deepEqual(await w.financial(),financial);
});
test('lost committed acknowledgement replays without a second destination or provider operation',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof),financial=await w.financial();
 const api=w.makeService({pool:interruptedPool(db.pool,{lostCommit:true})});
 await a.rejects(api.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}),/SYNTHETIC_LOST_ACK/);
 a.equal((await w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed})).duplicate,true);
 await w.service.flush();a.equal(w.state.createCalls,1);a.equal(w.state.mails.length,1);a.deepEqual(await w.financial(),financial);
});
test('database enforces recipient uniqueness and profile destination owner binding',async()=>{
 const w=await db.scope(),other=await db.scope();await w.setup();await other.setup();
 const [[d]]=await db.pool.query('SELECT * FROM ng_bank_destinations WHERE scholar_id=?',[w.id]);
 await a.rejects(db.pool.query('UPDATE ng_bank_profiles SET destination_id=? WHERE scholar_id=?',[d.id,other.id]),{code:'ER_NO_REFERENCED_ROW_2'});
 const copy={...d,id:crypto.randomUUID(),operation_id:crypto.randomUUID(),scholar_id:other.id};
 await a.rejects(db.pool.query('INSERT INTO ng_bank_destinations SET ?',copy),{code:'ER_DUP_ENTRY'});
});
test('reauthentication proof expires after five minutes independently of the ten-minute resolution',async()=>{
 const w=await db.scope(),proof=await w.fresh(),c=await w.resolve(proof);w.state.time+=301000;
 await a.rejects(w.service.confirm(w.user,{proof,challengeId:c.challengeId,confirmation:confirmed}),{code:'BANK_REAUTH_REQUIRED'});a.equal(w.state.createCalls,0);
});
test('enrolled Scholar TOTP is required and a consumed TOTP cannot mint a second proof',async()=>{
 const speakeasy=require('speakeasy'),w=await db.scope(),secret=speakeasy.generateSecret({length:20}).base32;
 await db.pool.query('UPDATE users SET two_factor_enabled=1,two_factor_secret=? WHERE id=?',[secret,w.id]);
 const user=await w.claims(w.id),token=speakeasy.totp({secret,encoding:'base32',time:Math.floor(w.state.time/1000)});
 await a.rejects(w.service.reauthenticate(user,{password:'synthetic-password'}),{code:'BANK_REAUTH_FAILED'});
 a((await w.service.reauthenticate(user,{password:'synthetic-password',token})).proof);
 await a.rejects(w.service.reauthenticate(user,{password:'synthetic-password',token}),{code:'BANK_REAUTH_FAILED'});
});
test('reauth limits survive independent runtimes while a different campus Scholar stays admitted',async()=>{
 const w=await db.scope();for(let i=0;i<5;i++)await w.fresh();
 await a.rejects(w.makeService().reauthenticate(w.user,{password:'synthetic-password'}),{code:'BANK_RATE_LIMIT'});
 const other=await db.scope();a(await other.fresh());
});
test('a shared account already registered by another Scholar requires review before another recipient POST',async()=>{
 const w=await db.scope(),other=await db.scope();await w.setup();
 const api=other.makeService({protection:w.protect}),proof=await other.fresh();
 await a.rejects(api.resolve(other.user,{bankCode:'999',accountNumber:'0000000001',proof}),{code:'BANK_DESTINATION_REVIEW'});
 a.equal(other.state.createCalls,0);
});
test('undeliverable mailbox ciphertext is erased after the bounded retention period',async()=>{
 const w=await db.scope();w.state.mailFailure=true;await w.setup();w.state.time+=31*86400000;await w.service.maintenance();
 const [[m]]=await db.pool.query('SELECT state,cipher FROM ng_bank_mail WHERE scholar_id=?',[w.id]);
 a.deepEqual(m,{state:'review',cipher:null});a.equal(w.state.createCalls,1);
});
