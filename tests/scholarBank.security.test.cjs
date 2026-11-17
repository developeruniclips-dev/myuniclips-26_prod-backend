'use strict';
const test=require('node:test'),a=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),express=require('express');
const {createProvider}=require('../src/services/scholarBank/provider');
const {createMailer}=require('../src/services/scholarBank/mail');
const {createRouter}=require('../src/routes/scholarBankRoutes');
const secret=['sk','test',crypto.randomBytes(24).toString('hex')].join('_');
const recipient={recipient_code:'RCP_SYNTHETIC123',type:'nuban',currency:'NGN',domain:'test',integration:100043,active:true,name:'SYNTHETIC HOLDER',details:{bank_code:'999',account_number:'0000000001',account_name:null}};
const expected={bankCode:'999',accountNumber:'0000000001',accountName:'SYNTHETIC HOLDER',operationId:crypto.randomUUID()};
function provider(respond){return createProvider({secret,merchant:'100043',mode:'test',fetchImpl:respond});}
const response=body=>new Response(JSON.stringify({status:true,...body}),{status:200,headers:{'Content-Type':'application/json'}});
test('provider is restricted to official bank resolve/list and recipient paths, with no transfer method',async()=>{
 const calls=[],p=provider(async(url,init)=>{calls.push({url,init});const path=new URL(url).pathname;if(path==='/bank')return response({data:[{code:'999',name:'Synthetic Bank',active:true}],meta:{next:null}});if(path==='/bank/resolve')return response({data:{account_number:'0000000001',account_name:'SYNTHETIC HOLDER'}});return response({data:recipient});});
 a.equal((await p.banks())[0].code,'999');await p.resolve('999','0000000001');a.equal(await p.create(expected),recipient.recipient_code);await p.inspect(recipient.recipient_code);
 a.equal(calls.length,4);for(const c of calls){a.equal(new URL(c.url).origin,'https://api.paystack.co');a.equal(c.init.redirect,'error');a(c.init.signal);a.equal(c.init.headers.Authorization,'Bearer '+secret);}
 const body=JSON.parse(calls[2].init.body);a.equal(body.type,'nuban');a.equal(body.currency,'NGN');a.equal(body.metadata.uniclips_bank_operation,expected.operationId);
 a.deepEqual(Object.keys(p).sort(),['banks','checkRecipient','create','inspect','resolve']);
});
test('recipient identity rejects merchant/environment/bank/account/currency/type/disabled conflicts',()=>{
 const p=provider(()=>{throw Error('No network');});
 for(const patch of [{integration:999},{domain:'live'},{type:'mobile_money'},{currency:'EUR'},{active:false},{details:{...recipient.details,bank_code:'888'}},{details:{...recipient.details,account_number:'0000000002'}},{details:{...recipient.details,account_name:'OTHER HOLDER'}}])
  a.throws(()=>p.checkRecipient({...recipient,...patch},expected),{code:'BANK_RECIPIENT_MISMATCH'});
 a.equal(p.checkRecipient(recipient,expected),recipient.recipient_code);
});
test('provider failures do not leak raw Paystack errors, account number or secret and POST is never retried',async()=>{
 let calls=0;const p=provider(async()=>{calls++;throw Error('unsafe '+secret+' 0000000001');});
 await a.rejects(p.create(expected),e=>e.code==='BANK_PROVIDER_UNAVAILABLE'&&!e.message.includes(secret)&&!e.message.includes('0000000001'));
 a.equal(calls,1);await a.rejects(p.resolve('999','not-account'),{code:'BANK_INPUT_INVALID'});
});
test('provider rejects oversized responses and incomplete pagination rather than accepting a partial list',async()=>{
 await a.rejects(provider(async()=>new Response('x'.repeat(262145))).banks(),{code:'BANK_PROVIDER_UNAVAILABLE'});
 let pages=0;await a.rejects(provider(async()=>{pages++;return response({data:[],meta:{next:'more'}});}).banks(),{code:'BANK_PROVIDER_UNAVAILABLE'});a.equal(pages,10);
});
test('account confirmation email contains no bank data and uses fixed secure transport',async()=>{
 const sent=[],options=[],env={EMAIL_USER:'sender@example.invalid',FRONTEND_URL:'https://ui.example.invalid'};
 const mail=createMailer({env,mailer:{createTransport(config){options.push(config);return {async sendMail(message){sent.push(message);},close(){}};}}});
 await mail({kind:'registered',id:crypto.randomUUID(),email:'scholar@example.invalid',accountNumber:'0000000001',recipientCode:recipient.recipient_code});
 a.equal(sent.length,1);a.equal(sent[0].to.address,'scholar@example.invalid');a.equal(options[0].requireTLS,true);a.equal(options[0].tls.rejectUnauthorized,true);a.equal(options[0].logger,false);
 a(!JSON.stringify(sent).includes('0000000001'));a(!JSON.stringify(sent).includes('RCP_'));a(sent[0].text.includes('/support'));
 await a.rejects(mail({kind:'registered',id:crypto.randomUUID(),email:'scholar@example.invalid\r\nBcc:other@example.invalid'}));a.equal(sent.length,1);
});
test('HTTP requires auth, same-origin JSON mutation and exposes no account-change route',async()=>{
 let calls=0;const app=express();app.use(express.json({limit:'16kb'}));
 app.use('/bank',createRouter({service:()=>({status:async()=>({enabled:true}),resolve:async()=>{calls++;return {resolved:true};}}),
  origins:['https://ui.example.invalid'],auth:(req,res,next)=>req.headers.authorization==='Bearer synthetic'?(req.user={id:1},next()):res.sendStatus(401)}));
 const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/bank';
 try{
  a.equal((await fetch(url+'/status')).status,401);
  a.equal((await fetch(url+'/resolve',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json',Origin:'https://evil.example.invalid'},body:'{}'})).status,403);
  const success=await fetch(url+'/resolve',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json',Origin:'https://ui.example.invalid'},body:'{}'});
  a.equal(success.status,200);a.equal(success.headers.get('cache-control'),'no-store');a.equal(calls,1);
  a.equal((await fetch(url+'/admin/operations',{headers:{Authorization:'Bearer synthetic'}})).status,403);
  a.equal((await fetch(url+'/reauthenticate',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json',Origin:'https://ui.example.invalid'},body:JSON.stringify({purpose:'reconcile'})})).status,403);
  a.equal((await fetch(url+'/changes',{method:'POST',headers:{Authorization:'Bearer synthetic','Content-Type':'application/json',Origin:'https://ui.example.invalid'},body:'{}'})).status,404);
 }finally{await new Promise(r=>server.close(r));}
});
