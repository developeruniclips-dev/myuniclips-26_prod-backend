'use strict';
const {settings,fail,DATABASE}=require('./isolation');
// Sandbox composition only. Every lease is initialized before it reaches any
// application code. No GLOBAL setting, event-handler race, or plaintext fallback.
function createSandboxPool({env,createPool,readCA,requireMarker=true}={}) {
  settings(env);
  const config={...require('../config/databaseTls').buildPoolConfig(env,readCA),
    connectionLimit:2,queueLimit:4,connectTimeout:10000,timezone:'Z',supportBigNumbers:true,bigNumberStrings:true};
  const raw=createPool(config);
  async function getConnection(){
    const c=await raw.getConnection();
    try {
      await c.query({sql:"SET SESSION time_zone = '+00:00'",timeout:5000});
      const [[r]]=await c.query({sql:'SELECT DATABASE() AS db, CURRENT_USER() AS account, @@session.time_zone AS zone',timeout:5000});
      if(r.db!==DATABASE||String(r.account).split('@')[0]!==env.DB_USER||r.zone!=='+00:00')fail('SANDBOX_DATABASE_IDENTITY_MISMATCH');
      const [grants]=await c.query({sql:'SHOW GRANTS',timeout:5000});
      // Reject global/role/cross-schema grants. Metadata access inherent in
      // MySQL remains possible; production application data must be inaccessible.
      for(const row of grants){const g=String(Object.values(row)[0]);
        if(!/^GRANT USAGE ON \*\.\* TO /i.test(g)&&
           !new RegExp('^GRANT [A-Z_, ]+ ON `?'+DATABASE+'`?\\.\\* TO ','i').test(g))fail('SANDBOX_DATABASE_GRANTS_UNSAFE');
        if(/WITH GRANT OPTION/i.test(g))fail('SANDBOX_DATABASE_GRANTS_UNSAFE');
        if(env.DB_USER==='psngsandboxapp'&&!/^GRANT (?:USAGE|SELECT|INSERT|UPDATE|DELETE|,| )+ ON /i.test(g))fail('SANDBOX_DATABASE_GRANTS_UNSAFE');
      }
      if(requireMarker){const [rows]=await c.query({sql:"SELECT version FROM sandbox_manifest WHERE singleton=1 AND database_name=? AND kind='synthetic-paystack-test'",timeout:5000},[DATABASE]);if(rows.length!==1||rows[0].version!==1)fail('SANDBOX_MANIFEST_REQUIRED');}
      return c;
    } catch(e){c.destroy();throw e;}
  }
  async function query(sql,args){const c=await getConnection();try{return await c.query(sql,args);}finally{c.release();}}
  return {getConnection,query,execute:async(sql,args)=>{const c=await getConnection();try{return await c.execute(sql,args);}finally{c.release();}},end:()=>raw.end(),config};
}
module.exports={createSandboxPool};
