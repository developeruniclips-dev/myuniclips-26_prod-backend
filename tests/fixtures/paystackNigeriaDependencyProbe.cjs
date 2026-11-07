'use strict';
// Disposable Linux-only dependency I/O diagnostic. No network or DB code.
if(!process.argv.includes('--owned-probe')){console.log('Preview only.');}else{
 const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');assert.equal(process.platform,'linux');assert.equal(process.version,'v22.23.3');
 const target='/tmp/paystack-deps-'+crypto.randomBytes(6).toString('hex');
 function sample(dir){const r=cp.spawnSync(process.execPath,['-e',"const start=performance.now();require(process.argv[1]+'/express');console.log(JSON.stringify({requireMs:performance.now()-start}));",dir],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:30000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
 const bind=sample('/deps/node_modules'),start=performance.now();fs.cpSync('/deps/node_modules',target+'/node_modules',{recursive:true});const copyMs=performance.now()-start,native=sample(target+'/node_modules');
 console.log(JSON.stringify({runtime:process.version,bind,native,copyMs,network:false,installedPackages:0,limitations:'Single cold bind / warm native comparison; not production performance evidence.'}));
}
