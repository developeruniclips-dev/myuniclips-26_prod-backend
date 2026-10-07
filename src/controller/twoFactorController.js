const speakeasy=require('speakeasy'),QRCode=require('qrcode');
const S=require('../utils/authSecurity'),L=require('../services/authLifecycle');
const {verifyPassword}=require('../utils/passwordHasher');
const {logError}=require('../utils/safeLogging');
const failure=()=>({status:401,body:{message:'Invalid credentials or verification code'}});
async function staffProof(db,user,body){
 if(!(await L.rolesFor(db,user.id)).some(r=>['Admin','SuperAdmin'].includes(r)))return false;
 return S.passwordInput(body.currentPassword)&&(await verifyPassword(body.currentPassword,user.password)).valid===true;
}
const respond=async(res,event,work)=>{try{const result=await work();return res.status(result.status).json(result.body);}catch(error){logError(event,error);return res.status(503).json({message:'Unable to complete security request'});}};
const setup2FA=(req,res)=>respond(res,'Second-factor setup failed',()=>L.lockedSession(req.user,async(db,user)=>{
 if(!await staffProof(db,user,req.body))return failure();
 if(Number(user.two_factor_enabled)===1)return{status:409,body:{message:'Disable enrolled 2FA with your password and current verification before replacing it'}};
 const secret=speakeasy.generateSecret({length:32,name:`UniClips (${user.email})`,issuer:'UniClips'});
 // Existing secret column already held pending enrollment. Add an explicit deadline
 // and session binding to that disabled-only value, never overwrite an active seed.
 const pending=`pending:${Date.now()+S.SETUP_SECONDS*1000}:${req.user.session}:${secret.base32}`;
 const qrCode=await QRCode.toDataURL(secret.otpauth_url);
 await db.query('UPDATE users SET two_factor_secret=?,two_factor_enabled=0,two_factor_backup_codes=NULL WHERE id=?',[pending,user.id]);
 return{status:200,body:{message:'Verify within ten minutes to enable 2FA',secret:secret.base32,manualEntry:secret.base32,qrCode,expiresIn:S.SETUP_SECONDS}};
}));
const verify2FA=(req,res)=>respond(res,'Second-factor enrollment failed',()=>L.lockedSession(req.user,async(db,user)=>{
 if(!await staffProof(db,user,req.body))return failure();
 const match=typeof user.two_factor_secret==='string'&&user.two_factor_secret.match(/^pending:(\d{13}):([a-f0-9]{64}):([A-Z2-7]{16,128})$/);
 if(Number(user.two_factor_enabled)===1||!match||Number(match[1])<=Date.now()||!S.equalHex(match[2],req.user.session))return{status:400,body:{message:'Setup expired or unavailable. Start setup again.'}};
 const state={v:1,codes:[],lastStep:-1,challenge:null};
 if(!S.consumeFactor({...user,two_factor_secret:match[3]},state,{token:req.body.token}))return failure();
 const codes=S.backupCodes();state.codes=codes.verifiers;
 await db.query('UPDATE users SET two_factor_secret=?,two_factor_enabled=1,two_factor_backup_codes=?,refresh_token=NULL,refresh_token_expires=NULL,password_reset_token=NULL,password_reset_expires=NULL WHERE id=?',[match[3],JSON.stringify(state),user.id]);
 return{status:200,body:{message:'2FA enabled. Save these codes, then sign in again.',backupCodes:codes.plain,sessionRevoked:true}};
}));
const validate2FA=(req,res)=>respond(res,'Second-factor login failed',()=>L.completeSecondFactor(req.body.challengeToken,{token:req.body.token,backupCode:req.body.backupCode}));
const disable2FA=(req,res)=>respond(res,'Second-factor disable failed',()=>L.lockedSession(req.user,async(db,user)=>{
 if(!await staffProof(db,user,req.body)||Number(user.two_factor_enabled)!==1)return failure();
 const state=S.factorState(user.two_factor_backup_codes);
 if(!S.consumeFactor(user,state,{token:req.body.token,backupCode:req.body.backupCode}))return failure();
 await db.query('UPDATE users SET two_factor_secret=NULL,two_factor_enabled=0,two_factor_backup_codes=NULL,refresh_token=NULL,refresh_token_expires=NULL,password_reset_token=NULL,password_reset_expires=NULL WHERE id=?',[user.id]);
 return{status:200,body:{message:'2FA disabled. Please sign in again.',sessionRevoked:true}};
}));
const regenerateBackupCodes=(req,res)=>respond(res,'Recovery-code regeneration failed',()=>L.lockedSession(req.user,async(db,user)=>{
 if(!await staffProof(db,user,req.body)||Number(user.two_factor_enabled)!==1)return failure();
 const state=S.factorState(user.two_factor_backup_codes);
 if(!S.consumeFactor(user,state,{token:req.body.token,backupCode:req.body.backupCode}))return failure();
 const codes=S.backupCodes();state.codes=codes.verifiers;state.challenge=null;
 await db.query('UPDATE users SET two_factor_backup_codes=?,refresh_token=NULL,refresh_token_expires=NULL,password_reset_token=NULL,password_reset_expires=NULL WHERE id=?',[JSON.stringify(state),user.id]);
 return{status:200,body:{message:'Previous recovery codes are invalid. Save these codes and sign in again.',backupCodes:codes.plain,sessionRevoked:true}};
}));
const get2FAStatus=(req,res)=>respond(res,'Second-factor status failed',()=>L.lockedSession(req.user,async(db,user)=>({status:200,body:{enabled:Number(user.two_factor_enabled)===1}})));
module.exports={setup2FA,verify2FA,validate2FA,disable2FA,get2FAStatus,regenerateBackupCodes};
