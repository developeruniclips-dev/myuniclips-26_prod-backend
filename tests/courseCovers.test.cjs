'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const express=require('express');
const {createCourseCovers,downloadImage,imageUrl,MAX_BYTES}=require('../src/services/courseCovers');
const {syntheticVimeo}=require('./fixtures/vimeoPolicy');
const jpeg=Buffer.from([255,216,255,224,0,16,74,70,73,70,0,1,255,217]);
function setup(options={}){
 const provider=syntheticVimeo(),calls=[],state={rows:[{id:88,video_url:'https://vimeo.com/123456'}],time:0,downloads:0};
 const client={request(o,done){calls.push(o);if(o.path.includes('pictures.sizes'))return done(null,{uri:'/videos/123456',pictures:{sizes:[{width:640,height:360,link:'https://i.vimeocdn.com/video/synthetic_640.jpg'}]}},200);return provider.request(o,done);}};
 const pool={async query(q,args){assert.equal(typeof q,'object');assert.equal(q.timeout,10000);assert.deepEqual(args,[3841,50]);assert.match(q.sql,/cw.state='PUBLISHED'/);assert.match(q.sql,/JOIN scholar_profile sp/);assert.match(q.sql,/ss.approved=1/);assert.match(q.sql,/unapproved.approved IS NULL/);assert.match(q.sql,/ORDER BY v.sequence_index,v.id LIMIT 1/);return [state.rows];}};
 const cover=createCourseCovers({pool,client,now:()=>state.time,download:async()=>{state.downloads++;return{bytes:jpeg,type:'image/jpeg'};},...options});
 return{cover,provider,calls,state};
}
async function response(f,params={subjectId:'3841',scholarId:'50'}){
 const r={headers:{},statusCode:200,set(k,v){this.headers[k]=v;return this;},type(v){this.headers['Content-Type']=v;return this;},status(v){this.statusCode=v;return this;},send(v){this.body=v;return this;},end(){return this;}};
 await f({params},r);return r;
}
test('published first lesson returns only image bytes; existing Vimeo ownership and privacy checks run without mutations',async()=>{
 const f=setup(),r=await response(f.cover);assert.equal(r.statusCode,200);assert.deepEqual(r.body,jpeg);assert.equal(r.headers['Content-Type'],'image/jpeg');assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['X-Content-Type-Options'],'nosniff');assert(f.calls.every(c=>c.method==='GET'));assert(f.calls.some(c=>c.path.startsWith('/me?')));assert(f.calls.some(c=>c.path.includes('/privacy/domains?')));assert(f.calls.every(c=>!/[?&,](?:play|files|download)(?:[,.=&]|$)/.test(c.path)));
});
test('cached cover is never returned after unpublication and changed first lesson does not reuse a stale image',async()=>{
 const f=setup();await response(f.cover);await response(f.cover);assert.equal(f.state.downloads,1);
 f.state.rows=[];assert.equal((await response(f.cover)).statusCode,404);
 f.state.rows=[{id:89,video_url:'https://vimeo.com/654321'}];assert.equal((await response(f.cover)).statusCode,404);assert.equal(f.state.downloads,1);
});
for(const condition of ['processing','wrongOwner','public','extraDomain'])test('no public cover for '+condition,async()=>{
 const f=setup(),asset=f.provider.asset(123456);
 if(condition==='processing')asset.transcode.status='in_progress';if(condition==='wrongOwner')asset.user.uri='/users/1000';if(condition==='public')asset.privacy.view='anybody';if(condition==='extraDomain')asset.domains.push('untrusted.invalid');
 const r=await response(f.cover);assert.equal(r.statusCode,404);assert.equal(r.body,undefined);assert.equal(f.state.downloads,0);
});
test('processing refusal expires so a later ready video receives its cover automatically',async()=>{
 const f=setup();f.provider.asset(123456).transcode.status='in_progress';assert.equal((await response(f.cover)).statusCode,404);
 f.provider.asset(123456).transcode.status='complete';assert.equal((await response(f.cover)).statusCode,404);f.state.time=15001;assert.equal((await response(f.cover)).statusCode,200);
});
test('strict course identifiers refuse malformed, traversal and out of range input before SQL or provider access',async()=>{
 const f=setup();for(const subjectId of ['0','01','../3841','3841 OR 1=1','2147483648','1e3',undefined])assert.equal((await response(f.cover,{subjectId,scholarId:'50'})).statusCode,404);assert.equal(f.calls.length,0);
});
test('provider errors and untrusted error text never enter the response',async()=>{
 const f=setup({privacy:{verify:async()=>{throw Error('PRIVATE_CANARY_SQL_PASSWORD_PEM');}}}),r=await response(f.cover);assert.equal(r.statusCode,404);assert.equal(r.body,undefined);assert(!JSON.stringify(r.headers).includes('PRIVATE_CANARY'));
});
test('concurrent reads share one provider operation and a fresh read rechecks current publication',async()=>{
 let resume;const gate=new Promise(r=>{resume=r;}),f=setup({privacy:{verify:async()=>{await gate;return{state:'READY',policyVerified:true};}}});
 const a=response(f.cover),b=response(f.cover);await new Promise(r=>setImmediate(r));resume();assert.equal((await a).statusCode,200);assert.equal((await b).statusCode,200);assert.equal(f.state.downloads,1);
});
for(const body of [{uri:'/videos/654321',pictures:{sizes:[]}},{uri:'/videos/123456',pictures:{sizes:[{width:640,height:360,link:'https://untrusted.invalid/video/x.jpg'}]}},{uri:'/videos/123456',pictures:{sizes:Array(31).fill({width:640,height:360,link:'https://i.vimeocdn.com/video/x.jpg'})}}])test('invalid picture metadata cannot trigger a download '+body.pictures.sizes.length,async()=>{
 const f=setup({privacy:{verify:async()=>({state:'READY',policyVerified:true})},client:{request(o,done){done(null,body,200);}}});assert.equal((await response(f.cover)).statusCode,404);assert.equal(f.state.downloads,0);
});
test('many distinct concurrent cover requests stay within the provider concurrency budget',async()=>{
 let release,active=0,peak=0;const gate=new Promise(r=>{release=r;});
 const f=setup({pool:{query:async(_q,args)=>[[{id:args[0],video_url:'https://vimeo.com/'+args[0]}]]},privacy:{verify:async()=>{active++;peak=Math.max(peak,active);await gate;active--;return{state:'READY',policyVerified:true};}},client:{request(o,done){done(null,{uri:o.path.split('?')[0],pictures:{sizes:[{width:640,height:360,link:'https://i.vimeocdn.com/video/synthetic.jpg'}]}},200);}}});
 const pending=Array.from({length:16},(_,i)=>response(f.cover,{subjectId:String(i+1),scholarId:'50'}));await new Promise(r=>setImmediate(r));release();const all=await Promise.all(pending);assert.equal(peak,4);assert.equal(all.filter(r=>r.statusCode===200).length,4);assert.equal(all.filter(r=>r.statusCode===404).length,12);
});
for(const value of ['http://i.vimeocdn.com/video/x.jpg','https://i.vimeocdn.com.evil.invalid/video/x.jpg','https://i.vimeocdn.com:444/video/x.jpg','https://user:password@i.vimeocdn.com/video/x.jpg','https://127.0.0.1/video/x.jpg','file:///etc/passwd','https://i.vimeocdn.com/other/x.jpg','https://i.vimeocdn.com/video/x.jpg#secret'])test('image URL refuses unsafe destination '+value.replace(/user:password/,'redacted'),()=>assert.throws(()=>imageUrl(value),{code:'COURSE_COVER_UNAVAILABLE'}));
function transport({status=200,type='image/jpeg',bytes=jpeg,length,encoding}={}){
 let destroyed=false,options;
 const request=(url,o,done)=>{options=o;assert.equal(url.hostname,'i.vimeocdn.com');const req=new EventEmitter();req.destroy=()=>{destroyed=true;};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':type,...(length===undefined?{}:{'content-length':length}),...(encoding?{'content-encoding':encoding}:{})};res.destroy=()=>{destroyed=true;};done(res);res.emit('data',bytes);res.emit('end');});return req;};
 return{request,get options(){return options;},get destroyed(){return destroyed;}};
}
test('image download enforces verified TLS and sends no authorization or cookies',async()=>{
 const t=transport(),r=await downloadImage('https://i.vimeocdn.com/video/synthetic.jpg',{request:t.request});assert.deepEqual(r,{bytes:jpeg,type:'image/jpeg'});assert.equal(t.options.rejectUnauthorized,true);assert.deepEqual(Object.keys(t.options.headers).sort(),['Accept','Accept-Encoding']);
});
for(const options of [{status:302},{type:'text/html'},{bytes:Buffer.from('<svg onload="alert(1)"></svg>')},{length:String(MAX_BYTES+1)},{bytes:Buffer.alloc(MAX_BYTES+1)},{length:'999'},{encoding:'gzip'}])test('refuses redirects, active content, oversized or malformed images '+JSON.stringify({...options,bytes:options.bytes?'synthetic':undefined}),async()=>{
 const t=transport(options);await assert.rejects(downloadImage('https://i.vimeocdn.com/video/synthetic.jpg',{request:t.request}),{code:'COURSE_COVER_UNAVAILABLE'});assert.equal(t.destroyed,true);
});
test('download deadline cancels a stalled transfer',async()=>{
 let destroyed=false;await assert.rejects(downloadImage('https://i.vimeocdn.com/video/synthetic.jpg',{timeoutMs:5,request(){const r=new EventEmitter();r.end=()=>{};r.destroy=()=>{destroyed=true;};return r;}}),{code:'COURSE_COVER_UNAVAILABLE'});assert(destroyed);
});
test('real anonymous HTTP route returns image bytes and fails closed on unavailable publication',async()=>{
 const f=setup(),app=express();app.get('/covers/:subjectId/:scholarId',f.cover);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{const url='http://127.0.0.1:'+server.address().port+'/covers/3841/50',r=await fetch(url);assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),jpeg);f.state.rows=[];const denied=await fetch(url);assert.equal(denied.status,404);assert.equal(await denied.text(),'');}finally{await new Promise(resolve=>server.close(resolve));}
});
