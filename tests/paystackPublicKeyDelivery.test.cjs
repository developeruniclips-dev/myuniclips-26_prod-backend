'use strict';
// Linux cases use an isolated container's task-owned /etc/secrets tmpfs only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {deliverRenderPublicKey:deliver}=require('../src/sandbox/publicKeyDelivery');
const env=()=>({RENDER:'true',RENDER_SERVICE_ID:'srv-synthetic',SANDBOX_APPROVAL_MODE:'single-owner-v1',UNICLIPS_SANDBOX:'paystack-test-v1',NODE_ENV:'test',DB_NAME:'uniclipspsngsandbox',DB_USER:'psngsandboxapp',DB_HOST:'db.example.invalid',DB_PASS:String(crypto.randomBytes(24).toString('hex')),DB_SSL:'true',DB_SSL_CA:'inert-ca',PAYMENT_ARCHITECTURE:'legacy_verified',FRONTEND_URL:'https://sandbox.example.invalid',ALLOWED_ORIGINS:'https://sandbox.example.invalid',PAYSTACK_NG_AUTHORITY_PUBLIC_KEY:'/etc/secrets/paystack-authority-public.pem'});
if(process.platform!=='linux'||process.env.UNICLIPS_KEY_DELIVERY_FIXTURE!=='isolated-container-v1'){
 test('key delivery refuses non-Render scope without touching a source file',()=>assert.throws(()=>deliver({...env(),RENDER:'false'}),{code:'SANDBOX_KEY_DELIVERY_SCOPE_REQUIRED'}));
}else{
 if(process.env.UNICLIPS_KEY_DELIVERY_FIXTURE!=='isolated-container-v1'||process.geteuid()!==0)throw Error('TASK_OWNED_LINUX_FIXTURE_REQUIRED');
 const source='/etc/secrets/paystack-authority-public.pem',target='/etc/secrets/version-1/paystack-authority-public.pem';
 const publicKey=()=>crypto.generateKeyPairSync('ed25519').publicKey.export({format:'pem',type:'spki'});
 const privateFixture=()=>crypto.generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
 function setup(){
  assert.equal(fs.realpathSync('/etc/secrets'),'/etc/secrets');
  for(const f of fs.readdirSync('/etc/secrets'))fs.rmSync('/etc/secrets/'+f,{force:true,recursive:true});
  fs.chmodSync('/etc/secrets',0o755);fs.mkdirSync('/etc/secrets/version-1',{mode:0o755});
  const pem=publicKey();fs.writeFileSync(target,pem,{mode:0o444});fs.symlinkSync('version-1/paystack-authority-public.pem',source);return pem;
 }
 test('managed symlink becomes an identical private regular public key, with exclusive descriptor flags',()=>{
  const pem=setup(),open=fs.openSync,flags=[];fs.openSync=(p,f,...a)=>{flags.push(f);return open(p,f,...a);};let d;
  try{d=deliver(env());assert.equal(fs.readFileSync(d.file,'utf8'),pem);assert(!fs.lstatSync(d.file).isSymbolicLink());assert.equal(fs.statSync(d.file).mode&0o777,0o600);assert.equal(fs.statSync(require('node:path').dirname(d.file)).mode&0o777,0o700);d.assertUnchanged(pem);
   assert(flags.every(f=>Boolean(f&fs.constants.O_NOFOLLOW)));assert(flags.some(f=>Boolean(f&fs.constants.O_EXCL)));assert(flags.every(f=>Boolean(f&fs.constants.O_NONBLOCK)));
  }finally{fs.openSync=open;if(d)d.cleanup();}assert(!fs.existsSync(d.file));
 });
 test('a regular managed mount is accepted and later destination substitution is refused',()=>{
  const pem=setup();fs.unlinkSync(source);fs.renameSync(target,source);const d=deliver(env());
  try{fs.unlinkSync(d.file);fs.writeFileSync(d.file,pem,{mode:0o600});assert.throws(()=>d.assertUnchanged(pem),{code:'SANDBOX_KEY_DESTINATION_CHANGED'});}finally{d.cleanup();}
 });
 for(const [name,change,code]of [
  ['outside target',()=>{fs.unlinkSync(source);fs.symlinkSync('/tmp/unexpected-public-key',source);fs.writeFileSync('/tmp/unexpected-public-key',publicKey());},'SANDBOX_KEY_SOURCE_ESCAPE'],
  ['wrong basename',()=>{fs.renameSync(target,'/etc/secrets/version-1/another.pem');fs.unlinkSync(source);fs.symlinkSync('version-1/another.pem',source);},'SANDBOX_KEY_SOURCE_ESCAPE'],
  ['writable mount directory',()=>fs.chmodSync('/etc/secrets',0o777),'SANDBOX_KEY_DIRECTORY_UNSAFE'],
  ['writable target directory',()=>fs.chmodSync('/etc/secrets/version-1',0o775),'SANDBOX_KEY_DIRECTORY_UNSAFE'],
  ['writable key',()=>fs.chmodSync(target,0o666),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['executable key',()=>fs.chmodSync(target,0o755),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['wrong owner',()=>fs.chownSync(target,1001,1001),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['hardlinked key',()=>fs.linkSync(target,'/etc/secrets/version-1/duplicate'),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['directory source',()=>{fs.unlinkSync(source);fs.mkdirSync(source);},'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['oversized key',()=>fs.writeFileSync(target,'x'.repeat(4097)),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['empty key',()=>fs.writeFileSync(target,''),'SANDBOX_KEY_SOURCE_UNSAFE'],
  ['private-key envelope',()=>fs.writeFileSync(target,privateFixture()),'SANDBOX_KEY_PUBLIC_PEM_REQUIRED'],
  ['malformed public key',()=>fs.writeFileSync(target,'-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----\n'),'SANDBOX_KEY_ED25519_REQUIRED'],
  ['wrong public algorithm',()=>fs.writeFileSync(target,crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'pem',type:'spki'})),'SANDBOX_KEY_ED25519_REQUIRED'],
  ['appended private material',()=>fs.appendFileSync(target,privateFixture()),'SANDBOX_KEY_PUBLIC_PEM_REQUIRED']
 ])test('delivery rejects '+name,()=>{setup();change();assert.throws(()=>deliver(env()),{code});});
 test('a private envelope is rejected before body reads, crypto parsing or destination creation',()=>{
  setup();fs.writeFileSync(target,privateFixture());
  const read=fs.readSync,parse=crypto.createPublicKey,mkdir=fs.mkdtempSync;let bytes=0;
  fs.readSync=(...a)=>{const n=read(...a);bytes+=n;return n;};crypto.createPublicKey=()=>{throw Error('PRIVATE_CRYPTO_LOAD_FORBIDDEN');};fs.mkdtempSync=()=>{throw Error('PRIVATE_COPY_FORBIDDEN');};
  try{assert.throws(()=>deliver(env()),{code:'SANDBOX_KEY_PUBLIC_PEM_REQUIRED'});assert.equal(bytes,26);}finally{fs.readSync=read;crypto.createPublicKey=parse;fs.mkdtempSync=mkdir;}
 });
 test('source substitution between stat and open fails closed',()=>{
  setup();const open=fs.openSync;let changed=false;fs.openSync=(p,...a)=>{if(p===target&&!changed){changed=true;fs.unlinkSync(target);fs.writeFileSync(target,publicKey(),{mode:0o444});}return open(p,...a);};
  try{assert.throws(()=>deliver(env()),{code:'SANDBOX_KEY_SOURCE_CHANGED'});}finally{fs.openSync=open;}
 });
 test('source changes during a descriptor read are rejected',()=>{
  setup();const read=fs.readSync;let changed=false;fs.readSync=(...a)=>{const n=read(...a);if(!changed){changed=true;fs.writeFileSync(target,publicKey());}return n;};
  try{assert.throws(()=>deliver(env()));}finally{fs.readSync=read;}
 });
 test('preexisting destination symlink is never followed or overwritten',()=>{
  setup();const open=fs.openSync;let injected;
  fs.openSync=(p,...a)=>{if(p.startsWith('/tmp/uniclips-owner-public-')){injected=p;fs.symlinkSync('/tmp/never-overwrite',p);}return open(p,...a);};
  fs.writeFileSync('/tmp/never-overwrite','UNCHANGED');try{assert.throws(()=>deliver(env()),{code:'EEXIST'});assert.equal(fs.readFileSync('/tmp/never-overwrite','utf8'),'UNCHANGED');assert(!fs.existsSync(injected));}finally{fs.openSync=open;}
 });
 test('post-copy permissions, symlink replacements and content changes are refused',()=>{
  for(const mutate of [d=>fs.chmodSync(d.file,0o644),d=>fs.writeFileSync(d.file,publicKey()),d=>{fs.unlinkSync(d.file);fs.symlinkSync(target,d.file);},d=>fs.chmodSync(require('node:path').dirname(d.file),0o755)]){
   const pem=setup(),d=deliver(env());try{mutate(d);assert.throws(()=>d.assertUnchanged(pem));}finally{fs.chmodSync(require('node:path').dirname(d.file),0o700);d.cleanup();}
  }
 });
 for(const patch of [{RENDER:'false'},{PAYSTACK_NG_AUTHORITY_PUBLIC_KEY:'/tmp/arbitrary.pem'},{DB_USER:'psngsandboxmigrator'},{RENDER_SERVICE_ID:''},{NODE_ENV:'production'},{DB_NAME:'production'}])test('delivery scope remains constrained: '+Object.keys(patch)[0],()=>assert.throws(()=>deliver({...env(),...patch})));
}
