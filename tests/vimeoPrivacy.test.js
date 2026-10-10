const test=require('node:test'),assert=require('node:assert/strict');
const {createVimeoPrivacy,INITIAL_PRIVACY,FINAL_PRIVACY,DOMAINS,exactDomains}=require('../src/services/vimeoPrivacy');
const {syntheticVimeo}=require('./fixtures/vimeoPolicy');
const reference='https://vimeo.com/123';
const ready=(s)=>({state:s,policyVerified:true});
test('creation policy is private, non-embeddable and download-disabled',()=>assert.deepEqual(INITIAL_PRIVACY,{view:'nobody',embed:'private',download:false}));
test('exact domains reject missing, extra, wildcard, parent, duplicate and URL forms',()=>{
 assert.ok(exactDomains([...DOMAINS]));
 for(const d of [[],[DOMAINS[0]],[...DOMAINS,'evil.example'],['myuniclips.com','*.netlify.app'],['myuniclips.com','netlify.app'],[DOMAINS[0],DOMAINS[0]],['https://myuniclips.com',DOMAINS[1]]])assert.equal(exactDomains(d),false);
});
test('valid policy readback requires ownership, both domains and complete processing',async()=>{
 const adapter=syntheticVimeo();assert.deepEqual(await createVimeoPrivacy(adapter).verify(reference),ready('READY'));
 assert.ok(adapter.calls.every(o=>o.method==='GET'));assert.ok(adapter.calls.every(o=>!/[?&,](files|play|download)(?:,|&|=|$)/.test(o.path)));
});
for(const [name,change]of [
 ['Public',r=>r.privacy.view='anybody'],['unlisted',r=>r.privacy.view='unlisted'],
 ['unrestricted embed',r=>r.privacy.embed='public'],['downloads',r=>r.privacy.download=true],
 ['wrong owner',r=>r.user.uri='/users/1000'],['wrong asset',r=>r.uri='/videos/124'],
 ['missing domain',r=>r.domains=[DOMAINS[0]]],['empty domains',r=>r.domains=[]],['extra domain',r=>r.domains=[...DOMAINS,'evil.example']],
 ['wildcard domain',r=>r.domains=['*.myuniclips.com',DOMAINS[1]]]
])test(name+' cannot authorize playback',async()=>{
 const adapter=syntheticVimeo();change(adapter.asset(123));const result=await createVimeoPrivacy(adapter).verify(reference);
 assert.equal(result.state,'UNKNOWN');assert.equal(result.policyVerified,false);assert.equal(result.player_url,undefined);
});
test('processing and failed transcode cannot become READY despite secure policy',async()=>{
 for(const status of ['in_progress','error',undefined]){
  const adapter=syntheticVimeo();adapter.asset(123).transcode.status=status;
  const result=await createVimeoPrivacy(adapter).verify(reference);assert.equal(result.policyVerified,true);assert.equal(result.state,status==='in_progress'?'PROCESSING':status==='error'?'FAILED':'UNKNOWN');
 }
});
test('malformed player reference is denied before provider access',async()=>{
 const adapter=syntheticVimeo();assert.equal((await createVimeoPrivacy(adapter).verify('https://evil.example/123')).policyVerified,false);assert.equal(adapter.calls.length,0);
});
test('new private asset is configured in exact supported sequence and read back',async()=>{
 const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});
 const result=await createVimeoPrivacy(adapter).configureNew(reference);assert.deepEqual(result,ready('READY'));
 assert.deepEqual(adapter.calls.filter(o=>o.method!=='GET').map(o=>[o.method,o.path,o.query]),[
 ['PUT','/videos/123/privacy/domains/myuniclips.com',undefined],
 ['PUT','/videos/123/privacy/domains/taupe-empanada-b7dfa9.netlify.app',undefined],
 ['PATCH','/videos/123',{privacy:{...FINAL_PRIVACY}}]]);
 assert.ok(adapter.calls.every(o=>o.method!=='DELETE'&&o.method!=='POST'));
 assert.ok(!JSON.stringify(adapter.calls).includes('anybody'));
});
test('inherited unapproved domain leaves a new asset private with no deletion or promotion',async()=>{
 const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});adapter.asset(123).domains=['evil.example'];
 await assert.rejects(createVimeoPrivacy(adapter).configureNew(reference));assert.equal(adapter.asset(123).privacy.view,'nobody');assert.ok(adapter.calls.every(o=>o.method==='GET'));
});
test('configureNew refuses existing Public or wrong-owner assets; never bulk-migrates',async()=>{
 for(const wrongOwner of [false,true]){const adapter=syntheticVimeo();if(wrongOwner){adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});adapter.asset(123).user.uri='/users/1000';}
 await assert.rejects(createVimeoPrivacy(adapter).configureNew(reference));assert.ok(adapter.calls.every(o=>o.method==='GET'));}
});
for(const status of [401,403,429,500])test('provider '+status+' denies without raw credentials or a mutation retry',async()=>{
 const adapter=syntheticVimeo({state:()=>({failure:status})});const result=await createVimeoPrivacy(adapter).verify(reference);
 assert.equal(result.policyVerified,false);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PROVIDER_SECRET/);
 await assert.rejects(createVimeoPrivacy(adapter).configureNew(reference),e=>!e.message.includes('SECRET'));assert.ok(adapter.calls.every(o=>o.method==='GET'));
});
test('uncertain applied PATCH is confirmed by GET, never resent',async()=>{
 const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});const original=adapter.request.bind(adapter);let patches=0;
 adapter.request=(o,done)=>{if(o.method==='PATCH'){patches++;Object.assign(adapter.asset(123).privacy,o.query.privacy);return;}original(o,done);};
 assert.deepEqual(await createVimeoPrivacy(adapter,{timeoutMs:5}).configureNew(reference),ready('READY'));assert.equal(patches,1);
});
test('uncertain unapplied PATCH fails closed, stays private, no retry/delete',async()=>{
 const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});const original=adapter.request.bind(adapter);let patches=0;
 adapter.request=(o,done)=>{if(o.method==='PATCH'){patches++;return;}original(o,done);};
 await assert.rejects(createVimeoPrivacy(adapter,{timeoutMs:5}).configureNew(reference));assert.equal(patches,1);assert.equal(adapter.asset(123).privacy.view,'nobody');
});
test('successful write response is insufficient when readback disagrees',async()=>{
 const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});const original=adapter.request.bind(adapter);
 adapter.request=(o,done)=>o.method==='PATCH'?done(null,{},200):original(o,done);
 await assert.rejects(createVimeoPrivacy(adapter).configureNew(reference));assert.equal(adapter.asset(123).privacy.view,'nobody');
});
test('timeout, SDK throw, pagination and exhausted provider budget cannot certify policy',async()=>{
 for(const client of [{request(){}},{request(){throw Error('SECRET');}}]){
  const result=await createVimeoPrivacy(client,{timeoutMs:5}).verify(reference);assert.equal(result.policyVerified,false);assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 }
 const a=syntheticVimeo(),original=a.request.bind(a);a.request=(o,done)=>o.path.includes('/privacy/domains?')?done(null,{data:DOMAINS.map(domain=>({domain})),paging:{next:'/page2'}},200):original(o,done);
 assert.equal((await createVimeoPrivacy(a).verify(reference)).policyVerified,false);
 const b=syntheticVimeo();assert.equal((await createVimeoPrivacy(b,{maxRequests:1}).verify(reference)).policyVerified,false);assert.equal(b.calls.length,1);
});
test('restart never treats process memory or an earlier successful write as a verified grant',async()=>{
 const adapter=syntheticVimeo();assert.equal((await createVimeoPrivacy(adapter).verify(reference)).state,'READY');adapter.asset(123).privacy.view='anybody';
 assert.equal((await createVimeoPrivacy(adapter).verify(reference)).policyVerified,false);
});
test('installed SDK keeps privacy metadata on one creation POST before transfer callback',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Vimeo}=require('@vimeo/vimeo');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-private-sdk-')),file=path.join(dir,'synthetic.mp4');fs.writeFileSync(file,Buffer.from('synthetic'));
 try{const sdk=new Vimeo('synthetic','synthetic','synthetic');let creations=0,transfers=0;
 sdk.request=(options,done)=>{creations++;assert.equal(options.method,'POST');assert.equal(options.path,'/me/videos?fields=uri,name,upload');assert.deepEqual(options.query.privacy,{...INITIAL_PRIVACY});assert.equal(options.query.upload.approach,'tus');done(null,{uri:'/videos/123',upload:{}});};
 sdk._performTusUpload=(a,b,c,done)=>{transfers++;done('/videos/123');};
 const uri=await new Promise((resolve,reject)=>sdk.upload(file,{privacy:{...INITIAL_PRIVACY}},resolve,()=>{},reject));assert.equal(uri,'/videos/123');assert.equal(creations,1);assert.equal(transfers,1);
 }finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
});

test('uncertain PUT is read back without retry; incomplete domain write cannot promote private asset',async()=>{
 for(const applied of [true,false]){
  const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});const original=adapter.request.bind(adapter);let puts=0;
  adapter.request=(o,done)=>{if(o.method==='PUT'){puts++;if(applied)original(o,()=>{});return;}original(o,done);};
  const service=createVimeoPrivacy(adapter,{timeoutMs:5});
  if(applied){assert.deepEqual(await service.configureNew(reference),ready('READY'));assert.equal(puts,2);}
  else{await assert.rejects(service.configureNew(reference));assert.equal(puts,1);assert.equal(adapter.asset(123).privacy.view,'nobody');}
 }
});
test('permission/rate-limit failure during promotion is not retried or represented as verified',async()=>{
 for(const status of [401,403,429]){
  const adapter=syntheticVimeo();adapter.uploaded('/videos/123',{privacy:{...INITIAL_PRIVACY}});const original=adapter.request.bind(adapter);let patches=0;
  adapter.request=(o,done)=>{if(o.method==='PATCH'){patches++;return done(Error('SECRET'),null,status);}original(o,done);};
  await assert.rejects(createVimeoPrivacy(adapter).configureNew(reference));assert.equal(patches,1);assert.equal(adapter.asset(123).privacy.view,'nobody');
 }
});
