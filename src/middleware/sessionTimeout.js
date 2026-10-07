const {pool}=require('../config/db');
const {credentialBinding,equalHex}=require('../utils/authSecurity');
const {logError}=require('../utils/safeLogging');
const configured=Number(process.env.SESSION_TIMEOUT_MINUTES||30);
const SESSION_TIMEOUT_MINUTES=Number.isFinite(configured)&&configured>0&&configured<=1440?configured:30;
const sessionTimeoutMiddleware=async(req,res,next)=>{
 if(!req.user?.id)return res.status(401).json({message:'Authentication required',code:'SESSION_REVOKED'});
 try{
  const[[user]]=await pool.query('SELECT id,password,refresh_token,refresh_token_expires,two_factor_secret,two_factor_enabled,last_activity,TIMESTAMPDIFF(SECOND,last_activity,NOW()) AS idle_seconds,refresh_token_expires>NOW() AS refresh_valid FROM users WHERE id=?',[req.user.id]);
  if(!user||!/^sha256:[a-f0-9]{64}$/.test(user.refresh_token||'')||!user.refresh_valid||!equalHex(req.user.session,credentialBinding(user)))return res.status(401).json({message:'Session is no longer valid. Please sign in again.',code:'SESSION_REVOKED'});
  if(user.idle_seconds==null||Number(user.idle_seconds)>SESSION_TIMEOUT_MINUTES*60){
   await pool.query('UPDATE users SET refresh_token=NULL,refresh_token_expires=NULL WHERE id=? AND refresh_token=?',[user.id,user.refresh_token]);
   return res.status(401).json({message:'Session expired due to inactivity. Please sign in again.',sessionExpired:true,code:'SESSION_TIMEOUT'});
  }
  const[updated]=await pool.query('UPDATE users SET last_activity=NOW() WHERE id=? AND refresh_token=? AND refresh_token_expires>NOW()',[user.id,user.refresh_token]);
  if(updated.affectedRows!==1)return res.status(401).json({message:'Session is no longer valid',code:'SESSION_REVOKED'});
  next();
 }catch(error){logError('Session verification failed',error);res.status(503).json({message:'Unable to verify session'});}
};
const trackActivity=sessionTimeoutMiddleware;
module.exports={sessionTimeoutMiddleware,trackActivity,SESSION_TIMEOUT_MINUTES};
