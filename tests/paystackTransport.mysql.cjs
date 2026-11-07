'use strict';
// Reuse the exact owned-database/TLS fixture setup, then replace only its case
// dispatcher. The original Phase 2D matrix is qualified separately, unchanged.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const file=path.join(__dirname,'paystackNigeria.phase2d.mysql.cjs');let source=fs.readFileSync(file,'utf8');
const marker='await phaseDCases();';if(source.split(marker).length!==2)throw Error('Fixture dispatcher drift');
source=source.replace(marker,"await require('./fixtures/paystackTransportMatrix.cjs')({pool,exec,test,scope,seedAudited,auditScope,meta,store,report,crypto});");
new Function('require','__dirname','__filename',source)(createRequire(file),__dirname,file);
