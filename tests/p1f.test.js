'use strict';
// Synthetic mail, localhost SMTP and generated localhost-only certificates. No dotenv.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),tls=require('node:tls');
if(process.env.P1F_ISOLATED_TEST!=='1')throw Error('Explicit isolated P1-F flag required');
const nodemailer=require('nodemailer'),{createEmailService,mailbox,transportOptions}=require('../src/utils/emailService');
const env={FRONTEND_URL:'https://frontend.example.invalid',EMAIL_USER:'sender@example.invalid',EMAIL_PASSWORD:'SYNTHETIC_SMTP_PASSWORD'};
const url=env.FRONTEND_URL+'/reset-password?token=SYNTHETIC_TOKEN&email=user%40example.invalid';
function harness({sendFailure,createFailure,verifyFailure,closeFailure}={}){
 const state={options:[],mail:[],logs:[],closed:0};
 const logger={log:(...a)=>state.logs.push(a),error:(...a)=>state.logs.push(a)};
 const mailer={createTransport(options){state.options.push(options);if(createFailure)throw createFailure;return{sendMail:async message=>{state.mail.push(message);if(sendFailure)throw sendFailure;return{messageId:'fixture-message-id'};},verify:async()=>{if(verifyFailure)throw verifyFailure;return true;},close(){state.closed++;if(closeFailure)throw closeFailure;}};}};
 return{state,service:createEmailService({env,mailer,logger})};
}
test('stored mailbox normalization is bounded, single-recipient and IDN compatible',async()=>{
 assert.equal(await mailbox('USER@EXAMPLE.INVALID'),'user@example.invalid');
 assert.equal(await mailbox('learner@bücher.example'),'learner@xn--bcher-kva.example');
 for(const value of [null,{},['user@example.invalid'],'x'.repeat(255)+'@example.invalid','User <user@example.invalid>','a@example.invalid,b@example.invalid','a@example.invalid\r\nBcc:x@example.invalid',' user@example.invalid ','"quoted"@example.invalid','a@example.invalid;'])await assert.rejects(mailbox(value));
});
test('reset uses address objects and explicit single-recipient envelope, escaping HTML and keeping plain link',async()=>{
 const h=harness();const result=await h.service.sendPasswordResetEmail('USER@EXAMPLE.INVALID',url,'<img src=x onerror=alert(1)> & "Learner"');
 assert.equal(result.success,true);assert.deepEqual(h.state.mail[0].to,{address:'user@example.invalid'});assert.deepEqual(h.state.mail[0].envelope,{from:'sender@example.invalid',to:['user@example.invalid']});
 assert.ok(h.state.mail[0].html.includes('&lt;img'));assert.ok(h.state.mail[0].html.includes('&amp;email='));assert.ok(h.state.mail[0].text.includes(url));assert.ok(h.state.mail[0].text.includes('30 minutes'));assert.doesNotMatch(h.state.mail[0].html,/<img src=x/);assert.equal(h.state.closed,1);
 assert.equal(JSON.stringify(h.state.logs).includes('SYNTHETIC_TOKEN'),false);
});
test('verification mail escapes provider requirements and user names without altering the verified link',async()=>{
 const h=harness(),link='https://connect.stripe.com/setup/e/fixture?x=1&y=2';const result=await h.service.sendStripeVerificationEmail('scholar@example.invalid',link,'<Scholar>',['individual.first_name','<script>not executable</script>']);
 assert.equal(result.success,true);assert.match(h.state.mail[0].html,/&lt;script&gt;/);assert.match(h.state.mail[0].html,/&lt;Scholar&gt;/);assert.ok(h.state.mail[0].text.includes(link));assert.doesNotMatch(h.state.mail[0].html,/<script>/);
});
test('hostile templates, oversized requirements and unapproved links fail before transport creation',async()=>{
 const reset=[['x'.repeat(257),url],['name\r\nBcc',url],['User','http://frontend.example.invalid/reset-password'],['User','https://attacker.example.invalid/reset-password'],['User','https://user:pass@frontend.example.invalid/reset-password'],['User',url+'#fragment'],['User',env.FRONTEND_URL+'/different']];
 for(const[name,link]of reset){const h=harness();assert.equal((await h.service.sendPasswordResetEmail('user@example.invalid',link,name)).success,false);assert.equal(h.state.options.length,0);}
 for(const[link,requirements]of [['https://stripe.com.attacker.invalid/link',[]],['javascript:alert(1)',[]],['https://connect.stripe.com/link',Array(101).fill('fixture')],['https://connect.stripe.com/link',[{}]],['https://connect.stripe.com/link',['x'.repeat(257)]]]){const h=harness();assert.equal((await h.service.sendStripeVerificationEmail('user@example.invalid',link,'User',requirements)).success,false);assert.equal(h.state.options.length,0);}
});
test('construction, delivery and cleanup failures expose no recipient, link, credentials or raw error',async()=>{
 const error=Object.assign(Error(url+' '+env.EMAIL_PASSWORD),{code:'EAUTH',response:url,command:env.EMAIL_PASSWORD});
 for(const fixture of [{createFailure:error},{sendFailure:error},{sendFailure:error,closeFailure:error}]){const h=harness(fixture),result=await h.service.sendPasswordResetEmail('user@example.invalid',url);assert.deepEqual(result,{success:false,error:'Email delivery failed'});assert.doesNotMatch(JSON.stringify(h.state.logs),/SYNTHETIC_|user@example|https:/);}
});
test('configuration verification remains opt-in and returns only safe status, including failure',async()=>{
 for(const verifyFailure of [undefined,Object.assign(Error('SYNTHETIC_PASSWORD'),{code:'ESOCKET'})]){const h=harness({verifyFailure});assert.equal(h.state.options.length,0);assert.equal(await h.service.verifyEmailConfig(),!verifyFailure);assert.equal(h.state.mail.length,0);assert.equal(h.state.closed,1);assert.doesNotMatch(JSON.stringify(h.state.logs),/SYNTHETIC_PASSWORD/);}
});
test('transport remains nonpooled with bounded deadlines, safe content access and explicit optional STARTTLS',()=>{
 const options=transportOptions(env);assert.equal(options.requireTLS,false);assert.equal(options.service,'gmail');assert.equal(options.port,587);assert.equal(options.secure,false);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);assert.equal(options.logger,false);assert.equal(options.debug,false);assert.equal(options.opportunisticTLS,false);assert.equal(options.connectionTimeout,15000);assert.equal(transportOptions({...env,EMAIL_REQUIRE_TLS:'true'}).requireTLS,true);
 for(const extra of [{EMAIL_PORT:'587garbage'},{EMAIL_PORT:'0'},{EMAIL_PORT:'65536'},{EMAIL_REQUIRE_TLS:'maybe'},{EMAIL_SECURE:'yes'}])assert.throws(()=>transportOptions({...env,...extra}));
});
test('actual installed Nodemailer compiles both safe templates using stream transport without network',async()=>{
 const messages=[];const mailer={createTransport:()=>{const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix',disableFileAccess:true,disableUrlAccess:true});return{sendMail:async message=>{const result=await transport.sendMail(message);messages.push(result);return result;},close:()=>transport.close()};}};
 const service=createEmailService({env,mailer,logger:{log(){},error(){}}});assert.equal((await service.sendPasswordResetEmail('user@example.invalid',url,'Synthetic')).success,true);assert.equal((await service.sendStripeVerificationEmail('user@example.invalid','https://connect.stripe.com/setup/e/fixture','Scholar',['business_profile.url'])).success,true);
 for(const message of messages){assert.deepEqual(message.envelope.to,['user@example.invalid']);const mime=message.message.toString();assert.match(mime,/multipart\/alternative/);assert.match(mime,/To: user@example.invalid/);assert.doesNotMatch(mime,/^Bcc:/m);assert.match(mime,/Content-Type: text\/html/);}
});
let certificate;
function cert(){
 if(certificate)return certificate;
 const executable=process.env.P1F_OPENSSL;if(!executable||!fs.existsSync(executable))throw Error('Local OpenSSL fixture executable required');
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-p1f-synthetic-tls-')),key=path.join(folder,'key.pem'),pem=path.join(folder,'cert.pem');
 cp.execFileSync(executable,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',pem,'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore',env:{...process.env,MSYS_NO_PATHCONV:'1'}});
 certificate={key:fs.readFileSync(key),cert:fs.readFileSync(pem)};
 // Only these two generated synthetic files; no recursive cleanup.
 fs.unlinkSync(key);fs.unlinkSync(pem);fs.rmdirSync(folder);return certificate;
}
async function smtp(t,{starttls=false,implicit=false}={}){
 const sockets=new Set(),state={auth:0,messages:[],tls:0};let context;
 if(starttls||implicit)context=tls.createSecureContext(cert());
 function session(socket,greeting=true){
  sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let buffer='',data=false,message='';
  const handler=chunk=>{buffer+=chunk.toString();while(buffer.includes('\r\n')){const at=buffer.indexOf('\r\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+2);
   if(data){if(line==='.') {data=false;state.messages.push(message);socket.write('250 2.0.0 queued\r\n');}else message+=line+'\r\n';continue;}
   if(/^EHLO|^HELO/.test(line)){socket.write('250-localhost\r\n'+(starttls&&!socket.encrypted?'250-STARTTLS\r\n':'')+'250 AUTH PLAIN\r\n');}
   else if(line==='STARTTLS'&&starttls&&!socket.encrypted){socket.removeListener('data',handler);socket.write('220 Ready to start TLS\r\n',()=>{const secure=new tls.TLSSocket(socket,{isServer:true,secureContext:context});state.tls++;session(secure,false);});return;}
   else if(line.startsWith('AUTH ')){state.auth++;socket.write('235 2.7.0 authenticated\r\n');}
   else if(line.startsWith('MAIL FROM:')||line.startsWith('RCPT TO:')||line==='RSET')socket.write('250 2.0.0 ok\r\n');
   else if(line==='DATA'){data=true;socket.write('354 End with dot\r\n');}
   else if(line==='QUIT'){socket.end('221 Bye\r\n');}else socket.write('502 unsupported\r\n');
  }};
  socket.on('data',handler);if(greeting)socket.write('220 localhost fixture\r\n');
 }
 const server=implicit?tls.createServer(cert(),socket=>{state.tls++;session(socket);}):net.createServer(session);
 server.on('tlsClientError',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 return{state,port:server.address().port};
}
function localService(port,{secure=false,trust=false,required=true}={}){
 const logs=[];const mailer={createTransport:options=>nodemailer.createTransport({...options,tls:{rejectUnauthorized:true,servername:'localhost',...(trust?{ca:cert().cert}:{})}})};
 return{logs,service:createEmailService({env:{...env,EMAIL_SERVICE:'synthetic-local-only',EMAIL_HOST:'127.0.0.1',EMAIL_PORT:String(port),EMAIL_SECURE:String(secure),EMAIL_REQUIRE_TLS:String(required)},mailer,logger:{log:(...x)=>logs.push(x),error:(...x)=>logs.push(x)}})};
}
test('required STARTTLS refuses plaintext-only SMTP before AUTH or DATA',async t=>{
 const fixture=await smtp(t),h=localService(fixture.port);assert.equal((await h.service.sendPasswordResetEmail('user@example.invalid',url)).success,false);assert.equal(fixture.state.auth,0);assert.equal(fixture.state.messages.length,0);assert.doesNotMatch(JSON.stringify(h.logs),/SYNTHETIC_|user@example|https:/);
});
test('verified STARTTLS accepts the synthetic certificate and delivers one message over TLS',async t=>{
 const fixture=await smtp(t,{starttls:true}),h=localService(fixture.port,{trust:true});assert.equal((await h.service.sendPasswordResetEmail('user@example.invalid',url)).success,true);assert.equal(fixture.state.tls,1);assert.equal(fixture.state.auth,1);assert.equal(fixture.state.messages.length,1);
});
test('untrusted STARTTLS certificate prevents credentials and message delivery',async t=>{
 const fixture=await smtp(t,{starttls:true}),h=localService(fixture.port);assert.equal((await h.service.sendPasswordResetEmail('user@example.invalid',url)).success,false);assert.equal(fixture.state.auth,0);assert.equal(fixture.state.messages.length,0);
});
test('implicit TLS works with trusted localhost certificate and rejects untrusted certificate',async t=>{
 const fixture=await smtp(t,{implicit:true}),h=localService(fixture.port,{secure:true,trust:true,required:false});assert.equal((await h.service.sendStripeVerificationEmail('user@example.invalid','https://connect.stripe.com/setup/e/fixture')).success,true);
 const rejected=localService(fixture.port,{secure:true,required:false});assert.equal((await rejected.service.sendPasswordResetEmail('user@example.invalid',url)).success,false);assert.equal(fixture.state.messages.length,1);assert.equal(fixture.state.auth,1);
});
