// Loopback multipart, isolated temporary files and in-memory DB/provider adapters.
// No dotenv, configured database, authentication credential or provider is used.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),http=require('node:http');
const express=require('express'),fixtures=require('./fixtures/uploadFiles');
const security=require('../src/middleware/uploadSecurity'),{validateFileContent}=require('../src/utils/uploadContent');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-upload-test-'));
const directories=Object.fromEntries(['image','taskCard','video'].map(k=>[k,path.join(root,k)]));
for(const d of Object.values(directories))fs.mkdirSync(d);
let server,base,received=0,holdResponse,holdRelease,mode='success',oldReference='uploads/profile-images/existing.png',heldConnections=0,providerCalls=0;
const logs=[], state={approved:true,owner:7,currentRole:true,full:false,duplicate:false,dbFailure:false,providerFailure:false,persistenceFailure:false};
const db={async beginTransaction(){},async commit(){if(state.commitFailure)throw Error('SECRET_DB_ERROR');},async rollback(){},release(){heldConnections--;},async query(sql,args){
 if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('RELEASE_LOCK'))return [[{}]];
 if(sql.startsWith('SELECT r.name'))return [[{name:state.currentRole?'Scholar':'Learner'}]];
 if(sql.startsWith('SELECT ss.subject_id'))return [[{subject_id:5}]];
 if(sql.startsWith('SELECT ss.'))return [state.approved&&Number(args[0])===state.owner&&Number(args[1])===5?[{subject_id:5}]:[]];
 if(sql.startsWith('SELECT * FROM videos'))return [state.full?Array.from({length:12},()=>({sequence_index:1})):[]];
 if(sql.startsWith('INSERT INTO videos')){if(state.persistenceFailure)throw Error('SECRET_DB_ERROR');return [{}];}
 if(sql.startsWith('SELECT profile_image_url'))return [[{profile_image_url:oldReference}]];
 if(sql.startsWith('UPDATE users')){if(state.dbFailure)throw Error('SECRET_DB_ERROR');oldReference=args[0];return [{affectedRows:1}];}
 if(sql.startsWith('SELECT * FROM universities'))return [[{id:1,name:'Synthetic University',country_id:1}]];
 if(sql.startsWith('SELECT id FROM subjects'))return [[{id:1}]];
 if(sql.startsWith('SELECT id FROM users'))return [[{id:7}]];
 if(sql.startsWith('SELECT id FROM scholar_profile'))return [state.duplicate?[{id:1}]:[]];
 if(sql.startsWith('INSERT INTO scholar_profile')){if(state.dbFailure)throw Error('SECRET_DB_ERROR');return [{}];}
 if(sql.startsWith('INSERT IGNORE'))return [{}];
 throw Error('Unexpected isolated query');
}};
const pool={query:db.query.bind(db),async getConnection(){heldConnections++;return db;}};
const provider={upload(file,options,done,progress,fail){providerCalls++;assert.equal(heldConnections,0,'pool connection held across provider call');if(state.providerFailure)return fail(Error('SECRET_PROVIDER_ERROR'));if(state.providerDelay){holdRelease=()=>done('/videos/123');return;}done('/videos/123');}};
function load(file,overrides){const module={exports:{}};const localRequire=require('node:module').createRequire(path.join(__dirname,'../src',file));vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{module,Buffer,Date,Set,Number,Promise,console,__dirname:path.dirname(path.join(__dirname,'../src',file)),process:{env:{}},require(name){if(Object.hasOwn(overrides,name))return overrides[name];if(name.includes('safeLogging'))return{logError:(event)=>logs.push(event)};return localRequire(name);}});return module.exports;}
const localSecurity={...security,roots:{image:directories.image,taskCard:directories.taskCard,video:directories.video},profilePath(ref){if(!/^uploads\/profile-images\/[\w-]+\.png$/.test(ref||''))return null;return path.join(directories.image,path.basename(ref));}};
const user=load('controller/userController.js',{'../config/db':{pool},'../models/User':{UserModel:{}},'../utils/learnerPreferences':{learnerPreferences:async()=>{if(state.preferenceFailure)throw Object.assign(Error('Invalid study preference'),{statusCode:400});return{};}},'../middleware/uploadSecurity':localSecurity});
const auth=load('controller/authController.js',{'../config/db':{pool},'../models/User':{UserModel:{}},'../models/userRole':{UserRoleModel:{}},'../models/scholarProfile':{ScholarProfileModel:{findByUserId:async()=>[state.duplicate?[{id:1}]:[]]}},'../utils/emailService':{},'../utils/academicContext':{universityLabel:()=> 'Synthetic University'},'../middleware/uploadSecurity':localSecurity});
const video=load('controller/videoController.js',{'../config/db':{pool},'../config/vimeo':provider,'../models/videos':{VideoModel:{}}});
const admission=load('middleware/uploadAdmission.js',{'../config/db':{pool}});
const app=express();app.use(express.json());app.use((req,res,next)=>{if(req.headers['x-test-user'])req.user={id:Number(req.headers['x-test-user']),roles:['Scholar']};next();});
const authenticate=(req,res,next)=>req.user?next():res.status(401).json({message:'Not authenticated'});
const finish=(req,res)=>{received++;if(mode==='hold'){req.uploadState.processing=true;holdResponse=async()=>{await req.uploadState.finish();res.json({ok:true});};return;}res.status(mode==='failure'?400:200).json({ok:mode!=='failure'});};
for(const category of ['image','taskCard','video'])app.post('/'+category,authenticate,security.createUpload(category,{root:directories[category]}),finish);
app.put('/profile',authenticate,security.createUpload('image',{root:directories.image}),user.updateUserProfile);
app.post('/application',authenticate,admission.applicantAdmission,security.createUpload('taskCard',{root:directories.taskCard}),auth.becomeScholar);
app.post('/lesson',authenticate,admission.videoAdmission,security.createUpload('video',{root:directories.video}),video.uploadVideo);
let documentReference='private-task-cards/document.pdf';
const taskPool={async query(sql,args){if(sql.startsWith('SELECT r.name'))return [[{name:Number(args[0])===9?'Admin':Number(args[0])===10?'SuperAdmin':'Learner'}]];return [[{task_card_url:documentReference}]];}};
const cards=load('controller/taskCardController.js',{'../config/db':{pool:taskPool},'../middleware/uploadSecurity':localSecurity});
app.get('/document/:userId',authenticate,cards.getTaskCard);
app.use('/uploads',cards.publicUploadBoundary,express.static(root));
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;fs.writeFileSync(path.join(directories.taskCard,'document.pdf'),fixtures.pdf);});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
test.beforeEach(()=>{Object.assign(state,{approved:true,owner:7,currentRole:true,full:false,duplicate:false,dbFailure:false,providerFailure:false,persistenceFailure:false,providerDelay:false,preferenceFailure:false,commitFailure:false});mode='success';});
const mimes={jpg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',mp4:'video/mp4',mov:'video/quicktime',avi:'video/x-msvideo',mkv:'video/x-matroska',webm:'video/webm'};
async function upload(route,category,ext,data=fixtures[ext],fields={},userId=7,fileField=security.policies[category].field){const form=new FormData();for(const [k,v]of Object.entries(fields))form.append(k,v);if(data)form.append(fileField,new Blob([data],{type:mimes[ext]||'application/octet-stream'}),'fixture.'+ext);const r=await fetch(base+route,{method:route==='/profile'?'PUT':'POST',headers:userId?{'x-test-user':String(userId)}:{},body:form});return {status:r.status,body:await r.json()};}
const settle=()=>new Promise(r=>setTimeout(r,30));
async function cleaned(category,expected){for(let i=0;i<200;i++){if(JSON.stringify(fs.readdirSync(directories[category]))===JSON.stringify(expected))return;await new Promise(r=>setTimeout(r,10));}assert.deepEqual(fs.readdirSync(directories[category]),expected);}
for(const [category,formats]of [['image',['jpg','png','gif','webp']],['taskCard',['jpg','png','pdf']],['video',['mp4','mov','avi','mkv','webm']]])for(const ext of formats)test(`${category} accepts structured ${ext} and cleans unretained file`,async()=>{assert.equal((await upload('/'+category,category,ext)).status,200);await settle();const files=fs.readdirSync(directories[category]);assert.deepEqual(files,category==='taskCard'?['document.pdf']:[]);});
for(const ext of Object.keys(mimes))test(`content validation rejects a forged short ${ext} prefix`,async()=>{const file=path.join(root,'spoof.'+ext);fs.writeFileSync(file,fixtures[ext].subarray(0,Math.min(16,fixtures[ext].length)));assert.equal(await validateFileContent(file,'.'+ext),false);fs.unlinkSync(file);});
test('MOV without ftyp remains supported; corrupt PNG CRC and trailing AVI data are rejected',async()=>{
 const mov=path.join(root,'old.mov');fs.writeFileSync(mov,fixtures.mp4.subarray(20));assert.equal(await validateFileContent(mov,'.mov'),true);
 const badPNG=Buffer.from(fixtures.png);badPNG[badPNG.length-1]^=1;const png=path.join(root,'corrupt.png');fs.writeFileSync(png,badPNG);assert.equal(await validateFileContent(png,'.png'),false);
 const avi=path.join(root,'trailing.avi');fs.writeFileSync(avi,Buffer.concat([fixtures.avi,Buffer.from('<script>not-media</script>')]));assert.equal(await validateFileContent(avi,'.avi'),false);
});
test('extension, MIME mismatch, unexpected files and unknown fields are controlled',async()=>{
 assert.equal((await upload('/image','image','exe',Buffer.from('bad'))).status,400);
 const form=new FormData();form.append('profileImage',new Blob([fixtures.png],{type:'image/jpeg'}),'file.png');let r=await fetch(base+'/image',{method:'POST',headers:{'x-test-user':'7'},body:form});assert.equal(r.status,400);
 assert.equal((await upload('/image','image','png',fixtures.png,{},7,'surprise')).status,400);
 assert.equal((await upload('/image','image','png',fixtures.png,{surprise:'x'})).status,400);await settle();assert.deepEqual(fs.readdirSync(directories.image),[]);
});
for(const category of ['image','taskCard','video'])test(`${category} rejects excessive fields, nesting, array index and field values`,async()=>{
 const ext=category==='video'?'mp4':category==='taskCard'?'pdf':'png',p=security.policies[category];
 for(const fields of [{...Object.fromEntries(Array.from({length:p.fields.length+1},(_,i)=>['extra'+i,'x']))},{'a[b][c]':'x'},{'a[4294967294]':'x'},{[p.fields[0]]:'x'.repeat(p.fieldSize+1)}])assert.equal((await upload('/'+category,category,ext,fixtures[ext],fields)).status,400);
 await settle();assert.deepEqual(fs.readdirSync(directories[category]),category==='taskCard'?['document.pdf']:[]);
});
test('profile and task-card oversized file limits reject and remove partial writes',async()=>{for(const [category,ext]of [['image','png'],['taskCard','pdf']]){assert.equal((await upload('/'+category,category,ext,Buffer.alloc(5*1024*1024+1))).status,400);await settle();assert.deepEqual(fs.readdirSync(directories[category]),category==='taskCard'?['document.pdf']:[]);}});
test('video keeps the 1 GiB limit and rejects excessive aggregate Content-Length before parser',async()=>{assert.equal(security.policies.video.fileSize,1024**3);const status=await new Promise((resolve,reject)=>{const req=http.request(base+'/video',{method:'POST',headers:{'x-test-user':'7','content-type':'multipart/form-data; boundary=x','content-length':String(1024**3+1024**2)}},res=>{res.resume();resolve(res.statusCode);req.destroy();});req.on('error',reject);req.flushHeaders();});assert.equal(status,413);});
test('malformed multipart and duplicate files reject without raw error/path output',async()=>{
 let r=await fetch(base+'/image',{method:'POST',headers:{'x-test-user':'7','content-type':'multipart/form-data; boundary=x'},body:'--x\r\nContent-Disposition: form-data; name="profileImage"; filename="x.png"\r\nContent-Type: image/png\r\n\r\nincomplete'});assert.equal(r.status,400);assert.doesNotMatch(JSON.stringify(await r.json()),/SECRET|stack|[A-Z]:\\|ENOENT/);
 const form=new FormData();for(let i=0;i<2;i++)form.append('profileImage',new Blob([fixtures.png],{type:'image/png'}),'x.png');r=await fetch(base+'/image',{method:'POST',headers:{'x-test-user':'7'},body:form});assert.equal(r.status,400);await settle();assert.deepEqual(fs.readdirSync(directories.image),[]);
});
test('chunked aggregate overflow returns a controlled error and removes stored partial files',{timeout:10000},async()=>{
 const status=await new Promise((resolve,reject)=>{
  const req=http.request(base+'/image',{method:'POST',headers:{'x-test-user':'7','Content-Type':'multipart/form-data; boundary=overflow'}},res=>{res.resume();resolve(res.statusCode);});
  req.on('error',error=>{if(error.code!=='EPIPE'&&error.code!=='ECONNRESET')reject(error);});
  req.write('--overflow\r\nContent-Disposition: form-data; name="profileImage"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n');
  for(let i=0;i<24;i++)req.write(Buffer.alloc(256*1024));req.end('\r\n--overflow--\r\n');
 });
 assert.equal(status,413);await new Promise(r=>setTimeout(r,100));assert.deepEqual(fs.readdirSync(directories.image),[]);
});
test('bounded admission rejects simultaneous same-user work and recovers after completion',async()=>{mode='hold';const first=upload('/image','image','png');while(!holdResponse)await settle();assert.equal((await upload('/image','image','png')).status,429);await holdResponse();await first;mode='success';assert.equal((await upload('/image','image','png')).status,200);});
test('global admission has no queue and releases idempotently',()=>{const enter=security.createAdmission(2),one=enter('one'),two=enter('two');assert.equal(enter('three'),null);assert.equal(enter('one'),null);one();one();const three=enter('three');assert.equal(typeof three,'function');two();three();});
test('failed replacement preserves old file; successful replacement removes old after commit',async()=>{
 fs.writeFileSync(path.join(directories.image,'existing.png'),fixtures.png);oldReference='uploads/profile-images/existing.png';state.dbFailure=true;
 assert.equal((await upload('/profile','image','png',fixtures.png,{fname:'Synthetic'})).status,500);assert.deepEqual(fs.readdirSync(directories.image),['existing.png']);
 state.dbFailure=false;assert.equal((await upload('/profile','image','png',fixtures.png,{fname:'Synthetic'})).status,200);assert.equal(fs.existsSync(path.join(directories.image,'existing.png')),false);assert.equal(fs.readdirSync(directories.image).length,1);fs.unlinkSync(path.join(directories.image,fs.readdirSync(directories.image)[0]));
});
test('post-storage academic rejection cleans new profile file',async()=>{state.preferenceFailure=true;assert.equal((await upload('/profile','image','png',fixtures.png,{universityId:'1'})).status,400);assert.deepEqual(fs.readdirSync(directories.image),[]);});
test('ambiguous profile commit preserves both old and possibly referenced new file',async()=>{
 fs.writeFileSync(path.join(directories.image,'existing.png'),fixtures.png);oldReference='uploads/profile-images/existing.png';state.commitFailure=true;
 assert.equal((await upload('/profile','image','png',fixtures.png,{fname:'Synthetic'})).status,500);assert.equal(fs.existsSync(path.join(directories.image,'existing.png')),true);assert.equal(fs.readdirSync(directories.image).length,2);
 for(const name of fs.readdirSync(directories.image))fs.unlinkSync(path.join(directories.image,name));
});
test('duplicate, academic rejection and DB failure clean new task-card files',async()=>{
 const fields={countryId:'1',universityId:'1',degree:'Synthetic',year:'2028'};state.duplicate=true;assert.equal((await upload('/application','taskCard','pdf',fixtures.pdf,fields)).status,400);
 state.duplicate=false;assert.equal((await upload('/application','taskCard','pdf',fixtures.pdf,{...fields,year:'1900'})).status,400);
 state.dbFailure=true;assert.equal((await upload('/application','taskCard','pdf',fixtures.pdf,fields)).status,500);await cleaned('taskCard',['document.pdf']);assert.deepEqual(fs.readdirSync(directories.taskCard),['document.pdf']);
});
test('successful application retains private document only after atomic DB work',async()=>{assert.equal((await upload('/application','taskCard','pdf',fixtures.pdf,{countryId:'1',universityId:'1',degree:'Synthetic',year:'2028'})).status,201);assert.equal(fs.readdirSync(directories.taskCard).length,2);for(const name of fs.readdirSync(directories.taskCard))if(name!=='document.pdf')fs.unlinkSync(path.join(directories.taskCard,name));});
test('private document denies anonymous/unrelated, allows owner and current Admin/SuperAdmin',async()=>{
 for(const [userId,status]of [[null,401],[8,403],[7,200],[9,200],[10,200]]){const r=await fetch(base+'/document/7',{headers:userId?{'x-test-user':String(userId)}:{}});assert.equal(r.status,status);if(status===200){assert.equal(r.headers.get('cache-control'),'private, no-store');assert.match(r.headers.get('content-disposition'),/^attachment/);assert.equal((await r.arrayBuffer()).byteLength,fixtures.pdf.length);}}
 for(const ref of ['uploads/task-cards/../secret.pdf','private-task-cards/../../secret.pdf','https://evil.invalid/a.pdf','C:\\private\\a.pdf'])assert.equal(cards.taskCardPath(ref),null);
 assert.equal((await fetch(base+'/document/not-an-id',{headers:{'x-test-user':'7'}})).status,400);
});
test('legacy public task-card URLs and encoded paths denied, profile assets remain public',async()=>{
 fs.mkdirSync(path.join(root,'task-cards'));fs.writeFileSync(path.join(root,'task-cards','legacy.pdf'),fixtures.pdf);fs.writeFileSync(path.join(root,'public.png'),fixtures.png);
 for(const url of ['/uploads/task-cards/legacy.pdf','/uploads/%74ask-cards/legacy.pdf','/uploads/task-cards%2flegacy.pdf'])assert.equal((await fetch(base+url)).status,404);
 assert.equal((await fetch(base+'/uploads/public.png')).status,200);
});
test('existing legacy task card is available through authorized retrieval only; DB error fails closed',async()=>{
 const folder=path.join(__dirname,'../uploads/task-cards');fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'legacy.pdf');fs.writeFileSync(file,fixtures.pdf);documentReference='uploads/task-cards/legacy.pdf';
 try{const r=await fetch(base+'/document/7',{headers:{'x-test-user':'9'}});assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,fixtures.pdf.length);}finally{documentReference='private-task-cards/document.pdf';fs.unlinkSync(file);}
 const broken=load('controller/taskCardController.js',{'../config/db':{pool:{query:async()=>{throw Error('SECRET_DB_ERROR');}}},'../middleware/uploadSecurity':localSecurity});
 const response={status(code){this.statusCode=code;return this;},json(body){this.body=body;}};await broken.getTaskCard({params:{userId:'7'},user:{id:9}},response);assert.equal(response.statusCode,503);assert.deepEqual(JSON.parse(JSON.stringify(response.body)),{message:'Document unavailable'});
});
test('video admission denies anonymous, revoked Scholar, unapproved, wrong course and full course before storage',async()=>{
 const fields={subjectId:'5',title:'Synthetic',description:''};assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,fields,null)).status,401);
 for(const [flag,value,status]of [['currentRole',false,403],['approved',false,403],['owner',8,403],['full',true,409]]){state[flag]=value;const before=providerCalls;assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,fields)).status,status);assert.equal(providerCalls,before);assert.deepEqual(fs.readdirSync(directories.video),[]);state[flag]=flag==='owner'?7:flag==='full'?false:true;}
});
test('video provider delay holds no DB connection, active admission prevents another upload',async()=>{
 state.providerDelay=true;const first=upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,{subjectId:'5',title:'Synthetic',description:''});while(!holdRelease)await settle();assert.equal(heldConnections,0);assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,{title:'Second',description:''})).status,429);holdRelease();assert.equal((await first).status,201);assert.deepEqual(fs.readdirSync(directories.video),[]);
});
test('disconnect during provider transfer retains admission until completion and then cleans safely',async()=>{
 state.providerDelay=true;holdRelease=null;
 const body=new FormData();body.append('subjectId','5');body.append('title','Disconnect');body.append('description','');body.append('video',new Blob([fixtures.mp4],{type:'video/mp4'}),'disconnect.mp4');
 const abort=new AbortController();const response=fetch(base+'/lesson?subjectId=5',{method:'POST',headers:{'x-test-user':'7'},body,signal:abort.signal}).catch(error=>error);
 while(!holdRelease)await settle();abort.abort();await response;
 assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,{title:'Second',description:''})).status,429);
 holdRelease();await cleaned('video',[]);assert.equal(heldConnections,0);
 state.providerDelay=false;assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,{title:'After completion',description:''})).status,201);
});
test('provider failure, persistence failure and mismatched body target clean local video',async()=>{
 const fields={subjectId:'5',title:'Synthetic',description:''};state.providerFailure=true;assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,fields)).status,500);
 state.providerFailure=false;state.persistenceFailure=true;const r=await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,fields);assert.equal(r.status,503);assert.match(r.body.message,/Contact support before retrying/);assert.doesNotMatch(JSON.stringify(r.body),/SECRET/);assert.ok(logs.includes('Video persistence requires reconciliation'));
 const receipt=JSON.parse(fs.readFileSync(path.join(__dirname,'../private-uploads/reconciliation',r.body.uploadReference+'.json')));assert.equal(receipt.state,'persistence_pending');assert.equal(receipt.providerURI,'/videos/123');assert.equal(receipt.subjectId,5);
 state.persistenceFailure=false;const calls=providerCalls;assert.equal((await upload('/lesson?subjectId=5','video','mp4',fixtures.mp4,{...fields,subjectId:'6'})).status,400);assert.equal(providerCalls,calls);assert.deepEqual(fs.readdirSync(directories.video),[]);
});
test('legacy one-course upload works; an ambiguous legacy target is rejected before any file storage',async()=>{
 const r=await upload('/lesson','video','mp4',fixtures.mp4,{subjectId:'5',title:'Legacy',description:''});assert.equal(r.status,201);
 const otherPool={query:async()=>[[{subject_id:5},{subject_id:6}]]};const legacy=load('middleware/uploadAdmission.js',{'../config/db':{pool:{query:async sql=>sql.startsWith('SELECT r.name')?[[{name:'Scholar'}]]:await otherPool.query()}}});
 let status,nextCalled=false;await legacy.videoAdmission({user:{id:7},query:{}},{status(code){status=code;return this;},json(){}},()=>{nextCalled=true;});assert.equal(status,400);assert.equal(nextCalled,false);
});
test('aborted disk uploads clean partial writes and release admission for all three parsers',async()=>{
 for(const [category,ext]of [['image','png'],['taskCard','pdf'],['video','mp4']]){
  await new Promise(resolve=>{const req=http.request(base+'/'+category,{method:'POST',headers:{'x-test-user':'7','Content-Type':'multipart/form-data; boundary=abort'}},()=>{});req.on('error',()=>resolve());req.write(`--abort\r\nContent-Disposition: form-data; name="${security.policies[category].field}"; filename="abort.${ext}"\r\nContent-Type: ${mimes[ext]}\r\n\r\n`);req.write(Buffer.alloc(65536));setTimeout(()=>{req.destroy();resolve();},30);});
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(fs.readdirSync(directories[category]),category==='taskCard'?['document.pdf']:[]);assert.equal((await upload('/'+category,category,ext)).status,200);await settle();
 }
});
