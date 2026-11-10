'use strict';
// Read-only cache probe; no installer, network, driver connection or config.
const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.version,'v22.23.3');
const lock=JSON.parse(fs.readFileSync('/candidate/package-lock.json'));
let checked=0;const absentOptional=[];
for(const [key,value] of Object.entries(lock.packages)){
 if(!key)continue;const file='/cached/'+key+'/package.json';
 if(!fs.existsSync(file)){assert.equal(value.optional,true,key);absentOptional.push(key);continue;}
 assert.equal(JSON.parse(fs.readFileSync(file)).version,value.version,key);checked++;
}
require('/cached/node_modules/mysql2/promise');
console.log(JSON.stringify({node:process.version,mysql2:require('/cached/node_modules/mysql2/package.json').version,checked,absentOptional}));
