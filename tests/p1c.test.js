// Synthetic isolated MySQL + mail/provider doubles. Never loads .env or real secrets.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),jwt=require('jsonwebtoken'),speakeasy=require('speakeasy'),fs=require('node:fs'),path=require('node:path');
if(process.env.P1C_ISOLATED_TEST!=='1')throw Error('Explicit P1C isolated test flag required');
process.env.JWT_SECRET='P1C_SYNTHETIC_TEST_SIGNING_KEY';process.env.FRONTEND_URL='https://frontend.example.invalid';
const mysql=require('mysql2/promise'),config={host:'127.0.0.1',port:33316,user:'root',password:''};
let actual,pool,queries=[],mail=[],mailFails=false,failRoles=false,failUpdates=false,uid=0,logs=[],responseWrites=0;
const originalError=console.error,originalLog=console.log;
let S,L,passwords,factors,auth,sessionMiddleware,hashPassword;
const inject=(file,exports)=>{const p=require.resolve(file);require.cache[p]={id:p,filename:p,loaded:true,exports};};
function instrument(db){return new Proxy(db,{get(target,key){if(key==='query')return async(sql,args)=>{queries.push(sql);assert.doesNotMatch(sql,/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/i,'request paths must not execute DDL');if(failRoles&&sql.includes('FROM user_roles'))throw Object.assign(Error('SYNTHETIC_SQL_SECRET'),{code:'ER_BAD_FIELD_ERROR'});if(failUpdates&&sql.startsWith('UPDATE'))throw Error('SYNTHETIC_DB_SECRET');return target.query(sql,args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){responseWrites++;this.body=body;return this;}});
async function call(controller,body={},user){const res=response();await controller({body,user,headers:{}},res);return res;}
async function seed(overrides={}){
 const id=++uid,password=await hashPassword('SyntheticStrong!9');
 const row={id,fname:'Synthetic',lname:'User',email:`p1c${id}@example.invalid`,password,isScholar:0,two_factor_enabled:0,...overrides};
 const keys=Object.keys(row);await actual.query(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(row));await actual.query('INSERT INTO user_roles VALUES (?,?)',[id,1]);return row;
}
async function row(id){const[[value]]=await actual.query('SELECT * FROM users WHERE id=?',[id]);return value;}
const claims=token=>jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});
const login=async user=>L.passwordLogin(user.email,'SyntheticStrong!9');
async function authorized(token){const res=response();let next=false;await sessionMiddleware({user:claims(token)},res,()=>{next=true;});return{next,res};}
test.before(async()=>{
 const admin=await mysql.createConnection(config);await admin.query('CREATE DATABASE IF NOT EXISTS uniclips_auth_p1c_test');await admin.end();
 actual=mysql.createPool({...config,database:'uniclips_auth_p1c_test',connectionLimit:8});
 const[[db]]=await actual.query('SELECT DATABASE() AS name');assert.equal(db.name,'uniclips_auth_p1c_test');
 await actual.query('DROP TABLE IF EXISTS users');await actual.query('DROP TABLE IF EXISTS user_roles');await actual.query('DROP TABLE IF EXISTS roles');await actual.query('DROP TABLE IF EXISTS scholar_profile');
 await actual.query('CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY,fname VARCHAR(100),lname VARCHAR(100),email VARCHAR(254) UNIQUE,password VARCHAR(255),isScholar TINYINT DEFAULT 0,refresh_token VARCHAR(500),refresh_token_expires DATETIME,last_login DATETIME,last_activity DATETIME,failed_login_attempts INT DEFAULT 0,locked_until DATETIME,last_failed_login DATETIME,password_reset_token VARCHAR(255),password_reset_expires DATETIME,reset_token_used TINYINT DEFAULT 0,two_factor_secret VARCHAR(255),two_factor_enabled TINYINT DEFAULT 0,two_factor_backup_codes TEXT)');
 await actual.query('CREATE TABLE roles (id INT PRIMARY KEY,name VARCHAR(30))');await actual.query("INSERT INTO roles VALUES (1,'Learner'),(2,'Admin'),(3,'Scholar'),(4,'SuperAdmin')");await actual.query('CREATE TABLE user_roles (user_id INT,role_id INT,PRIMARY KEY(user_id,role_id))');await actual.query('CREATE TABLE scholar_profile (id INT,user_id INT,approved TINYINT)');
 const getConnection=actual.getConnection.bind(actual);pool=instrument(actual);pool.getConnection=async()=>instrument(await getConnection());
 inject('../src/config/db',{pool});inject('../src/utils/emailService',{sendPasswordResetEmail:async(email,url)=>{mail.push({email,url,responseAlreadySent:responseWrites>0});return{success:!mailFails};}});
 S=require('../src/utils/authSecurity');L=require('../src/services/authLifecycle');passwords=require('../src/controller/passwordController');factors=require('../src/controller/twoFactorController');auth=require('../src/controller/authController');sessionMiddleware=require('../src/middleware/sessionTimeout').sessionTimeoutMiddleware;hashPassword=require('../src/utils/passwordHasher').hashPassword;
 console.error=(...args)=>logs.push(args);console.log=(...args)=>logs.push(args);
});
test.after(async()=>{console.error=originalError;console.log=originalLog;if(actual)await actual.end();});
test.beforeEach(()=>{queries=[];mail=[];logs=[];mailFails=false;failRoles=false;failUpdates=false;responseWrites=0;});
test('email normalization and shared bounded password policy reject hostile types/lengths',async()=>{
 assert.equal(await S.normalizeEmail({email:'fixture@example.invalid'}),null);assert.equal(await S.normalizeEmail('x'.repeat(255)+'@example.invalid'),null);assert.equal(await S.normalizeEmail('  USER@EXAMPLE.INVALID  '),'user@example.invalid');
 for(const value of [null,{},'a'.repeat(257),'weak'])assert.ok(S.passwordErrors(value).length);assert.deepEqual(S.passwordErrors('SyntheticStrong!9'),[]);
});
test('unknown, restricted and role-lookup-failed reset requests have identical non-enumerating responses',async()=>{
 const user=await seed();await actual.query('UPDATE user_roles SET role_id=4 WHERE user_id=?',[user.id]);
 const unknown=await call(passwords.requestPasswordReset,{email:'unknown@example.invalid'}),restricted=await call(passwords.requestPasswordReset,{email:user.email});assert.deepEqual(unknown.body,restricted.body);assert.equal(unknown.statusCode,200);assert.equal(mail.length,0);
 failRoles=true;const failed=await call(passwords.requestPasswordReset,{email:user.email});assert.deepEqual(failed.body,unknown.body);assert.equal(mail.length,0);assert.equal((await row(user.id)).password_reset_token,null);
});
test('reset token is random, hash-only, thirty-minute expiry, stored recipient and absent from logs',async()=>{
 const user=await seed();const result=await call(passwords.requestPasswordReset,{email:user.email.toUpperCase()});assert.equal(result.statusCode,200);assert.equal(mail[0].responseAlreadySent,true,'generic HTTP response precedes SMTP delivery');
 const raw=new URL(mail[0].url).searchParams.get('token'),saved=await row(user.id);assert.match(raw,/^[a-f0-9]{64}$/);assert.equal(saved.password_reset_token,S.digest(raw));assert.notEqual(saved.password_reset_token,raw);assert.equal(mail[0].email,user.email);
 const[[deadline]]=await actual.query('SELECT TIMESTAMPDIFF(SECOND,NOW(),password_reset_expires) AS seconds FROM users WHERE id=?',[user.id]);assert.ok(deadline.seconds<=1800&&deadline.seconds>1740,'expiry is thirty minutes on the database clock');assert.equal(JSON.stringify(logs).includes(raw),false);assert.equal(JSON.stringify(result.body).includes(raw),false);
});
test('delivery failure revokes only its own reset verifier and never logs the link',async()=>{
 const user=await seed();mailFails=true;await call(passwords.requestPasswordReset,{email:user.email});assert.equal((await row(user.id)).password_reset_token,null);assert.equal(JSON.stringify(logs).includes(mail[0].url),false);
});
test('invalid and expired reset credentials cannot change a password',async()=>{
 const user=await seed();await call(passwords.requestPasswordReset,{email:user.email});const raw=new URL(mail[0].url).searchParams.get('token');
 assert.equal((await call(passwords.resetPassword,{email:user.email,token:'0'.repeat(64),newPassword:'ReplacementStrong!8'})).statusCode,400);
 await actual.query('UPDATE users SET password_reset_expires=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?',[user.id]);assert.equal((await call(passwords.resetPassword,{email:user.email,token:raw,newPassword:'ReplacementStrong!8'})).statusCode,400);assert.equal((await row(user.id)).password,user.password);
});
test('superseding reset invalidates the old credential',async()=>{
 const user=await seed();await call(passwords.requestPasswordReset,{email:user.email});const first=new URL(mail[0].url).searchParams.get('token');await call(passwords.requestPasswordReset,{email:user.email});assert.notEqual(first,new URL(mail[1].url).searchParams.get('token'));assert.equal((await call(passwords.resetPassword,{email:user.email,token:first,newPassword:'ReplacementStrong!8'})).statusCode,400);
});
test('concurrent reset permits exactly one success and atomically revokes access/refresh',async()=>{
 const user=await seed(),issued=await login(user);await call(passwords.requestPasswordReset,{email:user.email});const token=new URL(mail[0].url).searchParams.get('token'),body={email:user.email,token,newPassword:'ReplacementStrong!8'};
 const results=await Promise.all([call(passwords.resetPassword,body),call(passwords.resetPassword,body)]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,400]);const saved=await row(user.id);assert.equal(saved.password_reset_token,null);assert.equal(saved.reset_token_used,1);assert.equal(saved.refresh_token,null);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);assert.equal((await authorized(issued.body.token)).next,false);assert.equal((await call(passwords.resetPassword,body)).statusCode,400);
});
test('refresh is hash-only, rotates once, revokes old access and preserves absolute deadline',async()=>{
 const user=await seed(),issued=await login(user),before=await row(user.id);assert.equal(before.refresh_token,S.refreshVerifier(issued.body.refreshToken));assert.equal((await authorized(issued.body.token)).next,true);
 const rotated=await L.refresh(issued.body.refreshToken);assert.equal(rotated.status,200);assert.notEqual(rotated.body.refreshToken,issued.body.refreshToken);assert.equal((await row(user.id)).refresh_token_expires.getTime(),before.refresh_token_expires.getTime());assert.equal((await L.refresh(issued.body.refreshToken)).status,401);assert.equal((await authorized(issued.body.token)).next,false);assert.equal((await authorized(rotated.body.token)).next,true);assert.deepEqual(Object.keys(rotated.body).sort(),['expiresIn','refreshToken','token']);
});
test('concurrent refresh has one winner, no response exposes stored verifier',async()=>{
 const user=await seed(),issued=await login(user),results=await Promise.all([L.refresh(issued.body.refreshToken),L.refresh(issued.body.refreshToken)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal(JSON.stringify(results).includes((await row(user.id)).refresh_token),false);
});
test('failed rotation rolls back without destroying valid authentication',async()=>{
 const user=await seed(),issued=await login(user);failUpdates=true;await assert.rejects(L.refresh(issued.body.refreshToken));failUpdates=false;assert.equal((await authorized(issued.body.token)).next,true);assert.equal((await L.refresh(issued.body.refreshToken)).status,200);
});
test('invalid, expired, idle and legacy plaintext refresh credentials are denied',async()=>{
 const user=await seed(),issued=await login(user);assert.equal((await L.refresh('invalid')).status,401);await actual.query('UPDATE users SET refresh_token_expires=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?',[user.id]);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);
 const second=await login(user);await actual.query('UPDATE users SET last_activity=DATE_SUB(NOW(),INTERVAL 31 MINUTE) WHERE id=?',[user.id]);assert.equal((await L.refresh(second.body.refreshToken)).status,401);
 await actual.query('UPDATE users SET refresh_token=?,refresh_token_expires=DATE_ADD(NOW(),INTERVAL 1 DAY),last_activity=NOW() WHERE id=?',[issued.body.refreshToken,user.id]);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);
});
test('logout revokes access and refresh; stale logout cannot clear a newer session',async()=>{
 const user=await seed(),old=await login(user),newer=await login(user);assert.equal((await call(auth.logout,{},claims(old.body.token))).statusCode,401);assert.equal((await authorized(newer.body.token)).next,true);assert.equal((await call(auth.logout,{},claims(newer.body.token))).statusCode,200);assert.equal((await L.refresh(newer.body.refreshToken)).status,401);assert.equal((await authorized(newer.body.token)).next,false);
});
test('logout also invalidates outstanding password-bound second-factor challenges',async()=>{
 const{user,codes}=await enrolled(),first=await login(user),issued=await L.completeSecondFactor(first.body.challengeToken,{backupCode:codes.plain[0]}),pending=await login(user);
 assert.equal((await call(auth.logout,{},claims(issued.body.token))).statusCode,200);assert.equal((await L.completeSecondFactor(pending.body.challengeToken,{backupCode:codes.plain[1]})).status,401);assert.equal(S.factorState((await row(user.id)).two_factor_backup_codes).codes.length,9);
});
test('password change requires current proof, live roles and revokes reset/access/refresh',async()=>{
 const user=await seed(),issued=await login(user);assert.equal((await call(passwords.changePassword,{currentPassword:'wrong',newPassword:'ReplacementStrong!8'},claims(issued.body.token))).statusCode,400);const changed=await call(passwords.changePassword,{currentPassword:'SyntheticStrong!9',newPassword:'ReplacementStrong!8'},claims(issued.body.token));assert.equal(changed.statusCode,200);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);assert.equal((await authorized(issued.body.token)).next,false);
});
async function admin(overrides={}){const user=await seed(overrides);await actual.query('UPDATE user_roles SET role_id=2 WHERE user_id=?',[user.id]);return user;}
async function enrolled(){const user=await admin({two_factor_secret:speakeasy.generateSecret({length:32}).base32,two_factor_enabled:1,two_factor_backup_codes:JSON.stringify({v:1,codes:[],lastStep:-1,challenge:null})});const codes=S.backupCodes();await actual.query('UPDATE users SET two_factor_backup_codes=? WHERE id=?',[JSON.stringify({v:1,codes:codes.verifiers,lastStep:-1,challenge:null}),user.id]);return{user,codes};}
test('pending setup requires password, is disabled/expiring/session-bound and ordinary responses hide seed',async()=>{
 const user=await admin(),issued=await login(user),identity=claims(issued.body.token);assert.equal((await call(factors.setup2FA,{currentPassword:'wrong'},identity)).statusCode,401);const setup=await call(factors.setup2FA,{currentPassword:'SyntheticStrong!9'},identity);assert.equal(setup.statusCode,200);assert.equal(setup.body.expiresIn,600);const saved=await row(user.id);assert.equal(saved.two_factor_enabled,0);assert.match(saved.two_factor_secret,/^pending:/);assert.equal((await authorized(issued.body.token)).next,true);assert.equal(JSON.stringify(require('../src/utils/userResponses').userResponse(saved)).includes(setup.body.secret),false);
 assert.equal((await call(factors.verify2FA,{currentPassword:'SyntheticStrong!9',token:'wrong'},identity)).statusCode,401);
 const otp=speakeasy.totp({secret:setup.body.secret,encoding:'base32'});const enabled=await call(factors.verify2FA,{currentPassword:'SyntheticStrong!9',token:otp},identity);assert.equal(enabled.statusCode,200);assert.equal(enabled.body.backupCodes.length,10);assert.equal((await row(user.id)).two_factor_enabled,1);assert.equal((await authorized(issued.body.token)).next,false);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);
 const state=(await row(user.id)).two_factor_backup_codes;for(const code of enabled.body.backupCodes)assert.equal(state.includes(code),false);assert.equal(JSON.stringify(logs).includes(setup.body.secret),false);
});
test('setup expiry and enrolled overwrite are denied',async()=>{
 const user=await admin(),issued=await login(user),identity=claims(issued.body.token),secret=speakeasy.generateSecret({length:32}).base32;
 await actual.query('UPDATE users SET two_factor_secret=? WHERE id=?',[`pending:${Date.now()-1}:${identity.session}:${secret}`,user.id]);assert.equal((await call(factors.verify2FA,{currentPassword:'SyntheticStrong!9',token:speakeasy.totp({secret,encoding:'base32'})},identity)).statusCode,400);
 await actual.query('UPDATE users SET two_factor_secret=?,two_factor_enabled=1 WHERE id=?',[secret,user.id]);const saved=await row(user.id),bound={...identity,session:S.credentialBinding(saved)};assert.equal((await call(factors.setup2FA,{currentPassword:'SyntheticStrong!9'},bound)).statusCode,409);assert.equal((await row(user.id)).two_factor_secret,secret);
});
test('public second factor cannot authenticate arbitrary userId or a forged/password-stale challenge',async()=>{
 const{user}=await enrolled();assert.equal((await call(factors.validate2FA,{userId:user.id,token:'123456'})).statusCode,401);assert.equal((await L.completeSecondFactor('forged',{token:'123456'})).status,401);
 const challenge=await login(user);assert.equal(challenge.body.requires2FA,true);assert.equal(challenge.body.token,undefined);await actual.query('UPDATE users SET password=? WHERE id=?',[await hashPassword('ReplacementStrong!8'),user.id]);assert.equal((await L.completeSecondFactor(challenge.body.challengeToken,{token:speakeasy.totp({secret:user.two_factor_secret,encoding:'base32'})})).status,401);
});
test('bounded TOTP accepts adjacent steps, rejects outside window and replay',async()=>{
 const{user}=await enrolled(),now=Date.now(),state=S.factorState((await row(user.id)).two_factor_backup_codes);
 assert.equal(S.consumeFactor(user,state,{token:speakeasy.totp({secret:user.two_factor_secret,encoding:'base32',time:Math.floor(now/1000)+90})},now),false);
 const code=speakeasy.totp({secret:user.two_factor_secret,encoding:'base32',time:Math.floor(now/1000)});assert.equal(S.consumeFactor(user,state,{token:code},now),true);assert.equal(S.consumeFactor(user,state,{token:code},now),false);
 const earlier={v:1,codes:[],lastStep:-1,challenge:null};assert.equal(S.consumeFactor(user,earlier,{token:speakeasy.totp({secret:user.two_factor_secret,encoding:'base32',time:Math.floor(now/1000)-30})},now),true);
});
test('login challenge and recovery code each have one concurrent winner; code cannot be reused',async()=>{
 const{user,codes}=await enrolled(),challenge=await login(user),proof={backupCode:codes.plain[0]};const results=await Promise.all([L.completeSecondFactor(challenge.body.challengeToken,proof),L.completeSecondFactor(challenge.body.challengeToken,proof)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal(S.factorState((await row(user.id)).two_factor_backup_codes).codes.length,9);const next=await login(user);assert.equal((await L.completeSecondFactor(next.body.challengeToken,proof)).status,401);assert.equal(JSON.stringify(logs).includes(proof.backupCode),false);
});
test('superseded/expired challenge and five failed verifications cannot mint tokens',async()=>{
 const{user}=await enrolled(),first=await login(user),second=await login(user);assert.equal((await L.completeSecondFactor(first.body.challengeToken,{token:'wrong'})).status,401);
 const decoded=claims(second.body.challengeToken);delete decoded.exp;delete decoded.iat;const expired=jwt.sign(decoded,process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:-1});assert.equal((await L.completeSecondFactor(expired,{token:'123456'})).status,401);
 for(let i=0;i<5;i++)assert.equal((await L.completeSecondFactor(second.body.challengeToken,{token:'wrong'})).status,401);assert.equal((await row(user.id)).refresh_token,null);assert.equal(S.factorState((await row(user.id)).two_factor_backup_codes).challenge,null);
});
test('regeneration and disable require current password/factor and revoke affected session',async()=>{
 const{user,codes}=await enrolled(),challenge=await login(user),issued=await L.completeSecondFactor(challenge.body.challengeToken,{backupCode:codes.plain[0]}),identity=claims(issued.body.token);
 assert.equal((await call(factors.disable2FA,{currentPassword:'wrong',backupCode:codes.plain[1]},identity)).statusCode,401);
 const regenerated=await call(factors.regenerateBackupCodes,{currentPassword:'SyntheticStrong!9',backupCode:codes.plain[1]},identity);assert.equal(regenerated.statusCode,200);assert.equal((await L.refresh(issued.body.refreshToken)).status,401);const state=S.factorState((await row(user.id)).two_factor_backup_codes);assert.equal(S.consumeFactor(user,state,{backupCode:codes.plain[2]}),false);
 const newChallenge=await login(user),newIssued=await L.completeSecondFactor(newChallenge.body.challengeToken,{backupCode:regenerated.body.backupCodes[0]});const disabled=await call(factors.disable2FA,{currentPassword:'SyntheticStrong!9',backupCode:regenerated.body.backupCodes[1]},claims(newIssued.body.token));assert.equal(disabled.statusCode,200);const saved=await row(user.id);assert.equal(saved.two_factor_enabled,0);assert.equal(saved.two_factor_secret,null);assert.equal(saved.refresh_token,null);
});
test('legacy low-entropy readable recovery codes are retired without disabling enrolled TOTP',async()=>{
 const raw='ABCD-EF12',state=S.factorState(JSON.stringify([{code:raw,hash:S.digest(raw),used:false}]));assert.equal(JSON.stringify(state).includes(raw),false);assert.equal(S.consumeFactor({two_factor_secret:'unused'},state,{backupCode:raw}),false);assert.equal(state.codes.length,0);
 const secret=speakeasy.generateSecret({length:32}).base32;assert.equal(S.consumeFactor({two_factor_secret:secret},state,{token:speakeasy.totp({secret,encoding:'base32'})}),true);
});
test('missing user/session, database failures and challenge/access-purpose confusion fail closed',async()=>{
 const user=await seed(),issued=await login(user);await actual.query('DELETE FROM users WHERE id=?',[user.id]);assert.equal((await authorized(issued.body.token)).next,false);
 const middleware=require('../src/middleware/auth').authMiddleware,res=response();let continued=false;await middleware({headers:{authorization:'Bearer '+jwt.sign({id:user.id,purpose:'second-factor'},process.env.JWT_SECRET,{expiresIn:300})}},res,()=>{continued=true;});assert.equal(res.statusCode,401);assert.equal(continued,false);
 const second=await seed(),live=await login(second);failUpdates=true;assert.equal((await authorized(live.body.token)).res.statusCode,503);assert.equal(JSON.stringify(logs).includes('SYNTHETIC_DB_SECRET'),false);
});
test('recovery address changes are rejected before writes; valid same-address profile remains compatible',async()=>{
 const user=await seed(),controller=require('../src/controller/userController');for(const email of ['invalid','redirect@example.invalid']){const res=await call(controller.updateUserProfile,{email},{id:user.id});assert.ok([400,403].includes(res.statusCode));assert.equal((await row(user.id)).email,user.email);}
 const res=await call(controller.updateUserProfile,{email:user.email.toUpperCase(),fname:'Updated'},{id:user.id});assert.equal(res.statusCode,200);assert.equal((await row(user.id)).email,user.email);
});
test('registration creates a projected account and bounded live credentials with zero request DDL',async()=>{
 const registered=await call(auth.userRegister,{fname:'Synthetic',lname:'New',email:'registered@example.invalid',password:'SyntheticStrong!9',isScholar:0});assert.equal(registered.statusCode,201);uid=Math.max(uid,registered.body.user.id);
 const saved=await row(registered.body.user.id);assert.equal(saved.refresh_token,S.refreshVerifier(registered.body.refreshToken));assert.equal(claims(registered.body.token).purpose,'access');assert.equal((await authorized(registered.body.token)).next,true);
 for(const key of ['password','refresh_token','two_factor_secret','two_factor_backup_codes','password_reset_token'])assert.equal(Object.hasOwn(registered.body.user,key),false);
 assert.ok(queries.length>0);for(const sql of queries)assert.doesNotMatch(sql,/\b(?:CREATE|ALTER|DROP)\b/i);
});
test('actual 2FA routes reject anonymous setup and a learner before setup work',async t=>{
 const app=require('express')();app.use(require('express').json());app.use('/2fa',require('../src/routes/twoFactorRoutes'));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}/2fa/setup`,anonymous=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(anonymous.status,401);assert.equal(queries.length,0);
 const user=await seed(),issued=await login(user);const denied=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+issued.body.token},body:JSON.stringify({currentPassword:'SyntheticStrong!9'})});assert.equal(denied.status,403);assert.equal((await row(user.id)).two_factor_secret,null);
});
test('authentication request graph contains no schema mutations or startup migration wiring',()=>{
 for(const file of ['controller/authController.js','controller/passwordController.js','controller/twoFactorController.js','services/authLifecycle.js','middleware/sessionTimeout.js','middleware/auth.js'])assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),/\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i,file);
 const startup=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');assert.doesNotMatch(startup,/require\([^)]*(?:migrat|add_security)/i);
});
