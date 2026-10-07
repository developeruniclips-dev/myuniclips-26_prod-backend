const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const ACCESS_SECONDS = 3600, REFRESH_DAYS = 30, RESET_MINUTES = 30, SETUP_SECONDS = 600, CHALLENGE_SECONDS = 300;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const refreshVerifier = raw => typeof raw === 'string' && /^[a-f0-9]{128}$/.test(raw) ? `sha256:${digest(raw)}` : null;
const passwordInput = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
function passwordErrors(value) {
 if (!passwordInput(value)) return ['a password of 8–256 characters'];
 const errors=[];
 if(value.length<8)errors.push('at least 8 characters');
 for(const [pattern,label]of [[/[A-Z]/,'one uppercase letter'],[/[a-z]/,'one lowercase letter'],[/[0-9]/,'one number'],[/[!@#$%^&*(),.?":{}|<>]/,'one special character']])if(!pattern.test(value))errors.push(label);
 return errors;
}
async function normalizeEmail(value) {
 if(typeof value!=='string')return null;
 const req={body:{email:value.trim()}};
 await body('email').isLength({min:3,max:254}).isEmail().normalizeEmail().run(req);
 return validationResult(req).isEmpty()?req.body.email:null;
}
function keyed(purpose,values) {
 if(!process.env.JWT_SECRET)throw Error('Authentication configuration unavailable');
 return crypto.createHmac('sha256',process.env.JWT_SECRET).update(JSON.stringify([purpose,...values])).digest('hex');
}
const credentialBinding = user => keyed('access-session-v1',[user.id,user.password,user.refresh_token,Number(user.two_factor_enabled||0)===1?user.two_factor_secret:null,Number(user.two_factor_enabled||0)]);
const challengeBinding = user => keyed('password-second-factor-v1',[user.id,user.password,user.two_factor_secret,Number(user.two_factor_enabled||0)]);
const equalHex = (a,b) => typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const signAccess = (user,roles,seconds=ACCESS_SECONDS) => jwt.sign({id:user.id,email:user.email,name:user.name,roles,purpose:'access',session:credentialBinding(user)},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:seconds});
function factorState(value) {
 if(value==null||value==='')return{v:1,codes:[],lastStep:-1,challenge:null};
 const parsed=typeof value==='string'?JSON.parse(value):value;
 // Legacy 32-bit readable recovery codes are retired. Existing enrolled TOTP
 // remains available; users must regenerate strong codes with password + TOTP.
 const source=Array.isArray(parsed)?[]:parsed?.v===1?parsed.codes:null;
 if(!Array.isArray(source)||source.length>10)throw Error('Invalid second-factor state');
 const codes=source.filter(c=>!c.used).map(c=>({hash:typeof c==='string'?digest(c.replaceAll('-','').toUpperCase()):c.hash}));
 if(codes.some(c=>!/^[a-f0-9]{64}$/.test(c.hash)))throw Error('Invalid recovery verifier');
 const lastStep=Array.isArray(parsed)?-1:parsed.lastStep;
 if(!Number.isSafeInteger(lastStep)||lastStep < -1)throw Error('Invalid replay state');
 const challenge=Array.isArray(parsed)?null:parsed.challenge||null;
 return{v:1,codes,lastStep,challenge};
}
function backupCodes() {
 const plain=Array.from({length:10},()=>crypto.randomBytes(16).toString('hex').toUpperCase());
 return{plain:plain.map(c=>c.match(/.{4}/g).join('-')),verifiers:plain.map(c=>({hash:digest(c)}))};
}
function consumeFactor(user,state,{token,backupCode},now=Date.now()) {
 if(token&&backupCode)return false;
 if(typeof token==='string'&&/^\d{6}$/.test(token)){
  const match=require('speakeasy').totp.verifyDelta({secret:user.two_factor_secret,encoding:'base32',token,window:1,time:Math.floor(now/1000)});
  if(!match)return false;
  const step=Math.floor(now/30000)+match.delta;
  if(step<=state.lastStep)return false;
  state.lastStep=step;return true;
 }
 if(typeof backupCode==='string'&&/^(?:[A-Fa-f0-9]{4}-){7}[A-Fa-f0-9]{4}$/.test(backupCode)){
  const verifier=digest(backupCode.replaceAll('-','').toUpperCase()),index=state.codes.findIndex(c=>equalHex(c.hash,verifier));
  if(index<0)return false;state.codes.splice(index,1);return true;
 }
 return false;
}
module.exports={ACCESS_SECONDS,REFRESH_DAYS,RESET_MINUTES,SETUP_SECONDS,CHALLENGE_SECONDS,digest,refreshVerifier,passwordInput,passwordErrors,normalizeEmail,credentialBinding,challengeBinding,equalHex,signAccess,factorState,backupCodes,consumeFactor};
