'use strict';
// Native TLS/absolute-deadline checks in the cached Linux runner, loopback only.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),https=require('node:https'),tls=require('node:tls');
const {createTransport}=require('../src/services/paystackNigeria/provider');
if(process.platform!=='linux')throw Error('Linux fixture required');
test('actual HTTPS verifies CA/hostname and destroys an active trickled response at the total deadline without retry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'paystack-transport-tls-'));let server,timer,requests=0,mode='success';
 try{
  const openssl=args=>{const r=cp.spawnSync('/usr/bin/openssl',args,{cwd:dir,encoding:'utf8',timeout:10000});assert.equal(r.status,0);};
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Synthetic Paystack CA']);
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=api.paystack.co']);
  fs.writeFileSync(path.join(dir,'extensions'),'subjectAltName=DNS:api.paystack.co\n');openssl(['x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','extensions']);
  server=https.createServer({key:fs.readFileSync(path.join(dir,'server.key')),cert:fs.readFileSync(path.join(dir,'server.pem'))},(req,res)=>{requests++;assert.equal(req.url,'/transaction/verify/fixture');res.writeHead(200,{'content-type':'application/json'});if(mode==='success')res.end('{"status":true}');else{res.write('{"status":');timer=setInterval(()=>res.write(' '),15);res.once('close',()=>clearInterval(timer));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const request=(options,callback)=>{assert.equal(options.hostname,'api.paystack.co');assert.equal(options.rejectUnauthorized,true);return https.request({...options,hostname:'127.0.0.1',port,ca:fs.readFileSync(path.join(dir,'ca.pem')),checkServerIdentity:(host,cert)=>tls.checkServerIdentity('api.paystack.co',cert)},callback);};
  const auth='Bearer '+crypto.randomBytes(16).toString('hex');assert.equal((await createTransport({request})('GET','/transaction/verify/fixture',auth)).data.status,true);assert.equal(requests,1);
  const bad=(options,callback)=>https.request({...options,hostname:'127.0.0.1',port,servername:'wrong.example.invalid',ca:fs.readFileSync(path.join(dir,'ca.pem'))},callback);
  await assert.rejects(createTransport({request:bad})('GET','/transaction/verify/fixture',auth));assert.equal(requests,1);
  mode='trickle';const start=Date.now();await assert.rejects(createTransport({request,deadlineMs:200})('GET','/transaction/verify/fixture',auth),{code:'PAYSTACK_DEADLINE_EXCEEDED'});assert(Date.now()-start<2000);assert.equal(requests,2);
 }finally{clearInterval(timer);if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'paystack-transport-tls-'));fs.rmSync(dir,{recursive:true,force:true});}
});
