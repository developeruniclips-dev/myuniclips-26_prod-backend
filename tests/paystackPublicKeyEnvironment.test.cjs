'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {validatePublicKeyEnvironment:validate,deliverRenderPublicKeyFromEnvironment:deliver}=require('../src/sandbox/publicKeyEnvironment');
const fingerprint=k=>crypto.createHash('sha256').update(k.export({format:'der',type:'spki'})).digest('hex');
function fixture(){const keys=crypto.generateKeyPairSync('ed25519');return{keys,env:{RENDER:'true',RENDER_SERVICE_ID:'srv-synthetic',SANDBOX_APPROVAL_MODE:'single-owner-v1',UNICLIPS_SANDBOX:'paystack-test-v1',NODE_ENV:'test',DB_NAME:'uniclipspsngsandbox',DB_USER:'psngsandboxapp',DB_HOST:'db.example.invalid',DB_PASS:String(crypto.randomBytes(24).toString('hex')),DB_SSL:'true',DB_SSL_CA:'inert-ca',PAYMENT_ARCHITECTURE:'legacy_verified',FRONTEND_URL:'https://sandbox.example.invalid',ALLOWED_ORIGINS:'https://sandbox.example.invalid',PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:keys.publicKey.export({format:'pem',type:'spki'}),PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256:fingerprint(keys.publicKey)}};}
test('only the expected SPKI DER fingerprint accepts an Ed25519 public PEM; LF and CRLF agree',()=>{const {env}=fixture();assert.equal(validate(env).toString(),env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM);assert.equal(validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM.replace(/\n/g,'\r\n')}).toString().includes('\r\n'),true);});
for(const value of [undefined,null,1,'','x'.repeat(4097)])test('missing, invalid or oversized public PEM is refused: '+typeof value,()=>{const {env}=fixture();assert.throws(()=>validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:value}),{code:'SANDBOX_KEY_PUBLIC_ENV_REQUIRED'});});
for(const value of [undefined,null,1,'','a'.repeat(63),'z'.repeat(64),'A'.repeat(64)])test('fingerprint must be a complete lower-case SHA-256: '+typeof value,()=>{const {env}=fixture();assert.throws(()=>validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256:value}),{code:'SANDBOX_KEY_FINGERPRINT_REQUIRED'});});
test('a different valid Ed25519 key or digest cannot replace the pinned key',()=>{const a=fixture(),b=fixture();assert.throws(()=>validate({...a.env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:b.env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM}),{code:'SANDBOX_KEY_FINGERPRINT_MISMATCH'});assert.throws(()=>validate({...a.env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256:'0'.repeat(64)}),{code:'SANDBOX_KEY_FINGERPRINT_MISMATCH'});});
test('private, encrypted private, appended, escaped or malformed envelopes never reach the key parser',()=>{
 const {env,keys}=fixture(),privatePem=keys.privateKey.export({format:'pem',type:'pkcs8'}),encrypted=keys.privateKey.export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase:crypto.randomBytes(24).toString('hex')});
 const parse=crypto.createPublicKey;let parsed=0;crypto.createPublicKey=()=>{parsed++;throw Error('PRIVATE_PARSE_FORBIDDEN');};
 try{for(const pem of [privatePem,encrypted,env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM+privatePem,env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM.replace(/\n/g,'\\n'),' '+env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM,env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM.replaceAll('PUBLIC KEY','CERTIFICATE')])assert.throws(()=>validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:pem}),{code:'SANDBOX_KEY_PUBLIC_PEM_REQUIRED'});assert.equal(parsed,0);}finally{crypto.createPublicKey=parse;}
});
test('malformed public DER and valid non-Ed25519 public keys are refused',()=>{const {env}=fixture();assert.throws(()=>validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:'-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----\n'}),{code:'SANDBOX_KEY_ED25519_REQUIRED'});const k=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey;assert.throws(()=>validate({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM:k.export({format:'pem',type:'spki'}),PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256:fingerprint(k)}),{code:'SANDBOX_KEY_ED25519_REQUIRED'});});
test('validation errors contain no environment or key material',()=>{const {env}=fixture();env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256='0'.repeat(64);try{validate(env);assert.fail();}catch(e){assert.equal(e.code,'SANDBOX_KEY_FINGERPRINT_MISMATCH');assert(!String(e).includes(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM));assert(!JSON.stringify(e).includes(env.DB_PASS));}});
if(process.platform!=='linux'||process.env.UNICLIPS_KEY_DELIVERY_FIXTURE!=='isolated-container-v1'){
 test('delivery remains scoped to the Linux Render app process',()=>assert.throws(()=>deliver({...fixture().env,RENDER:'false'}),{code:'SANDBOX_KEY_DELIVERY_SCOPE_REQUIRED'}));
}else{
 if(process.geteuid()!==0)throw Error('TASK_OWNED_FIXTURE_REQUIRED');
 test('fingerprint validation occurs before any directory or file creation',()=>{const {env}=fixture(),mkdir=fs.mkdtempSync;fs.mkdtempSync=()=>{throw Error('UNVALIDATED_KEY_COPY_FORBIDDEN');};try{assert.throws(()=>deliver({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256:'0'.repeat(64)}),{code:'SANDBOX_KEY_FINGERPRINT_MISMATCH'});}finally{fs.mkdtempSync=mkdir;}});
 test('pinned environment key becomes a 0600 regular file in a 0700 directory; cleanup is idempotent',()=>{
  const {env}=fixture(),d=deliver(env);try{assert.equal(fs.readFileSync(d.file,'utf8'),env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM);assert(!fs.lstatSync(d.file).isSymbolicLink());assert.equal(fs.statSync(d.file).mode&0o7777,0o600);assert.equal(fs.statSync(require('node:path').dirname(d.file)).mode&0o7777,0o700);d.assertUnchanged(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM);}finally{d.cleanup();d.cleanup();}assert(!fs.existsSync(d.file));
 });
 test('no old Secret File is accessed; destination open uses no-follow and exclusive creation',()=>{
  const {env}=fixture(),open=fs.openSync;const seen=[];fs.openSync=(p,f,...args)=>{assert(p.startsWith('/tmp/uniclips-owner-public-'));seen.push(f);return open(p,f,...args);};let d;try{d=deliver({...env,PAYSTACK_NG_AUTHORITY_PUBLIC_KEY:'/etc/secrets/obsolete.pem'});assert.equal(seen.length,1);assert(seen[0]&fs.constants.O_NOFOLLOW);assert(seen[0]&fs.constants.O_EXCL);assert(seen[0]&fs.constants.O_NONBLOCK);}finally{fs.openSync=open;if(d)d.cleanup();}
 });
 test('a preexisting destination symlink is never followed or overwritten',()=>{
  const {env}=fixture(),open=fs.openSync;fs.writeFileSync('/tmp/public-key-canary','UNCHANGED');fs.openSync=(p,...args)=>{if(p.startsWith('/tmp/uniclips-owner-public-'))fs.symlinkSync('/tmp/public-key-canary',p);return open(p,...args);};try{assert.throws(()=>deliver(env),{code:'EEXIST'});assert.equal(fs.readFileSync('/tmp/public-key-canary','utf8'),'UNCHANGED');}finally{fs.openSync=open;}
 });
 test('destination inode, content, type, hardlink and permission substitutions are refused',()=>{
  for(const mutate of [d=>fs.chmodSync(d.file,0o644),d=>fs.writeFileSync(d.file,fixture().env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM),d=>{fs.unlinkSync(d.file);fs.mkdirSync(d.file);},d=>{fs.unlinkSync(d.file);fs.symlinkSync('/tmp/public-key-canary',d.file);},d=>fs.linkSync(d.file,d.file+'.extra'),d=>fs.chmodSync(require('node:path').dirname(d.file),0o755)]){
   const {env}=fixture(),d=deliver(env);try{mutate(d);assert.throws(()=>d.assertUnchanged(env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM));}finally{fs.chmodSync(require('node:path').dirname(d.file),0o700);if(fs.lstatSync(d.file).isDirectory())fs.rmdirSync(d.file);if(fs.existsSync(d.file+'.extra'))fs.unlinkSync(d.file+'.extra');d.cleanup();}
  }
 });
 test('destination corruption during descriptor write is rejected',()=>{
  const {env}=fixture(),write=fs.writeFileSync;fs.writeFileSync=(p,data,...args)=>typeof p==='number'?write(p,Buffer.alloc(data.length,0),...args):write(p,data,...args);try{assert.throws(()=>deliver(env),{code:'SANDBOX_KEY_DESTINATION_CHANGED'});}finally{fs.writeFileSync=write;}
 });
 test('non-sticky writable temp parent is refused',()=>{const {env}=fixture();fs.chmodSync('/tmp',0o777);try{assert.throws(()=>deliver(env),{code:'SANDBOX_KEY_TEMP_DIRECTORY_WRITABLE'});}finally{fs.chmodSync('/tmp',0o1777);}});
 test('unexpected temp parent types and unsafe permissions are refused',()=>{
  const {env}=fixture(),lstat=fs.lstatSync;fs.lstatSync=(p,...a)=>p==='/tmp'?{isDirectory:()=>false,isSymbolicLink:()=>true,uid:0n,mode:0o777n}:lstat(p,...a);try{assert.throws(()=>deliver(env),{code:'SANDBOX_KEY_DIRECTORY_UNSAFE'});}finally{fs.lstatSync=lstat;}
 });
 test('unsafe generated paths are refused',()=>{const mkdir=fs.mkdtempSync;fs.mkdtempSync=()=>'/tmp/../../untrusted';try{assert.throws(()=>deliver(fixture().env),{code:'SANDBOX_KEY_DESTINATION_UNSAFE'});}finally{fs.mkdtempSync=mkdir;}});
 for(const patch of [{RENDER:'false'},{DB_USER:'psngsandboxmigrator'},{RENDER_SERVICE_ID:''},{NODE_ENV:'production'},{DB_NAME:'production'},{PAYSTACK_NG_LIVE_CHECKOUT:'enabled'}])test('scope is fail closed: '+Object.keys(patch)[0],()=>assert.throws(()=>deliver({...fixture().env,...patch})));
}
