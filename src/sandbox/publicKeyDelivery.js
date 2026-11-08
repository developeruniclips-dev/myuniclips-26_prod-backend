'use strict';
// Only the dedicated Render sandbox's public authority mount is eligible.
// Source links are resolved inside the trusted mount, never accepted by startup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SOURCE='/etc/secrets/paystack-authority-public.pem',ROOT='/etc/secrets',LIMIT=4096;
const stop=code=>{throw Object.assign(new Error('Sandbox public key delivery refused'),{code});};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function same(a,b){return ['dev','ino','mode','uid','gid','size','mtimeNs','ctimeNs','nlink'].every(k=>a[k]===b[k]);}
function stat(file){return fs.lstatSync(file,{bigint:true});}
function directory(file,uid,temporary=false){
 const s=stat(file),mode=Number(s.mode),owner=Number(s.uid);
 if(!s.isDirectory()||s.isSymbolicLink()||![0,uid].includes(owner)||
    ((mode&0o022)!==0&&!(temporary&&owner===0&&(mode&0o1000)!==0)))stop('SANDBOX_KEY_DIRECTORY_UNSAFE');
 return s;
}
function publicFile(s,uid){
 if(!s.isFile()||s.isSymbolicLink()||!s.size||s.size>BigInt(LIMIT)||s.nlink!==1n||
    ![0,uid].includes(Number(s.uid))||(Number(s.mode)&0o7111)!==0||(Number(s.mode)&0o022)!==0)stop('SANDBOX_KEY_SOURCE_UNSAFE');
}
function publicPem(bytes){
 const text=bytes.toString('utf8');
 // Check the public-only envelope BEFORE invoking any crypto key parser.
 if(!Buffer.from(text).equals(bytes)||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(text))stop('SANDBOX_KEY_PUBLIC_PEM_REQUIRED');
 let key;try{key=crypto.createPublicKey({key:bytes,format:'pem',type:'spki'});}catch{stop('SANDBOX_KEY_ED25519_REQUIRED');}
 if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')stop('SANDBOX_KEY_ED25519_REQUIRED');
 return bytes;
}
function deliverRenderPublicKey(env){
 require('./isolation').settings(env);
 if(process.platform!=='linux'||env.RENDER!=='true'||env.DB_USER!=='psngsandboxapp'||env.PAYSTACK_NG_AUTHORITY_PUBLIC_KEY!==SOURCE||
    !/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE_ID||''))stop('SANDBOX_KEY_DELIVERY_SCOPE_REQUIRED');
 const uid=process.geteuid(),parents=new Map();
 for(const p of ['/','/etc',ROOT])parents.set(p,directory(p,uid));
 if(fs.realpathSync(ROOT)!==ROOT)stop('SANDBOX_KEY_SOURCE_ESCAPE');
 const entry=stat(SOURCE);
 if(!entry.isFile()&&!entry.isSymbolicLink())stop('SANDBOX_KEY_SOURCE_UNSAFE');
 if(![0,uid].includes(Number(entry.uid)))stop('SANDBOX_KEY_SOURCE_UNSAFE');
 const resolved=fs.realpathSync(SOURCE),relative=path.relative(ROOT,resolved);
 if(!relative||relative==='..'||relative.startsWith('../')||path.isAbsolute(relative)||path.basename(resolved)!==path.basename(SOURCE))stop('SANDBOX_KEY_SOURCE_ESCAPE');
 let parent=path.dirname(resolved);
 while(parent!==ROOT){parents.set(parent,directory(parent,uid));parent=path.dirname(parent);}
 const sourceStat=stat(resolved);publicFile(sourceStat,uid);
 const nofollow=fs.constants.O_NOFOLLOW,nonblock=fs.constants.O_NONBLOCK;
 if(!nofollow||!nonblock)stop('SANDBOX_KEY_NOFOLLOW_REQUIRED');
 let fd,dir,destination,destinationStat,dirStat;
 function cleanup(){
  if(!dir)return;
  const current=stat(dir);
  if(current.dev!==dirStat.dev||current.ino!==dirStat.ino||Number(current.uid)!==uid||Number(current.mode)&0o077||!current.isDirectory()||current.isSymbolicLink())stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  if(destination&&fs.existsSync(destination))fs.unlinkSync(destination);
  fs.rmdirSync(dir);dir=undefined;
 }
 try{
  fd=fs.openSync(resolved,fs.constants.O_RDONLY|nofollow|nonblock);
  const opened=fs.fstatSync(fd,{bigint:true});publicFile(opened,uid);
  if(!same(opened,sourceStat)||fs.realpathSync('/proc/self/fd/'+fd)!==resolved)stop('SANDBOX_KEY_SOURCE_CHANGED');
  const prefix=Buffer.alloc(26);
  if(fs.readSync(fd,prefix,0,prefix.length,0)!==prefix.length||prefix.toString()!=='-----BEGIN PUBLIC KEY-----')stop('SANDBOX_KEY_PUBLIC_PEM_REQUIRED');
  const bytes=Buffer.alloc(Number(opened.size));let offset=0;
  while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)stop('SANDBOX_KEY_SOURCE_CHANGED');offset+=n;}
  publicPem(bytes);
  if(!same(opened,fs.fstatSync(fd,{bigint:true}))||!same(sourceStat,stat(resolved))||!same(entry,stat(SOURCE))||fs.realpathSync(SOURCE)!==resolved)stop('SANDBOX_KEY_SOURCE_CHANGED');
  for(const [p,s]of parents)if(!same(s,directory(p,uid)))stop('SANDBOX_KEY_SOURCE_CHANGED');
  fs.closeSync(fd);fd=undefined;
  directory('/tmp',uid,true);
  if(fs.realpathSync('/tmp')!=='/tmp')stop('SANDBOX_KEY_DIRECTORY_UNSAFE');
  dir=fs.mkdtempSync('/tmp/uniclips-owner-public-');fs.chmodSync(dir,0o700);dirStat=directory(dir,uid);
  if(Number(dirStat.uid)!==uid||(Number(dirStat.mode)&0o777)!==0o700||fs.realpathSync(dir)!==dir)stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  destination=path.join(dir,'authority-public.pem');
  fd=fs.openSync(destination,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|nofollow|nonblock,0o600);
  fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);destinationStat=fs.fstatSync(fd,{bigint:true});
  if(!destinationStat.isFile()||destinationStat.nlink!==1n||Number(destinationStat.uid)!==uid||(Number(destinationStat.mode)&0o777)!==0o600||destinationStat.size!==BigInt(bytes.length))stop('SANDBOX_KEY_DESTINATION_UNSAFE');
  fs.closeSync(fd);fd=undefined;
  function assertUnchanged(value){
   const d=directory(dir,uid);
   if(d.dev!==dirStat.dev||d.ino!==dirStat.ino||Number(d.uid)!==uid||(Number(d.mode)&0o777)!==0o700||fs.realpathSync(dir)!==dir||
      !same(destinationStat,stat(destination))||!stat(destination).isFile()||stat(destination).isSymbolicLink()||
      (value!==undefined&&hash(Buffer.from(value))!==hash(bytes)))stop('SANDBOX_KEY_DESTINATION_CHANGED');
  }
  assertUnchanged();
  return {file:destination,assertUnchanged,cleanup};
 }catch(error){if(fd!==undefined){try{fs.closeSync(fd);}catch{}}try{cleanup();}catch{}throw error;}
}
module.exports={deliverRenderPublicKey};
