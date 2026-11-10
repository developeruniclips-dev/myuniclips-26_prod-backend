'use strict';
if(!process.argv.includes('--execute-disposable')){console.log('Preview only; no qualification operation ran.');}else{
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),workspace=path.resolve(root,'../..'),frontend=path.join(workspace,'.release-worktrees/paystack-nigeria-frontend');
assert.equal(process.version,'v22.23.3');
const out=path.join(root,'docs/paystack-nigeria-phase2d-evidence','qualification-'+crypto.randomBytes(6).toString('hex'));fs.mkdirSync(out,{recursive:true});
const json=(f,v)=>fs.writeFileSync(path.join(out,f),JSON.stringify(v,null,2)+'\n');
// This newly created frontend worktree is owned by the sandbox account. Trust
// only this exact authorized path for these read-only calls; persist no setting.
const git=(cwd,args,input)=>cp.execFileSync('git',['--no-optional-locks','-c','core.hooksPath=/dev/null',...(cwd===frontend?['-c','safe.directory='+frontend]:[]),...args],{cwd,input,encoding:input===undefined?'utf8':undefined,timeout:30000,windowsHide:true,stdio:['pipe','pipe','pipe']});
const files=dir=>[...new Set([...git(dir,['ls-files','-z']).split('\0'),...git(dir,['ls-files','--others','--exclude-standard','-z']).split('\0')].filter(Boolean))];
assert.equal(git(root,['branch','--show-current']).trim(),'feature/paystack-nigeria');assert.equal(git(root,['rev-parse','HEAD']).trim(),'ac44c831770a53de77192ab78f14039062ef2602');
assert.equal(git(frontend,['branch','--show-current']).trim(),'feature/paystack-nigeria-financial-ui');assert.equal(git(frontend,['rev-parse','HEAD']).trim(),'bcd2e64b91466cd2ef2fab4dbafa276096c1a183');
for(const dir of [root,frontend])assert.equal(git(dir,['diff','--cached','--name-only']).trim(),'');
const backendFiles=files(root).filter(f=>!f.startsWith('docs/')||f.startsWith('docs/security/'));
fs.writeFileSync(path.join(__dirname,'BACKEND_FILES.json'),JSON.stringify(backendFiles.sort()));
const frontFiles=files(frontend);fs.writeFileSync(path.join(root,'docs/paystack-nigeria-phase2d-evidence/FRONTEND_FILES.json'),JSON.stringify(frontFiles.sort()));
const hashes=(dir,names)=>Object.fromEntries(names.filter(f=>fs.existsSync(path.join(dir,f))).map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,f))).digest('hex')]));
const initial={backend:hashes(root,backendFiles),frontend:hashes(frontend,frontFiles)};json('SOURCE_BEFORE.json',initial);
const deps=path.join(workspace,'analysis/security/p2j/j2/work/windows-22.23.3-backend-ci-full/node_modules');
const env={PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,HOME:process.env.TEMP,USERPROFILE:process.env.TEMP,NODE_PATH:deps,NODE_ENV:'test',P2I_ISOLATED_TEST:'1',DB_TLS_ISOLATED_TEST:'1',NODE_OPTIONS:'--require '+JSON.stringify(path.join(__dirname,'loopback-only.cjs'))};
const stages=[];
function stage(name,work){console.log('START '+name);try{const result=work();stages.push({name,passed:true,result});console.log('PASS '+name);}catch(e){stages.push({name,passed:false,code:e.code||e.name,details:e.details,message:String(e.message).split('\n')[0]});console.log('FAIL '+name+' '+(e.code||e.name));process.exitCode=1;}json('STAGES.json',stages);}
stage('syntax',()=>{let count=0;for(const f of backendFiles.filter(f=>/\.(js|cjs|mjs)$/.test(f))){const r=cp.spawnSync(process.execPath,['--check',path.join(root,f)],{env,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,f+' '+r.stderr);count++;}return {files:count};});
stage('windows-focused',()=>{const names=['databaseTls.test.js','courseApi.test.js','p2i.test.js','p2i.completion.test.js','p2i.i2.test.cjs','p2i.final.test.cjs','paymentCountryRouting.test.cjs','paymentFinancialCompatibility.test.cjs','paymentRoutingHttp.test.cjs','paystackNigeria.test.cjs','paystackNigeria.store.test.cjs','paystackNigeria.compatibility.test.cjs'];const r=cp.spawnSync(process.execPath,['--test','--test-concurrency=1',...names.map(f=>'tests/'+f)],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024});const text=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(path.join(out,'windows.log'),text);const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled'].map(k=>[k,Number(text.match(new RegExp('^# '+k+' (\\d+)$','m'))?.[1]||0)]));json('WINDOWS.json',{...counts,exit:r.status,files:names});assert.equal(r.status,0);assert.equal(counts.fail,0);return counts;});
for(const [name,dir]of [['backend',root],['frontend',frontend]])stage(name+'-exact-secret-guard',()=>{
 const guard=require(path.join(dir,'scripts/security/check-staged.cjs')),seed=path.join(workspace,'analysis/security/p2j/j1/linux-context',name),folder=fs.mkdtempSync(path.join(os.tmpdir(),'uniclips-paystack-2d-scan-'));
 try{git(folder,['init','--quiet']);const objects=path.resolve(seed,git(seed,['rev-parse','--git-path','objects']).trim());fs.mkdirSync(path.join(folder,'.git/objects/info'),{recursive:true});fs.writeFileSync(path.join(folder,'.git/objects/info/alternates'),objects.replaceAll('\\','/')+'\n');git(folder,['update-ref','refs/heads/main',guard.POLICY.acceptedBase]);git(folder,['symbolic-ref','HEAD','refs/heads/main']);git(folder,['read-tree','HEAD']);
  const changed=git(dir,['diff','--name-only','HEAD','-z']).split('\0'),newFiles=git(dir,['ls-files','--others','--exclude-standard','-z']).split('\0');
  const overlays=['.node-version','.githooks/pre-commit','.gitignore','.env.example','.gitleaks.toml','scripts/security/check-staged.cjs','tests/p2i.test.js','tests/p2j.repository-guard.test.cjs','docs/security/repository-safety.md'];
  const selected=[...new Set([...overlays,...changed,...newFiles.filter(f=>/^(src|tests|scripts)\//.test(f))])].filter(f=>f&&fs.existsSync(path.join(dir,f)));
  for(const f of selected){const b=fs.readFileSync(path.join(dir,f)),s=b.toString('utf8'),bytes=Buffer.from(s).equals(b)?Buffer.from(s.replace(/\r\n/g,'\n')):b;const oid=git(folder,['hash-object','-w','--stdin'],bytes).toString().trim();git(folder,['update-index','--add','--cacheinfo','100644',oid,f]);}
  const allow=path.join(folder,'allowlist.json'),paths=git(folder,['diff','--cached','--no-renames','--name-only','-z','HEAD']).split('\0').filter(Boolean).sort();fs.writeFileSync(allow,JSON.stringify({paths}));const result=guard.run({cwd:folder,scanner:path.join(workspace,'analysis/security/p2j/j1/tools/windows/gitleaks.exe'),allowlist:allow});json(name+'-scanner.json',{passed:true,paths,result,realIndexUntouched:true});return {paths:paths.length};
 }finally{assert(path.resolve(folder).startsWith(path.resolve(os.tmpdir())+path.sep+'uniclips-paystack-2d-scan-'));fs.rmSync(folder,{recursive:true,force:true});}
});
for(const [name,script,args]of [['frontend-build-tests','paystackNigeriaFrontendDocker.cjs',[]],['mysql-matrix','paystackNigeriaPhase2DDocker.cjs',[]],['linux-full','paystackNigeriaPhase2DDocker.cjs',['--full-regression']]])stage(name,()=>{
 const r=cp.spawnSync(process.execPath,[path.join(__dirname,script),'--execute-disposable',...args],{cwd:root,env:process.env,encoding:'utf8',windowsHide:true,timeout:660000,maxBuffer:8*1024*1024});fs.writeFileSync(path.join(out,name+'.log'),(r.stdout||'')+(r.stderr||''));assert.equal(r.status,0);return {exit:r.status};
});
const final={backend:hashes(root,backendFiles),frontend:hashes(frontend,frontFiles)};json('SOURCE_AFTER.json',final);json('RESULT.json',{stages,sourceUnchanged:JSON.stringify(initial)===JSON.stringify(final),realIndexesEmpty:[root,frontend].every(dir=>git(dir,['diff','--cached','--name-only']).trim()===''),completed:new Date().toISOString()});assert.deepEqual(final,initial);console.log('Evidence '+path.relative(root,out));
}
