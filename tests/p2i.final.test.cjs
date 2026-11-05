'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
if(process.env.P2I_ISOLATED_TEST!=='1')throw Error('Isolated P2-I flag required');
const Stripe=require('stripe'),{findBoundedTransfers}=require('../src/services/payments/boundedTransfers'),{reconciliationReadClient}=require('../src/services/payments/reconciliationReadClient');
test('Reconciliation transport settles resets/partial bodies, never retries, and retains account/auth/version context',async()=>{
 let mode='reset',calls=0,closed=0;const sockets=new Set(),auth='sk_'+crypto.randomBytes(16).toString('hex');
 const transfer={id:'tr_fixture',transfer_group:'order_fixture',amount:420,currency:'eur',destination:'acct_fixture',source_transaction:'ch_fixture',metadata:{orderId:'fixture'},reversed:false};
 const server=http.createServer((q,s)=>{calls++;assert.equal(q.headers.authorization,'Bearer '+auth);assert.equal(q.headers['stripe-account'],'acct_context');assert.equal(q.headers['stripe-version'],'2024-06-20');assert.equal(q.method,'GET');assert.match(q.url,/limit=2/);
  if(mode==='reset')return q.socket.destroy();
  s.writeHead(mode==='reject'?503:200,{'content-type':'application/json','stripe-should-retry':'true'});
  if(mode==='partial'){s.write('{"data":[');setTimeout(()=>s.destroy(),20);return;}
  if(mode==='malformed')return s.end('{');
  s.end(JSON.stringify(mode==='reject'?{error:{message:'synthetic'}}:{object:'list',has_more:false,data:[transfer]}));
 });server.on('connection',s=>{sockets.add(s);s.on('close',()=>{closed++;sockets.delete(s);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const original=new Stripe(auth,{host:'127.0.0.1',port:server.address().port,protocol:'http',apiVersion:'2024-06-20',stripeAccount:'acct_context',maxNetworkRetries:2,timeout:80000}),transport=original.getApiField('httpClient');
 for(const value of ['reset','partial','malformed','reject','valid']){mode=value;const before=calls,start=Date.now(),result=await findBoundedTransfers(original,'order_fixture');assert.equal(calls-before,1,value);assert.equal(result.length,value==='valid'?1:0);assert.ok(Date.now()-start<5000,value+' settles without waiting for deadline');}
 assert.equal(original.getApiField('httpClient'),transport);assert.equal(original.getApiField('timeout'),80000);assert.equal(original.getApiField('maxNetworkRetries'),2);assert.notEqual(reconciliationReadClient(original),original);assert.equal(reconciliationReadClient(original),reconciliationReadClient(original));
 const before=calls;await assert.rejects(reconciliationReadClient(original).transfers.create({amount:1,currency:'eur',destination:'acct_fixture'}));assert.equal(calls,before,'read transport cannot execute financial writes');assert.ok(closed>=2);
 }finally{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
test('Reconciliation absolute transport deadline destroys inactive and trickling responses before releasing read',async()=>{
 for(const trickle of [false,true]){let calls=0,closed=0;const sockets=new Set(),intervals=new Set();const server=http.createServer((_q,s)=>{calls++;if(trickle){s.writeHead(200,{'content-type':'application/json'});s.write('{"object":"list",');const timer=setInterval(()=>s.write(' '),50);intervals.add(timer);s.on('close',()=>{clearInterval(timer);intervals.delete(timer);});}});server.on('connection',s=>{sockets.add(s);s.on('close',()=>{closed++;sockets.delete(s);});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const stripe=new Stripe('sk_'+crypto.randomBytes(16).toString('hex'),{host:'127.0.0.1',port:server.address().port,protocol:'http'}),start=Date.now();assert.deepEqual(await findBoundedTransfers(stripe,'order_fixture'),[]);assert.equal(calls,1);assert.ok(Date.now()-start>=9000);assert.ok(Date.now()-start<18000);await new Promise(r=>setTimeout(r,30));assert.equal(closed,1);assert.equal(sockets.size,0);}
 finally{for(const i of intervals)clearInterval(i);for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
 }
});
test('Scoped reconciliation HTTPS preserves certificate/hostname verification and original agent',async()=>{
 const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),https=require('https');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'p2i-final-local-tls-')),key=path.join(directory,'key.pem'),pem=path.join(directory,'cert.pem'),openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'/usr/bin/openssl';
 let server;const sockets=new Set();try{cp.execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',pem,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore',windowsHide:true});const cert=fs.readFileSync(pem);let requests=0;
 server=https.createServer({key:fs.readFileSync(key),cert,minVersion:'TLSv1.2'},(q,s)=>{requests++;assert.ok(['TLSv1.2','TLSv1.3'].includes(q.socket.getProtocol()));s.setHeader('content-type','application/json');s.end(JSON.stringify({object:'list',has_more:false,data:[{id:'tr_tls',transfer_group:'order_tls',amount:1,currency:'eur',destination:'acct_tls',source_transaction:'ch_tls',metadata:{},reversed:false}]}));});server.on('tlsClientError',()=>{});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,r));
 for(const [host,trust,expected]of [['localhost',true,1],['localhost',false,0],['127.0.0.1',true,0]]){const agent=new https.Agent({...(trust?{ca:cert}:{}),keepAlive:false}),stripe=new Stripe('sk_'+crypto.randomBytes(16).toString('hex'),{host,port:server.address().port,protocol:'https',httpAgent:agent});assert.equal((await findBoundedTransfers(stripe,'order_tls')).length,expected);assert.equal(stripe.getApiField('agent'),agent);agent.destroy();}assert.equal(requests,1);
 }finally{for(const socket of sockets)socket.destroy();if(server)await new Promise(r=>server.close(r));for(const file of [key,pem])if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(directory);}
});
