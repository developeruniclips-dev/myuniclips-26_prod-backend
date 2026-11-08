'use strict';
// Render sandbox only: a pinned PUBLIC PEM becomes a private regular file.
// No Secret File reads, arbitrary paths, filesystem fallback or private parsing.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const LIMIT=4096;
const stop=code=>{throw Object.assign(new Error('Sandbox public key delivery refused'),{code});};
const hash=b=>crypto.createHash('sha256').update(b).digest();
const stat=p=>fs.lstatSync(p,{bigint:true});
const same=(a,b)=>['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
function validatePublicKeyEnvironment(env){
 const pem=env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM,expected=env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256;
 if(typeof pem!=='string'||!pem||Buffer.byteLength(pem)>LIMIT)stop('SANDBOX_KEY_PUBLIC_ENV_REQUIRED');
 if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))stop('SANDBOX_KEY_FINGERPRINT_REQUIRED');
 // Enforce public-only SPKI before calling any crypto key parser.
 if(!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(pem))stop('SANDBOX_KEY_PUBLIC_PEM_REQUIRED');
 let key;try{key=crypto.createPublicKey({key:pem,format:'pem',type:'spki'});}catch{stop('SANDBOX_KEY_ED25519_REQUIRED');}
 if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')stop('SANDBOX_KEY_ED25519_REQUIRED');
 if(!crypto.timingSafeEqual(hash(key.export({format:'der',type:'spki'})),Buffer.from(expected,'hex')))stop('SANDBOX_KEY_FINGERPRINT_MISMATCH');
 return Buffer.from(pem);
}
function deliverRenderPublicKeyFromEnvironment(env){
 require('./isolation').settings(env);
 if(process.platform!=='linux'||env.RENDER!=='true'||env.DB_USER!=='psngsandboxapp'||!/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE_ID||''))stop('SANDBOX_KEY_DELIVERY_SCOPE_REQUIRED');
 const bytes=validatePublicKeyEnvironment(env),uid=process.geteuid();
 const parent=stat('/tmp');
 if(!parent.isDirectory()||parent.isSymbolicLink()||![0,uid].includes(Number(parent.uid))||fs.realpathSync('/tmp')!=='/tmp')stop('SANDBOX_KEY_DIRECTORY_UNSAFE');
 if((Number(parent.mode)&0o022)!==0&&!(Number(parent.uid)===0&&(Number(parent.mode)&0o1000)!==0))stop('SANDBOX_KEY_TEMP_DIRECTORY_WRITABLE');
 const nofollow=fs.constants.O_NOFOLLOW,nonblock=fs.constants.O_NONBLOCK;
 if(!nofollow||!nonblock)stop('SANDBOX_KEY_NOFOLLOW_REQUIRED');
 let directory,file,dirStat,fileStat,fd;
 function privateDirectory(){
  const d=stat(directory);
  if(!d.isDirectory()||d.isSymbolicLink()||d.dev!==dirStat.dev||d.ino!==dirStat.ino||Number(d.uid)!==uid||
     (Number(d.mode)&0o7777)!==0o700||fs.realpathSync(directory)!==directory)stop('SANDBOX_KEY_DESTINATION_UNSAFE');
 }
 function cleanup(){
  if(!directory||!dirStat)return;
  privateDirectory();
  if(file)try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
  fs.rmdirSync(directory);directory=undefined;
 }
 try{
  directory=fs.mkdtempSync('/tmp/uniclips-owner-public-');
  if(!/^\/tmp\/uniclips-owner-public-[A-Za-z0-9]{6}$/.test(directory))stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  dirStat=stat(directory);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||Number(dirStat.uid)!==uid||fs.realpathSync(directory)!==directory)stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  fs.chmodSync(directory,0o700);dirStat=stat(directory);privateDirectory();
  file=path.join(directory,'authority-public.pem');
  fd=fs.openSync(file,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow|nonblock,0o600);
  fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fileStat=fs.fstatSync(fd,{bigint:true});
  if(!fileStat.isFile()||fileStat.nlink!==1n||Number(fileStat.uid)!==uid||(Number(fileStat.mode)&0o777)!==0o600||fileStat.size!==BigInt(bytes.length))stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  const readback=Buffer.alloc(bytes.length);
  if(fs.readSync(fd,readback,0,readback.length,0)!==readback.length||!crypto.timingSafeEqual(hash(readback),hash(bytes)))stop('SANDBOX_KEY_DESTINATION_CHANGED');
  fs.closeSync(fd);fd=undefined;
  function assertUnchanged(value){
   privateDirectory();const s=stat(file);
   if(!s.isFile()||s.isSymbolicLink()||!same(s,fileStat)||(value!==undefined&&!crypto.timingSafeEqual(hash(Buffer.from(value)),hash(bytes))))stop('SANDBOX_KEY_DESTINATION_CHANGED');
  }
  assertUnchanged();
  return{file,assertUnchanged,cleanup};
 }catch(error){if(fd!==undefined){try{fs.closeSync(fd);}catch{}}try{cleanup();}catch{}throw error;}
}
module.exports={validatePublicKeyEnvironment,deliverRenderPublicKeyFromEnvironment};
