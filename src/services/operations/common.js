const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const staff = actor => actor.roles.some(r=>['Admin','SuperAdmin'].includes(r));
const owner = actor => actor.roles.includes('SuperAdmin');
function text(value,label,max=4000) {
    if(typeof value!=='string'||!value.trim()||[...value].length>max) fail(400,`${label} is required (maximum ${max} characters)`);
    return value.trim();
}
function id(value) { const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail(400,'Invalid identifier');return n; }
function page(query={}) { const limit=Math.min(50,Math.max(1,parseInt(query.limit)||20));const number=Math.min(1000000,Math.max(1,parseInt(query.page)||1));return{limit,page:number,offset:(number-1)*limit}; }
async function tx(pool,work) { const db=await pool.getConnection();try{await db.beginTransaction();const value=await work(db);await db.commit();return value;}catch(e){await db.rollback();throw e;}finally{db.release();} }
async function audit(db,actor,action,type,target,details={}) {
    // Callers supply a safe allowlist of metadata, never arbitrary request bodies.
    await db.query('INSERT INTO admin_activity_log (user_id,action,target_type,target_id,details) VALUES (?,?,?,?,?)',[actor.id,action,type,target||null,JSON.stringify(details)]);
}
async function optional(db,sql,args=[]) { try { return (await db.query(sql,args))[0]; }catch(e){if(e.code==='ER_NO_SUCH_TABLE')return null;throw e;} }
function schemaUnavailable(error) {
    if(error.code!=='ER_NO_SUCH_TABLE')return null;
    const table=error.sqlMessage?.match(/\.([a-z_]+)' doesn't exist/i)?.[1];
    if(['payment_catalogue_policy','payment_orders','payment_sale_counters','payment_allocations','payment_events','payment_transfers','payment_adjustments'].includes(table))
        return{code:'PAYMENT_SCHEMA_UNAVAILABLE',message:'Payment Phase 2A is not migrated. Legacy transactions remain available.'};
    if(['support_cases','support_messages','admin_escalations','escalation_messages','admin_activity_log','admin_profiles','security_updates'].includes(table))
        return{code:'OPERATIONS_SCHEMA_UNAVAILABLE',message:'This feature will become available after the operations migration.'};
    return null;
}
async function actorFromDb(pool,user) {
    const [rows]=await pool.query('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?',[user.id]);
    if(!rows.length)fail(403,'Account has no current access role');
    return {id:Number(user.id),roles:rows.map(r=>r.name)};
}
module.exports={fail,staff,owner,text,id,page,tx,audit,optional,schemaUnavailable,actorFromDb};
