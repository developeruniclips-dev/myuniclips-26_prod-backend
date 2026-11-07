'use strict';
// Read-only verification of committed inputs; writes only new local evidence.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),workspace=path.resolve(root,'../..');
const manifest=JSON.parse(fs.readFileSync(path.join(workspace,'analysis/paystack-ng/branch-preparation-20261106/FINAL_VERIFICATION.json')));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git=args=>cp.execFileSync('git',['--no-optional-locks',...args],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
const mismatches=[];for(const[file,expected]of Object.entries(manifest.finalFileHashes))if(hash(path.join(root,file))!==expected)mismatches.push(file);
assert.equal(mismatches.length,0);assert.equal(git(['rev-parse','HEAD']),manifest.checkpoint);assert.equal(git(['symbolic-ref','--short','HEAD']),'feature/paystack-nigeria');
assert.equal(git(['diff','--name-only']),'');assert.equal(git(['diff','--cached','--name-only']),'');
const deps=path.join(workspace,'analysis/security/p2j/j2/work/windows-22.23.3-backend-ci-full/node_modules');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json')));let checked=0;const absentOptional=[];
for(const[key,value]of Object.entries(lock.packages)){if(!key)continue;const packageFile=path.join(deps,path.relative('node_modules',key),'package.json');
 if(!fs.existsSync(packageFile)){assert.equal(value.optional,true,'missing required cached dependency '+key);absentOptional.push(key);continue;}
 assert.equal(JSON.parse(fs.readFileSync(packageFile)).version,value.version,'cached dependency differs '+key);checked++;
}
const inventory={};for(const file of ['src/services/paystackNigeria/schema.js','tests/paystackNigeria.mysql.cjs','tests/fixtures/paystackNigeriaDocker.cjs','tests/fixtures/paystackNigeriaPhase2CVerify.cjs'])inventory[file]={sha256:hash(path.join(root,file)),bytes:fs.statSync(path.join(root,file)).size};
const result={verifiedAt:new Date().toISOString(),head:manifest.checkpoint,branch:'feature/paystack-nigeria',checkpointFilesVerified:Object.keys(manifest.finalFileHashes).length,mismatches,
 trackedDiff:[],stagedDiff:[],cachedDependencyVersionsVerified:checked,absentOptional,inventory,
 preservedByExactCheckpointHashes:['Stripe runtime/controllers/payouts','strict TLS/authentication/uploads','dependencies/lock/runtime pin'],
 otherWorkstreams:'No write command or writable container mount targeted another worktree. This is not a new exhaustive hash audit of every frozen worktree.'};
const syntaxFiles=[...fs.readdirSync(path.join(root,'src/services/paystackNigeria')).filter(f=>f.endsWith('.js')).map(f=>'src/services/paystackNigeria/'+f),
 'scripts/previewPaystackNigeria.cjs','tests/paystackNigeria.test.cjs','tests/paystackNigeria.store.test.cjs','tests/paystackNigeria.compatibility.test.cjs',
 'tests/fixtures/paystackNigeriaMemory.cjs','tests/fixtures/paystackNigeriaMetadata.cjs','tests/paystackNigeria.mysql.cjs','tests/fixtures/paystackNigeriaDocker.cjs','tests/fixtures/paystackNigeriaPhase2CVerify.cjs'];
for(const file of syntaxFiles)cp.execFileSync(process.execPath,['--check',file],{cwd:root,encoding:'utf8',windowsHide:true});
result.syntax={pass:syntaxFiles.length,fail:0,files:syntaxFiles};
for(const file of syntaxFiles)assert(!/[^\S\r\n]+$/m.test(fs.readFileSync(path.join(root,file),'utf8')),'trailing whitespace: '+file);
if(process.argv.includes('--docker-inventory')){
 const docker=args=>cp.execFileSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
 const evidence=path.join(root,'docs/paystack-nigeria-phase2c-evidence');
 const runs=fs.readdirSync(evidence,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>JSON.parse(fs.readFileSync(path.join(evidence,e.name,'run.json')))).sort((a,b)=>a.started.localeCompare(b.started));
 for(const run of runs){assert.equal(run.cleanup.containerRemoved,true);assert.equal(run.cleanup.volumeRemoved,true);assert.equal(run.cleanup.remainingOwnedContainers,'');assert.equal(run.cleanup.remainingOwnedVolumes,'');}
 const containers=docker(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.State}}']).split('\n').filter(Boolean);
 assert.deepEqual(containers.map(s=>s.split(' ').slice(0,2).join(' ')).sort(),runs[0].existingContainers.map(s=>s.split(' ').slice(0,2).join(' ')).sort());
 assert(containers.every(s=>s.endsWith(' exited')));
 const volumes=docker(['volume','ls','--format','{{.Name}}']).split('\n').filter(Boolean).sort();assert.deepEqual(volumes,runs[0].existingVolumes.sort());
 assert.equal(docker(['ps','-a','-q','--filter','label=uniclips.paystack.phase2c']),'');assert.equal(docker(['volume','ls','-q','--filter','label=uniclips.paystack.phase2c']),'');
 assert.equal(docker(['ps','-a','-q','--filter','label=uniclips.task=paystack-phase2c-probe']),'');
 const finalRun=runs.at(-1),finalResults=JSON.parse(fs.readFileSync(path.join(evidence,finalRun.nonce,'results.json')));assert.equal(finalResults.fail,0);assert.equal(finalResults.pass,28);assert.equal(finalRun.sourcePreserved,true);
 for(const[file,expected]of Object.entries(finalRun.sourceHashesAfter))assert.equal(hash(path.join(root,file)),expected);
 const summary={engineVersion:docker(['info','--format','{{.ServerVersion}}']),finalAttempt:finalRun.nonce,finalPass:28,finalFail:0,
  attempts:runs.map(r=>({nonce:r.nonce,exitCode:r.exitCode,container:r.container,volume:r.volume,cleanup:r.cleanup})),
  allTaskResourcesRemoved:true,existingContainerIdentitiesAndStoppedStatePreserved:true,existingVolumeNamesPreserved:true,existingContainers:containers,existingVolumes:volumes,
  runtime:runs[0].runtime,mysqlImage:runs[0].mysqlImage,finalRuntimeInputsUnchanged:true};
 fs.writeFileSync(path.join(evidence,'VALIDATION_SUMMARY.json'),JSON.stringify(summary,null,2)+'\n');result.dockerVerification=summary;
}
fs.writeFileSync(path.join(root,'docs/paystack-nigeria-phase2c-evidence/PRESERVATION.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
