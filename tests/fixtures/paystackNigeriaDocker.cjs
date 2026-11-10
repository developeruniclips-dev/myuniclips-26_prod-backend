'use strict';
// Explicit disposable-only Phase 2C runner. Never loads dotenv/application config.
if (!process.argv.includes('--execute-disposable')) {
    console.log('Preview only. --execute-disposable is required to create the owned fixture; no Docker command ran.');
} else {
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const workspace = path.resolve(root, '../..');
const runtime = 'sha256:a14aaa2a206bacf1d11c3cefd2a927b4752b7684e19558055c5968df873367a8';
const mysqlImage = 'sha256:6ea90827b1100f8f2ae306a539f86d2c264a26ed435a2a9f75551dd5c3aeb242';
const node = '/opt/node-v22.23.3-linux-x64/bin/node';
const deps = path.join(workspace, 'analysis/security/p2j/j2/work/windows-22.23.3-backend-ci-full/node_modules');
const nonce = crypto.randomBytes(6).toString('hex');
const label = 'uniclips.paystack.phase2c=' + nonce;
const name = 'uniclips-paystack-2c-' + nonce;
const volume = name + '-data';
const database = 'paystack_ng_phase2c_test_' + nonce;
const password = crypto.randomBytes(32).toString('hex');
const out = path.join(root, 'docs/paystack-nigeria-phase2c-evidence', nonce);
fs.mkdirSync(out, {recursive: true});
function docker(args, options = {}) {
    return cp.execFileSync('docker', ['--context','desktop-linux', ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options,
    }).trim();
}
const json = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
const result = {nonce, name, volume, database, runtime, mysqlImage, started: new Date().toISOString()};
const watched=['src/services/paystackNigeria/schema.js','src/services/paystackNigeria/store.js','src/services/paystackNigeria/services.js','src/services/paystackNigeria/baseline.js',
    'src/services/payments/paymentService.js','src/services/paymentRelease/service.js','src/services/payments/money.js','src/config/databaseTls.js',
    'tests/paystackNigeria.mysql.cjs','tests/fixtures/paystackNigeriaDocker.cjs','package.json','package-lock.json','.node-version'];
const hashes=()=>Object.fromEntries(watched.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
result.sourceHashesBefore=hashes();
let container, createdVolume = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    assert.equal(docker(['info','--format','{{.OSType}}']), 'linux');
    for (const image of [runtime, mysqlImage]) assert.equal(JSON.parse(docker(['image','inspect',image]))[0].Id, image);
    assert.equal(JSON.parse(fs.readFileSync(path.join(deps,'mysql2/package.json'))).version, '3.24.6');
    const probe = JSON.parse(docker(['run','--rm','--pull=never','--network','none','--read-only','--label',label,
        '--mount','type=bind,source='+deps+',target=/deps/node_modules,readonly','--entrypoint',node,runtime,'-e',
        "require('/deps/node_modules/mysql2/promise');console.log(JSON.stringify({node:process.version,mysql2:require('/deps/node_modules/mysql2/package.json').version}))"]));
    assert.deepEqual(probe,{node:'v22.23.3',mysql2:'3.24.6'});
    result.inputs = probe;
    result.existingContainers = docker(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}} {{.Status}}']).split('\n');
    result.existingVolumes = docker(['volume','ls','--format','{{.Name}}']).split('\n');
    assert(!result.existingVolumes.includes(volume));
    docker(['volume','create','--label',label,volume]); createdVolume = true;
    container = docker(['run','--detach','--pull=never','--name',name,'--label',label,
        '--network','none','--read-only','--memory','768m','--memory-swap','768m','--cpus','1','--pids-limit','256',
        '--tmpfs','/tmp:rw,size=128m','--tmpfs','/var/run/mysqld:rw,size=16m',
        '--mount','type=volume,source='+volume+',target=/var/lib/mysql',
        '-e','MYSQL_ROOT_PASSWORD','-e','MYSQL_DATABASE='+database,mysqlImage,
        '--default-time-zone=+00:00','--innodb-lock-wait-timeout=3','--mysqlx=0','--skip-name-resolve'],
        {env:{...process.env,MYSQL_ROOT_PASSWORD:password}});
    assert(/^[a-f0-9]{64}$/.test(container)); result.container = container;
    const inspect = () => JSON.parse(docker(['inspect',container]))[0];
    let state = inspect();
    assert.equal(state.Config.Labels['uniclips.paystack.phase2c'], nonce);
    assert.equal(state.HostConfig.NetworkMode,'none');
    assert.equal(Object.keys(state.HostConfig.PortBindings || {}).length,0);
    assert.equal(state.Mounts.find(m=>m.Destination==='/var/lib/mysql').Name,volume);
    result.isolation = {network:state.HostConfig.NetworkMode,ports:state.HostConfig.PortBindings,readOnly:state.HostConfig.ReadonlyRootfs,mount:volume};
    let ready = false;
    for (let i=0;i<90;i++) {
        const probe = cp.spawnSync('docker',['--context','desktop-linux','exec',container,'mysqladmin','--protocol=tcp','-h127.0.0.1','ping'],{encoding:'utf8',windowsHide:true,timeout:5000});
        if (probe.status===0) { ready=true; break; }
        state=inspect(); assert.equal(state.State.Running,true,'task-owned database exited before readiness');
        await wait(1000);
    }
    assert(ready,'task-owned MySQL readiness timed out');
    const ca=docker(['exec',container,'cat','/var/lib/mysql/ca.pem']);
    const certificate=docker(['exec',container,'cat','/var/lib/mysql/server-cert.pem']);
    const fingerprint=new crypto.X509Certificate(certificate).fingerprint256;
    const args=['run','--rm','--interactive','--pull=never','--read-only','--label',label,
        '--cpus','1','--memory','512m','--memory-swap','512m','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--tmpfs','/tmp:rw,size=64m','--network','container:'+container,
        '--mount','type=bind,source='+root+',target=/candidate,readonly',
        '--mount','type=bind,source='+deps+',target=/deps/node_modules,readonly',
        '--workdir','/candidate','--entrypoint',node,runtime,'/candidate/tests/paystackNigeria.mysql.cjs','--owned-phase2c'];
    // Credentials/CA travel on stdin only, never argv, repository files or logs.
    const run=cp.spawnSync('docker',['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true,timeout:480000,
        input:JSON.stringify({database,password,nonce,container,ca,certificate,fingerprint}),maxBuffer:8*1024*1024});
    fs.writeFileSync(path.join(out,'tests.txt'),(run.stdout||'')+(run.stderr||''));
    result.exitCode=run.status; result.harnessError=run.error?.code;
    const marker=(run.stdout||'').split('\n').find(line=>line.startsWith('PHASE2C_RESULT '));
    if (marker) json('results.json',JSON.parse(marker.slice('PHASE2C_RESULT '.length)));
    console.log(run.stdout||''); if(run.stderr)console.error(run.stderr);
    if(run.status!==0)process.exitCode=1;
})().catch(error=>{
    // No command argument/environment dump (the generated credential is private).
    result.failure={name:error.name,code:error.code,message:String(error.message).split('\n')[0].replaceAll(password,'[redacted]')};
    console.error(JSON.stringify(result.failure));process.exitCode=1;
}).finally(()=>{
    const cleanup={};
    try {
        if(container){
            const state=JSON.parse(docker(['inspect',container]))[0];
            assert.equal(state.Id,container);assert.equal(state.Config.Labels['uniclips.paystack.phase2c'],nonce);
            // docker run --rm has settled/been terminated before the DB stops.
            const workers=docker(['ps','-q','--filter','label='+label]).split('\n').filter(id=>id && !container.startsWith(id));
            assert.equal(workers.length,0,'refuse cleanup while test workers remain');
            docker(['stop','--time','20',container],{timeout:30000});
            docker(['rm',container]);cleanup.containerRemoved=true;
        }
        if(createdVolume){
            const entry=JSON.parse(docker(['volume','inspect',volume]))[0];
            assert.equal(entry.Labels['uniclips.paystack.phase2c'],nonce);
            docker(['volume','rm',volume]);cleanup.volumeRemoved=true;
        }
        cleanup.remainingOwnedContainers=docker(['ps','-a','-q','--filter','label='+label]);
        cleanup.remainingOwnedVolumes=docker(['volume','ls','-q','--filter','label='+label]);
        assert.equal(cleanup.remainingOwnedContainers,'');assert.equal(cleanup.remainingOwnedVolumes,'');
    }catch(error){cleanup.failure=String(error.message).split('\n')[0];process.exitCode=1;}
    result.sourceHashesAfter=hashes();
    result.sourcePreserved=JSON.stringify(result.sourceHashesBefore)===JSON.stringify(result.sourceHashesAfter);
    if(!result.sourcePreserved)process.exitCode=1;
    result.finished=new Date().toISOString();result.cleanup=cleanup;json('run.json',result);
    console.log(JSON.stringify({evidence:path.relative(root,out),exitCode:result.exitCode,cleanup}));
});
}
