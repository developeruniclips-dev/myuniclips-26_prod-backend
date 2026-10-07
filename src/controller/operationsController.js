const {pool}=require('../config/db');
const {createData}=require('../services/operations/data');
const {createCases,categories,escalationCategories}=require('../services/operations/cases');
const {createActions}=require('../services/operations/actions');
const {actorFromDb,staff,owner,fail,audit,tx,text,id,schemaUnavailable}=require('../services/operations/common');
const data=createData(pool),cases=createCases(pool),actions=createActions(pool);
const handler=work=>async(req,res)=>{try{res.json(await work(req));}catch(e){
    const unavailable=schemaUnavailable(e);
    if(!e.status&&!unavailable)console.warn('Operations request failed',{path:req.route?.path,code:e.code||'UNKNOWN'});
    res.status(e.status||(unavailable?503:500)).json({code:unavailable?.code,
        message:e.status?e.message:unavailable?.message||'Unable to complete this operation. Please retry.'});
}};
const actor=async(req,res,next)=>{try{req.actor=await actorFromDb(pool,req.user);req.user.roles=req.actor.roles;next();}catch{res.status(503).json({message:'Unable to verify current permissions'});}};
const requireStaff=(req,res,next)=>staff(req.actor)?next():res.status(403).json({message:'Administrative access required'});
const requireOwner=(req,res,next)=>owner(req.actor)?next():res.status(403).json({message:'SuperAdmin access required'});
// Existing paths are retained as aliases to the same guarded, audited operations.
const legacyReview=(kind,decision,lookup)=>handler(async req=>{
    let target=req.params.id;
    if(lookup==='user'){const [[row]]=await pool.query('SELECT id FROM scholar_profile WHERE user_id=?',[req.body.user_id]);if(!row)fail(404,'Application not found');target=row.id;}
    if(lookup==='offering'){const [[row]]=await pool.query('SELECT id FROM scholar_subjects WHERE scholar_user_id=? AND subject_id=?',[req.body.scholar_id,req.body.subject_id]);if(!row)fail(404,'Application not found');target=row.id;}
    return actions.review(req.actor||await actorFromDb(pool,req.user),kind,target,{...req.body,decision});
});
const auditFinancial=async(req,res,next)=>{
    try{
        const current=req.actor||await actorFromDb(pool,req.user);
        if(!owner(current))return res.status(403).json({message:'SuperAdmin financial authority required'});
        if(!req.body.orderId||req.body.confirmation!==`TRANSFER ${req.body.orderId}`)return res.status(400).json({message:'Confirm the exact recorded order before releasing its allocation'});
        await audit(pool,current,'FINANCIAL_RELEASE_REQUESTED','payment',null,{orderId:typeof req.body.orderId==='string'?req.body.orderId.slice(0,36):null,scholarId:Number(req.body.scholarUserId)||null});
        res.once('finish',()=>audit(pool,current,'FINANCIAL_RELEASE_RESPONSE','payment',null,{status:res.statusCode}).catch(()=>console.warn('Financial audit response could not be recorded')));
        next();
    }catch{res.status(503).json({message:'Financial action blocked: audit storage is unavailable'});}
};
module.exports={data,cases,actions,handler,actor,requireStaff,requireOwner,legacyReview,auditFinancial,categories,escalationCategories,
    updatePerson:handler(req=>tx(pool,async db=>{
        const current=req.actor||req.user;if(!owner(current))fail(403,'SuperAdmin required');
        const target=id(req.params.id),first=text(req.body.fname,'First name',100),last=text(req.body.lname,'Last name',100),email=text(req.body.email,'Email',254).toLowerCase();
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'Valid email required');
        const [[user]]=await db.query('SELECT id,email FROM users WHERE id=? FOR UPDATE',[target]);if(!user)fail(404,'User not found');
        if(email!==user.email.toLowerCase())fail(403,'Recovery email changes require a verified address-change process');
        if(req.body.confirmation!==`UPDATE ${user.email}`)fail(400,'Confirm the target account before updating it');
        await db.query('UPDATE users SET fname=?,lname=?,email=? WHERE id=?',[first,last,email,target]);
        await audit(db,current,'USER_DETAILS_UPDATED','user',target,{emailChanged:email!==user.email});return{success:true};
    })),
    changeRole:handler(req=>actions.privilegedUser(req.actor||req.user,req.params.userId||req.params.id,req.body)),
    createAdmin:handler(req=>actions.createAdmin(req.actor||req.user,req.body)),
    deleteUser:handler(req=>actions.deleteUser(req.actor||req.user,req.params.userId||req.params.id,req.body)),
    price:handler(req=>actions.price(req.actor||req.user,req.params.id,req.body)),
    unavailable:(req,res)=>res.status(409).json({message:'This destructive operation requires a separate reference-preserving review. Create an escalation.'}),
    profileUpdate:handler(req=>tx(pool,async db=>{
        const first=text(req.body.firstname,'First name',100),last=text(req.body.lastname,'Last name',100);
        await db.query('UPDATE users SET fname=?,lname=? WHERE id=?',[first,last,req.user.id]);
        const [profileColumns]=await db.query("SELECT COLUMN_NAME AS name,CHARACTER_MAXIMUM_LENGTH AS max_length FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='admin_profiles'");
        const fields=['display_name','phone','department','bio'].map(k=>{const value=String(req.body[k]||''),policyMax=k==='bio'?2000:k==='phone'?50:150,max=Math.min(policyMax,Number(profileColumns.find(c=>c.name===k)?.max_length)||policyMax);if([...value].length>max)fail(400,`${k} must be no longer than ${max} characters`);return value;});
        await db.query(`INSERT INTO admin_profiles (user_id,display_name,phone,department,bio) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),phone=VALUES(phone),department=VALUES(department),bio=VALUES(bio)`,[req.user.id,...fields]);
        await audit(db,req.user,'PROFILE_UPDATED','user',req.user.id);return{success:true};
    })),
    securityUpdate:handler(req=>tx(pool,async db=>{
        if(req.params.id){const status=req.body.status;if(!['pending','in-progress','resolved'].includes(status))fail(400,'Invalid security status');
            const [[row]]=await db.query('SELECT id FROM security_updates WHERE id=? FOR UPDATE',[id(req.params.id)]);if(!row)fail(404,'Security record not found');
            await db.query("UPDATE security_updates SET status=?,resolved_by=?,resolved_at=IF(?='resolved',NOW(),NULL) WHERE id=?",[status,status==='resolved'?req.user.id:null,status,row.id]);
            await audit(db,req.user,'SECURITY_STATUS_CHANGED','security_update',row.id,{status});
        }else{const severity=req.body.severity||'medium';if(!['low','medium','high','critical'].includes(severity))fail(400,'Invalid severity');
            const [result]=await db.query('INSERT INTO security_updates (title,description,severity,created_by) VALUES (?,?,?,?)',[text(req.body.title,'Title',180),text(req.body.description,'Description'),severity,req.user.id]);
            await audit(db,req.user,'SECURITY_RECORD_CREATED','security_update',result.insertId,{severity});}
        return{success:true};
    }))};
