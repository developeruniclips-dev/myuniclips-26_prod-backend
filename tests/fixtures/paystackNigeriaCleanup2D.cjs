'use strict';
// Explicit recovery for the single known interrupted task, never a broad prune.
if(!process.argv.includes('--cleanup-interrupted-448ac185b2f5')){console.log('Preview only.');}else{
 const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const docker=a=>cp.execFileSync('docker',['--context','desktop-linux',...a],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
 const nonce='448ac185b2f5',name='uniclips-paystack-2d-'+nonce,volume=name+'-data',label='uniclips.paystack.phase2d='+nonce;
 const expected='060c8bfafca300c21fbd5d28dac8f25d3d97d62749e89a47904954771124af93';
 const live=docker(['ps','-a','-q','--no-trunc','--filter','label='+label]).split('\n').filter(Boolean);
 assert.deepEqual(live,[expected],'Only the exact idle database may remain');
 const state=JSON.parse(docker(['inspect',name]))[0];assert.equal(state.Id,expected);assert.equal(state.Config.Labels['uniclips.paystack.phase2d'],nonce);
 assert.equal(state.HostConfig.NetworkMode,'none');assert.equal(state.Mounts.find(m=>m.Destination==='/var/lib/mysql').Name,volume);
 assert.equal(JSON.parse(docker(['volume','inspect',volume]))[0].Labels['uniclips.paystack.phase2d'],nonce);
 docker(['stop','--time','20',expected]);docker(['rm',expected]);docker(['volume','rm',volume]);
 assert.equal(docker(['ps','-a','-q','--filter','label='+label]),'');assert.equal(docker(['volume','ls','-q','--filter','label='+label]),'');
 fs.writeFileSync(path.resolve(__dirname,'../../docs/paystack-nigeria-phase2d-evidence/INTERRUPTED_RUN_CLEANUP.json'),JSON.stringify({nonce,container:expected,volume,allWorkSettled:true,containerRemoved:true,volumeRemoved:true,at:new Date().toISOString()},null,2));
 console.log('Exact interrupted task resources removed.');
}
