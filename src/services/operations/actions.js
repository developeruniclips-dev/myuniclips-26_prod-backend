const {fail,staff,owner,text,id,tx,audit}=require('./common');
const {withCourseLock}=require('../../utils/courseContent');
function createActions(pool) {
    async function approvePendingVideos() { fail(409,'Pending-only approval is unavailable. Review and publish the complete submitted course.'); }
    async function review(actor,kind,target,body) {
        if(!staff(actor))fail(403,'Administrative access required');
        if(kind==='videos')fail(409,'Use course review to request changes or publish the complete submitted course.');
        const approve=body.decision==='approve';if(!['approve','reject'].includes(body.decision))fail(400,'Choose approve or reject');
        if(!['scholars','courses','videos'].includes(kind))fail(404,'Queue not found');
        const table={scholars:'scholar_profile',courses:'scholar_subjects',videos:'videos'}[kind];
        const work=async db=>{
            const [[row]]=await db.query(`SELECT * FROM ${table} WHERE id=? FOR UPDATE`,[id(target)]);if(!row)fail(404,'Review item not found');
            if(row.approved)fail(409,'This item is already approved. Escalate changes to published content or approved context.');
            if(kind==='scholars'){
                if(approve){
                    await db.query('UPDATE scholar_profile SET approved=1 WHERE id=?',[row.id]);
                    const [[role]]=await db.query("SELECT id FROM roles WHERE name='Scholar'");if(!role)fail(409,'Scholar role is unavailable');
                    await db.query('INSERT INTO user_roles (user_id,role_id) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id=? AND role_id=?)',[row.user_id,role.id,row.user_id,role.id]);
                }else{
                    const [[refs]]=await db.query('SELECT (SELECT COUNT(*) FROM videos WHERE scholar_user_id=?)+(SELECT COUNT(*) FROM scholar_subjects WHERE scholar_user_id=?)+(SELECT COUNT(*) FROM subject_purchases WHERE scholar_id=?) AS n',[row.user_id,row.user_id,row.user_id]);
                    if(Number(refs.n))fail(409,'Scholar has content or financial references; escalate for review');
                    await db.query('DELETE FROM scholar_profile WHERE id=? AND approved=0',[row.id]);
                }
            }else if(kind==='courses'){
                const [[profile]]=await db.query('SELECT approved FROM scholar_profile WHERE user_id=?',[row.scholar_user_id]);
                if(approve&&!profile?.approved)fail(409,'Scholar approval is required first');
                if(approve)await db.query('UPDATE scholar_subjects SET approved=1 WHERE id=?',[row.id]);
                else{
                    const [[refs]]=await db.query('SELECT (SELECT COUNT(*) FROM videos WHERE subject_id=? AND scholar_user_id=?)+(SELECT COUNT(*) FROM subject_purchases WHERE subject_id=? AND scholar_id=?) AS n',[row.subject_id,row.scholar_user_id,row.subject_id,row.scholar_user_id]);
                    if(Number(refs.n))fail(409,'Course has content or purchases; escalate for review');
                    await db.query('DELETE FROM scholar_subjects WHERE id=? AND approved=0',[row.id]);
                }
            }else if(approve){
                const [[application]]=await db.query('SELECT ss.id FROM scholar_subjects ss JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id WHERE ss.subject_id=? AND ss.scholar_user_id=? AND ss.approved=1 AND sp.approved=1',[row.subject_id,row.scholar_user_id]);
                if(!application)fail(409,'Approved Scholar and course are required');
                if(body.price!=null&&!owner(actor))fail(403,'Only SuperAdmin can set prices');
                const price=Number(row.sequence_index)===1?0:Number(body.price??row.price??0);
                if(!Number.isFinite(price)||price<0||price>999999||!/^\d+(\.\d{1,2})?$/.test(String(price)))fail(400,'Invalid video price');
                if(price!==Number(row.price||0)){
                    const [[context]]=await db.query('SELECT c.code FROM subjects s JOIN universities u ON u.id=s.university_id JOIN countries c ON c.id=u.country_id WHERE s.id=?',[row.subject_id]);
                    if(context?.code!=='FI')fail(409,'Nigeria pricing is not enabled');
                    await audit(db,actor,'VIDEO_PRICE_CHANGED','video',row.id,{previous:row.price,next:price,currency:'EUR'});
                }
                await db.query('UPDATE videos SET approved=1,price=?,is_free=? WHERE id=?',[price,price===0?1:0,row.id]);
            }else{
                const [[refs]]=await db.query('SELECT (SELECT COUNT(*) FROM purchases WHERE video_id=?)+(SELECT COUNT(*) FROM video_progress WHERE video_id=?) AS n',[row.id,row.id]);
                if(Number(refs.n))fail(409,'Video has learner references; escalate for review');
                await db.query('DELETE FROM videos WHERE id=? AND approved=0',[row.id]);
            }
            await audit(db,actor,`${kind.toUpperCase()}_${approve?'APPROVED':'REJECTED'}`,kind,row.id,{userId:row.user_id||row.scholar_user_id,subjectId:row.subject_id||null});
            return{success:true};
        };
        if(kind==='videos'){
            const [[video]]=await pool.query('SELECT scholar_user_id,subject_id FROM videos WHERE id=?',[id(target)]);if(!video)fail(404,'Video not found');
            return withCourseLock(pool,video.scholar_user_id,video.subject_id,async db=>{try{await db.beginTransaction();const result=await work(db);await db.commit();return result;}catch(e){await db.rollback();throw e;}});
        }
        return tx(pool,work);
    }
    async function privilegedUser(actor,userId,body) {
        if(!owner(actor))fail(403,'SuperAdmin required');
        const target=id(userId);if(target===actor.id)fail(409,'You cannot change your own privileges');
        const role=body.role;if(!['Learner','Scholar','Admin','SuperAdmin'].includes(role))fail(400,'Invalid role');
        return tx(pool,async db=>{
            // Lock role catalogue to serialize concurrent owner changes and last-owner checks.
            await db.query('SELECT id FROM roles ORDER BY id FOR UPDATE');
            const [[user]]=await db.query('SELECT id,email,fname,lname FROM users WHERE id=? FOR UPDATE',[target]);if(!user)fail(404,'User not found');
            const confirmation=`${role==='SuperAdmin'?'GRANT SUPERADMIN':role==='Admin'?'GRANT ADMIN':'CHANGE ROLE'} ${user.email}`;
            if(body.confirmation!==confirmation)fail(400,'Type the exact confirmation for this user');
            const [[existingOwner]]=await db.query("SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.name='SuperAdmin'",[target]);
            if(Number(existingOwner.n)&&role!=='SuperAdmin'){
                const [[count]]=await db.query("SELECT COUNT(DISTINCT user_id) AS n FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.name='SuperAdmin'");if(Number(count.n)<=1)fail(409,'The last SuperAdmin cannot be removed');
            }
            if(role==='Scholar'){const [[sp]]=await db.query('SELECT approved FROM scholar_profile WHERE user_id=?',[target]);if(!sp?.approved)fail(409,'Approve the Scholar application before granting this role');}
            const [[next]]=await db.query('SELECT id FROM roles WHERE name=?',[role]);if(!next)fail(409,'Role unavailable');
            await db.query('DELETE FROM user_roles WHERE user_id=?',[target]);
            await db.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)',[target,next.id]);
            await audit(db,actor,'ROLE_CHANGED','user',target,{role,scope:role==='Admin'?'GENERAL':undefined});return{success:true};
        });
    }
    async function createAdmin(actor,body) {
        if(!owner(actor))fail(403,'SuperAdmin required');
        const email=text(body.email,'Email',254).toLowerCase(),role=body.role||'Admin';
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['Admin','SuperAdmin'].includes(role))fail(400,'Valid email and privileged role required');
        if(body.confirmation!==`CREATE ${role.toUpperCase()} ${email}`)fail(400,'Explicit privileged-account confirmation is required');
        const password=text(body.password,'Password',200);if(password.length<12)fail(400,'Use a password of at least 12 characters');
        const hash=await require('../../utils/passwordHasher').hashPassword(password);
        return tx(pool,async db=>{
            const [[exists]]=await db.query('SELECT id FROM users WHERE email=?',[email]);if(exists)fail(409,'Email already registered');
            const [[grant]]=await db.query('SELECT id FROM roles WHERE name=?',[role]);if(!grant)fail(409,'Role unavailable');
            const [result]=await db.query('INSERT INTO users (fname,lname,email,password) VALUES (?,?,?,?)',[text(body.firstname,'First name',100),text(body.lastname,'Last name',100),email,hash]);
            await db.query('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)',[result.insertId,grant.id]);
            await audit(db,actor,'ADMIN_CREATED','user',result.insertId,{role,scope:'GENERAL'});return{id:result.insertId};
        });
    }
    async function deleteUser(actor,userId,body) {
        if(!owner(actor))fail(403,'SuperAdmin required');const target=id(userId);if(target===actor.id)fail(409,'You cannot delete yourself');
        return tx(pool,async db=>{
            const [[user]]=await db.query('SELECT id,email FROM users WHERE id=? FOR UPDATE',[target]);if(!user)fail(404,'User not found');
            if(body.confirmation!==`DELETE ${user.email}`)fail(400,'Explicit user deletion confirmation required');
            const [[privileged]]=await db.query("SELECT COUNT(*) AS n FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.name IN ('Admin','SuperAdmin')",[target]);
            if(Number(privileged.n))fail(409,'Remove privileged access before considering deletion');
            // Conservative: block every known user reference, including tables without FKs.
            // This also preserves payments, support history and all existing audit evidence.
            const [columns]=await db.query(`SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME NOT IN ('users','user_roles') AND COLUMN_NAME IN ('user_id','buyer_id','buyer_user_id','scholar_id','scholar_user_id','actor_id','created_by','assigned_to','handled_by','related_user_id')`);
            for(const column of columns){
                if(!/^[a-zA-Z0-9_]+$/.test(column.TABLE_NAME)||!/^[a-zA-Z0-9_]+$/.test(column.COLUMN_NAME))fail(409,'Reference review required');
                const [[count]]=await db.query(`SELECT COUNT(*) AS n FROM \`${column.TABLE_NAME}\` WHERE \`${column.COLUMN_NAME}\`=?`,[target]);
                if(Number(count.n))fail(409,'This user has related records. Deletion is blocked to preserve history; escalate for a retention review.');
            }
            const [foreignKeys]=await db.query("SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='users' AND TABLE_NAME!='user_roles'");
            for(const ref of foreignKeys){const [[count]]=await db.query(`SELECT COUNT(*) AS n FROM \`${ref.TABLE_NAME.replace(/`/g,'``')}\` WHERE \`${ref.COLUMN_NAME.replace(/`/g,'``')}\`=?`,[target]);if(Number(count.n))fail(409,'Referenced user cannot be deleted');}
            await db.query('DELETE FROM user_roles WHERE user_id=?',[target]);await db.query('DELETE FROM users WHERE id=?',[target]);
            await audit(db,actor,'USER_DELETED','user',target,{reason:'Unreferenced account; explicit confirmation'});return{success:true};
        });
    }
    async function price(actor,subjectId,body) {
        if(!owner(actor))fail(403,'SuperAdmin required');const amount=String(body.bundlePrice??body.price??'');
        if(!/^\d+(\.\d{1,2})?$/.test(amount)||Number(amount)>99999999)fail(400,'Valid price with up to two decimals required');
        return tx(pool,async db=>{
            const [[subject]]=await db.query('SELECT s.*,c.code FROM subjects s JOIN universities u ON u.id=s.university_id JOIN countries c ON c.id=u.country_id WHERE s.id=? FOR UPDATE',[id(subjectId)]);
            if(!subject)fail(404,'Subject not found');if(subject.code!=='FI')fail(409,'Nigeria pricing is not enabled');
            if(body.confirmation!==`PRICE ${subject.id}`)fail(400,'Confirm this price change');
            await db.query('UPDATE subjects SET bundle_price=?,bundle_price_updated_at=NOW() WHERE id=?',[amount,subject.id]);
            await audit(db,actor,'PRICE_CHANGED','subject',subject.id,{previous:subject.bundle_price,next:amount,currency:'EUR'});return{success:true};
        });
    }
    return{review,approvePendingVideos,privilegedUser,createAdmin,deleteUser,price};
}
module.exports={createActions};
