'use strict';
// Explicit isolated frontend build/test runner; no install or network.
if(!process.argv.includes('--execute-disposable')){console.log('Preview only; no Docker command ran.');}else{
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),workspace=path.resolve(root,'../..'),nonce=crypto.randomBytes(6).toString('hex'),name='uniclips-paystack-2d-ui-'+nonce,out=path.join(root,'docs/paystack-nigeria-phase2d-evidence'),label='uniclips.paystack.phase2d.frontend='+nonce;
const docker=(a)=>cp.execFileSync('docker',['--context','desktop-linux',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const runtime='sha256:a14aaa2a206bacf1d11c3cefd2a927b4752b7684e19558055c5968df873367a8',cached='uniclips-p2j-j2-22233-frontend-ci-full';
assert.equal(docker(['image','inspect',runtime,'--format','{{.Id}}']),runtime);assert.equal(docker(['volume','inspect',cached,'--format','{{.Name}}']),cached);
const args=['run','--rm','--name',name,'--label',label,'--pull=never','--network','none','--read-only','--cpus','2','--memory','1536m','--memory-swap','1536m','--tmpfs','/tmp:rw,exec,size=512m','--tmpfs','/frontend:rw,exec,size=256m','--mount','type=volume,source='+cached+',target=/cached,readonly',...[
 [path.join(workspace,'.release-worktrees/paystack-nigeria-frontend'),'/source',true],[__dirname,'/harness',true],[out,'/evidence',false],[path.join(workspace,'analysis/security/p2j/j1/linux-context/frontend'),'/seed',true],[path.join(workspace,'analysis/security/p2j/j1/tools/linux/gitleaks'),'/scanner',true]
].flatMap(([from,to,ro])=>['--mount','type=bind,source='+from+',target='+to+(ro?',readonly':'')]),runtime,'/opt/node-v22.23.3-linux-x64/bin/node','/harness/paystackNigeriaFrontendCase.cjs','frontend-'+nonce];
try{const r=cp.spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:480000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(out,'frontend-'+nonce+'.log'),(r.stdout||'')+(r.stderr||''));console.log(r.stdout||'');console.error(r.stderr||'');if(r.status!==0)process.exitCode=1;}finally{
 const ids=docker(['ps','-a','-q','--filter','label='+label]);if(ids){const s=JSON.parse(docker(['inspect',name]))[0];assert.equal(s.Config.Labels['uniclips.paystack.phase2d.frontend'],nonce);if(s.State.Running)docker(['stop','--time','10',name]);docker(['rm',name]);}
 assert.equal(docker(['ps','-a','-q','--filter','label='+label]),'');
}
}
