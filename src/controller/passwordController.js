const crypto=require('node:crypto');
const {pool}=require('../config/db');
const {UserModel}=require('../models/User');
const {sendPasswordResetEmail}=require('../utils/emailService');
const {hashPassword,verifyPassword}=require('../utils/passwordHasher');
const {logError}=require('../utils/safeLogging');
const S=require('../utils/authSecurity'),L=require('../services/authLifecycle');
const generic='If an account with that email exists, a password reset link has been sent.';
const invalid=()=>({status:400,body:{message:'Invalid or expired reset token'}});
// Existing columns are required. No schema lookup, DDL or fallback.
const requestPasswordReset=async(req,res)=>{
 let responded=false;
 try {
  const email=await S.normalizeEmail(req.body.email);
  if(!email)return res.status(400).json({message:'Valid email is required'});
  const raw=crypto.randomBytes(32).toString('hex'),verifier=S.digest(raw);
  const delivery=await L.transaction(async db=>{
   const[[user]]=await db.query('SELECT * FROM users WHERE email=? FOR UPDATE',[email]);
   if(!user)return null;
   if((await L.rolesFor(db,user.id)).includes('SuperAdmin'))return null;
   const recipient=await S.normalizeEmail(user.email);if(!recipient)return null;
   await db.query('UPDATE users SET password_reset_token=?, password_reset_expires=DATE_ADD(NOW(), INTERVAL 30 MINUTE), reset_token_used=0 WHERE id=?',[verifier,user.id]);
   return{id:user.id,recipient,name:user.fname||user.name||'User'};
  });
  // Send the same response before SMTP work; provider latency or failure must
  // not reveal whether this address selected an account.
  res.status(200).json({message:generic});responded=true;
  if(delivery){
   const url=new URL('/reset-password',process.env.FRONTEND_URL||'https://myuniclips.com');url.searchParams.set('token',raw);url.searchParams.set('email',delivery.recipient);
   let delivered=false;
   try{delivered=(await sendPasswordResetEmail(delivery.recipient,url.toString(),delivery.name)).success===true;}catch(error){logError('Password reset delivery failed',error);}
   if(!delivered){console.error('Password reset email delivery failed');await pool.query('UPDATE users SET password_reset_token=NULL,password_reset_expires=NULL WHERE id=? AND password_reset_token=?',[delivery.id,verifier]);}
   else console.log('Password reset email delivery completed');
  }
 }catch(error){logError('Password reset request failed',error);}
 if(!responded)return res.status(200).json({message:generic});
};
const resetPassword=async(req,res)=>{
 try{
  const email=await S.normalizeEmail(req.body.email),raw=req.body.token,errors=S.passwordErrors(req.body.newPassword);
  if(!email||typeof raw!=='string'||!/^[a-f0-9]{64}$/.test(raw))return res.status(400).json(invalid().body);
  if(errors.length)return res.status(400).json({message:'Password must contain: '+errors.join(', ')});
  const verifier=S.digest(raw);
  const[[candidate]]=await pool.query('SELECT id FROM users WHERE email=? AND password_reset_token=? AND password_reset_expires>NOW() AND COALESCE(reset_token_used,0)=0',[email,verifier]);
  if(!candidate)return res.status(400).json(invalid().body);
  const password=await hashPassword(req.body.newPassword);
  const result=await L.transaction(async db=>{
   const[[user]]=await db.query('SELECT * FROM users WHERE id=? FOR UPDATE',[candidate.id]);
   if(!user||!S.equalHex(user.password_reset_token,verifier))return invalid();
   if((await L.rolesFor(db,user.id)).includes('SuperAdmin'))return invalid();
   const state=S.factorState(user.two_factor_backup_codes);state.challenge=null;
   const[changed]=await db.query('UPDATE users SET password=?,password_reset_token=NULL,password_reset_expires=NULL,reset_token_used=1,refresh_token=NULL,refresh_token_expires=NULL,two_factor_backup_codes=? WHERE id=? AND password_reset_token=? AND password_reset_expires>NOW() AND COALESCE(reset_token_used,0)=0',[password,JSON.stringify(state),user.id,verifier]);
   return changed.affectedRows===1?{status:200,body:{message:'Password reset successfully. Please sign in again.'}}:invalid();
  });return res.status(result.status).json(result.body);
 }catch(error){logError('Password reset failed',error);return res.status(503).json({message:'Unable to reset password. Please try again.'});}
};
const changePassword=async(req,res)=>{
 try{
  const errors=S.passwordErrors(req.body.newPassword);
  if(!S.passwordInput(req.body.currentPassword)||errors.length)return res.status(400).json({message:'Valid current password and a new password containing '+(errors.join(', ')||'8–256 characters')+' are required'});
  const[candidates]=await UserModel.findById(req.user.id),candidate=candidates[0];
  if(!candidate||(await verifyPassword(req.body.currentPassword,candidate.password)).valid!==true)return res.status(400).json({message:'Current password is incorrect'});
  const password=await hashPassword(req.body.newPassword);
  const result=await L.lockedSession(req.user,async(db,user)=>{
   if((await L.rolesFor(db,user.id)).includes('SuperAdmin'))return{status:403,body:{message:'SuperAdmin password changes require the existing support process',contactSupport:true}};
   if(user.password!==candidate.password)return{status:401,body:{message:'Credentials changed. Please sign in again.'}};
   const state=S.factorState(user.two_factor_backup_codes);state.challenge=null;
   await db.query('UPDATE users SET password=?,refresh_token=NULL,refresh_token_expires=NULL,password_reset_token=NULL,password_reset_expires=NULL,reset_token_used=1,two_factor_backup_codes=? WHERE id=?',[password,JSON.stringify(state),user.id]);
   return{status:200,body:{message:'Password changed successfully. Please sign in again.',sessionRevoked:true}};
  });return res.status(result.status).json(result.body);
 }catch(error){logError('Password change failed',error);return res.status(503).json({message:'Unable to change password'});}
};
module.exports={requestPasswordReset,resetPassword,changePassword};
