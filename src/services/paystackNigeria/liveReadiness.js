'use strict';
const {settings,deny,hash}=require('./liveConfiguration');
function guardedPool({pool,env,readCA,buildPoolConfig=require('../../config/databaseTls').buildPoolConfig}={}){
 const expected=settings(env),tls=buildPoolConfig(env,readCA);
 if(tls.ssl?.rejectUnauthorized!==true||tls.ssl?.verifyIdentity!==true)deny('DB_TLS_REQUIRED');
 const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const literal=escape(expected.name),escaped=escape(expected.name.replaceAll('_','\\_'));
 async function getConnection(){
  const c=await pool.getConnection();
  try{
   await c.query({sql:"SET SESSION time_zone = '+00:00'",timeout:5000});
   const [[r]]=await c.query({sql:'SELECT DATABASE() AS db,CURRENT_USER() AS account,CURRENT_ROLE() AS effective_role,@@GLOBAL.partial_revokes AS partial_revokes',timeout:5000});
   if(r.db!==expected.name||String(r.account).split('@')[0]!==expected.user||r.effective_role!=='NONE')deny('PAYSTACK_LIVE_DATABASE_IDENTITY_MISMATCH');
   // Schema-level underscores are wildcards unless partial_revokes is enabled.
   // Quoting alone does not narrow that privilege to the literal schema name.
   if(![0,1,'0','1'].includes(r.partial_revokes))deny('PAYSTACK_LIVE_DATABASE_GRANTS_UNSAFE');
   const schema=(r.partial_revokes===1||r.partial_revokes==='1')?'(?:'+literal+'|'+escaped+')':escaped;
   const privilege='(?:SELECT|INSERT|UPDATE|DELETE)';
   const grant=new RegExp('^GRANT '+privilege+'(?:, '+privilege+')* ON (?:'+schema+'|`'+schema+'`|"'+schema+'")\\.\\* TO ');
   const [grants]=await c.query({sql:'SHOW GRANTS',timeout:5000});
   if(!grants.length||grants.some(row=>{const g=String(Object.values(row)[0]);return /WITH GRANT OPTION/i.test(g)||!/^GRANT USAGE ON \*\.\* TO /i.test(g)&&!grant.test(g);}))deny('PAYSTACK_LIVE_DATABASE_GRANTS_UNSAFE');
   const [cipher]=await c.query({sql:"SHOW SESSION STATUS LIKE 'Ssl_cipher'",timeout:5000}),[version]=await c.query({sql:"SHOW SESSION STATUS LIKE 'Ssl_version'",timeout:5000});
   if(!cipher[0]?.Value||!['TLSv1.2','TLSv1.3'].includes(version[0]?.Value))deny('DB_TLS_NOT_NEGOTIATED');
   const [marker]=await c.query({sql:"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sandbox_manifest'",timeout:5000});
   if(marker.length)deny('PAYSTACK_LIVE_SANDBOX_DATABASE_FORBIDDEN');
   return c;
  }catch(e){c.destroy();throw e;}
 }
 const query=async(sql,args)=>{const c=await getConnection();try{return await c.query(sql,args);}finally{c.release();}};
 return {getConnection,query};
}
async function metadata(pool){
 const m=await require('../../sandbox/bootstrap').metadata(pool);
 const [rows]=await pool.query("SELECT t.TABLE_NAME AS table_name,c.CHECK_CLAUSE AS clause,t.ENFORCED AS enforced FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME WHERE t.TABLE_SCHEMA=DATABASE() AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME");
 m.checks=rows.map(r=>({table:r.table_name,clause:r.clause,enforced:r.enforced}));return require('./liveSchema').requireLiveSchema(m);
}
const auditDigest=a=>hash(JSON.stringify([a.subject_id,a.scholar_id,a.review_version,a.baseline_count,a.baseline_digest,a.source_revision,a.review_id,a.writer_mode,a.state]));
function historicalResolver(config){return async(db,purchases,scope)=>{
 config.assertScope(scope.subjectId,scope.scholarId);
 const h=require('../coursePayments/historicalResolver'),{audit,rows}=await h.auditedFacts(db,scope);
 if(auditDigest(audit)!==config.auditDigest||rows.some(r=>r.environment!=='live'))deny('PAYSTACK_LIVE_HISTORY_REVIEW_REQUIRED');
 return h.resolveHistoricalSales(db,purchases,scope);
};}
module.exports={guardedPool,metadata,auditDigest,historicalResolver};
