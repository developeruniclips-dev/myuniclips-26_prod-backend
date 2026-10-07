// Existing users columns only. One live account session; no DDL or schema fallback.
const crypto=require('node:crypto'),jwt=require('jsonwebtoken');
const {pool}=require('../config/db');
const {hashPassword,verifyPassword}=require('../utils/passwordHasher');
const S=require('../utils/authSecurity');
const {userResponse,scholarProfileResponse}=require('../utils/userResponses');
const denied=()=>({status:401,body:{message:'Invalid credentials or verification code'}});
async function transaction(work){
 const db=await pool.getConnection();
 try{await db.beginTransaction();const result=await work(db);await db.commit();return result;}
 catch(error){try{await db.rollback();}catch{}throw error;}finally{db.release();}
}
async function rolesFor(db,id){const[rows]=await db.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[id]);return rows.map(r=>r.name);}
async function failedAttempt(db,user){
 await db.query('UPDATE users SET locked_until = CASE WHEN COALESCE(failed_login_attempts,0) >= 4 THEN DATE_ADD(NOW(), INTERVAL 15 MINUTE) ELSE locked_until END, failed_login_attempts = COALESCE(failed_login_attempts,0)+1, last_failed_login=NOW() WHERE id=?',[user.id]);
}
async function session(db,user,roles,{expiry=null}={}){
 const raw=crypto.randomBytes(64).toString('hex'),verifier=S.refreshVerifier(raw);
 await db.query('UPDATE users SET refresh_token=?, refresh_token_expires=COALESCE(?, DATE_ADD(NOW(), INTERVAL 30 DAY)), last_login=NOW(), last_activity=NOW(), failed_login_attempts=0, locked_until=NULL WHERE id=?',[verifier,expiry,user.id]);
 const current={...user,refresh_token:verifier};
 return{token:S.signAccess(current,roles),refreshToken:raw,expiresIn:S.ACCESS_SECONDS};
}
async function loginPayload(db,user){
 const roles=await rolesFor(db,user.id);
 // Preserve the existing legacy Scholar flag/role repair, never privileged roles.
 if(user.isScholar===1&&!roles.includes('Scholar')){await db.query('INSERT IGNORE INTO user_roles (user_id,role_id) VALUES (?,3)',[user.id]);roles.push('Scholar');}
 let scholar=null;
 if(roles.includes('Scholar')){const[rows]=await db.query('SELECT * FROM scholar_profile WHERE user_id=?',[user.id]);scholar=rows[0]||null;}
 return{status:200,body:{message:'Login successful',user:userResponse(user),roles,scholarProfile:scholarProfileResponse(scholar),...await session(db,user,roles)}};
}
async function passwordLogin(email,password){
 return transaction(async db=>{
  const[[user]]=await db.query('SELECT *, locked_until>NOW() AS account_locked FROM users WHERE email=? FOR UPDATE',[email]);
  if(!user)return denied();
  if(user.account_locked)return denied();
  const proof=await verifyPassword(password,user.password);
  if(!proof.valid){await failedAttempt(db,user);return denied();}
  if(proof.needsRehash){user.password=await hashPassword(password);await db.query('UPDATE users SET password=? WHERE id=?',[user.password,user.id]);}
  if(Number(user.two_factor_enabled)===1){
   if(!/^[A-Z2-7]{16,128}$/.test(user.two_factor_secret||''))throw Error('Second factor unavailable');
   const state=S.factorState(user.two_factor_backup_codes),jti=crypto.randomBytes(32).toString('hex');
   const challengeToken=jwt.sign({id:user.id,purpose:'second-factor',binding:S.challengeBinding(user),jti},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:S.CHALLENGE_SECONDS});
   state.challenge={hash:S.digest(jti),expires:Date.now()+S.CHALLENGE_SECONDS*1000,attempts:0};
   await db.query('UPDATE users SET two_factor_backup_codes=? WHERE id=?',[JSON.stringify(state),user.id]);
   return{status:200,body:{requires2FA:true,challengeToken,expiresIn:S.CHALLENGE_SECONDS,message:'Enter your authenticator or recovery code'}};
  }
  return loginPayload(db,user);
 });
}
async function completeSecondFactor(challengeToken,proof){
 if(typeof challengeToken!=='string'||challengeToken.length>2048)return denied();
 let decoded;try{decoded=jwt.verify(challengeToken,process.env.JWT_SECRET,{algorithms:['HS256']});}catch{return denied();}
 if(decoded.purpose!=='second-factor'||!Number.isSafeInteger(decoded.id)||typeof decoded.jti!=='string')return denied();
 return transaction(async db=>{
  const[[user]]=await db.query('SELECT *, locked_until>NOW() AS account_locked FROM users WHERE id=? FOR UPDATE',[decoded.id]);
  if(!user||Number(user.two_factor_enabled)!==1||!S.equalHex(decoded.binding,S.challengeBinding(user)))return denied();
  const state=S.factorState(user.two_factor_backup_codes),challenge=state.challenge;
  if(!challenge||!S.equalHex(challenge.hash,S.digest(decoded.jti))||challenge.expires<=Date.now()||challenge.attempts>=5||user.account_locked)return denied();
  if(!S.consumeFactor(user,state,proof)){
   challenge.attempts++;if(challenge.attempts>=5)state.challenge=null;
   await db.query('UPDATE users SET two_factor_backup_codes=? WHERE id=?',[JSON.stringify(state),user.id]);
   await failedAttempt(db,user);return denied();
  }
  state.challenge=null;
  await db.query('UPDATE users SET two_factor_backup_codes=? WHERE id=?',[JSON.stringify(state),user.id]);
  return loginPayload(db,user);
 });
}
async function refresh(raw){
 const verifier=S.refreshVerifier(raw);if(!verifier)return{status:401,body:{message:'Invalid or expired refresh token'}};
 return transaction(async db=>{
  const[[user]]=await db.query('SELECT *, locked_until>NOW() AS account_locked, TIMESTAMPDIFF(SECOND,NOW(),refresh_token_expires) AS refresh_seconds, TIMESTAMPDIFF(SECOND,last_activity,NOW()) AS idle_seconds FROM users WHERE refresh_token=? FOR UPDATE',[verifier]);
  const timeout=require('../middleware/sessionTimeout').SESSION_TIMEOUT_MINUTES;
  if(!user||!Number.isFinite(Number(user.refresh_seconds))||Number(user.refresh_seconds)<=0||user.idle_seconds==null||!Number.isFinite(Number(user.idle_seconds))||Number(user.idle_seconds)>timeout*60||user.account_locked)return{status:401,body:{message:'Invalid or expired refresh token'}};
  const roles=await rolesFor(db,user.id),newRaw=crypto.randomBytes(64).toString('hex'),newVerifier=S.refreshVerifier(newRaw),seconds=Math.min(S.ACCESS_SECONDS,Number(user.refresh_seconds));
  const token=S.signAccess({...user,refresh_token:newVerifier},roles,seconds);
  const[result]=await db.query('UPDATE users SET refresh_token=?, last_activity=NOW() WHERE id=? AND refresh_token=? AND refresh_token_expires>NOW()',[newVerifier,user.id,verifier]);
  if(result.affectedRows!==1)return{status:401,body:{message:'Invalid or expired refresh token'}};
  return{status:200,body:{token,refreshToken:newRaw,expiresIn:seconds}};
 });
}
function validSession(user,claims){return user&&/^sha256:[a-f0-9]{64}$/.test(user.refresh_token||'')&&S.equalHex(claims.session,S.credentialBinding(user));}
async function lockedSession(claims,work){return transaction(async db=>{
 const[[user]]=await db.query('SELECT *, refresh_token_expires>NOW() AS refresh_valid, TIMESTAMPDIFF(SECOND,last_activity,NOW()) AS idle_seconds FROM users WHERE id=? FOR UPDATE',[claims.id]);
 if(!validSession(user,claims)||!user.refresh_valid||user.idle_seconds==null||Number(user.idle_seconds)>require('../middleware/sessionTimeout').SESSION_TIMEOUT_MINUTES*60)return{status:401,body:{message:'Session is no longer valid',code:'SESSION_REVOKED'}};
 return work(db,user);
});}
const revoke=async(db,user)=>{
 const state=S.factorState(user.two_factor_backup_codes);state.challenge=null;
 return db.query('UPDATE users SET refresh_token=NULL,refresh_token_expires=NULL,two_factor_backup_codes=? WHERE id=?',[JSON.stringify(state),user.id]);
};
module.exports={transaction,rolesFor,session,passwordLogin,completeSecondFactor,refresh,validSession,lockedSession,revoke,failedAttempt};
