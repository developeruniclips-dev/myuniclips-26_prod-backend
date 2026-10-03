const {fail,staff,owner,text,id,page,tx,audit,optional}=require('./common');
const categories=['Payment','Course Access','Account','Scholar','Course/Content','Technical','Other'];
const escalationCategories=['Payment/Refund','Suspicious Activity','User Deletion','Permissions','Scholar','Technical','Financial Discrepancy','Content/Legal','Other'];
function createCases(pool) {
    async function accessible(db,actor,kind,caseId,lock=false) {
        const escalation=kind==='escalations'; const table=escalation?'admin_escalations':'support_cases';
        const [[row]]=await db.query(`SELECT * FROM ${table} WHERE id=?${lock?' FOR UPDATE':''}`,[id(caseId)]);
        if(!row || (escalation ? !staff(actor)||(!owner(actor)&&row.created_by!==actor.id) : !staff(actor)&&row.user_id!==actor.id))fail(404,'Case not found');
        return row;
    }
    async function list(actor,kind,query) {
        const escalation=kind==='escalations';if(escalation&&!staff(actor))fail(403,'Administrative access required');
        const table=escalation?'admin_escalations':'support_cases', creator=escalation?'created_by':'user_id', title=escalation?'title':'subject';
        const ready=(await optional(pool,`SELECT id FROM ${table} LIMIT 0`))&&
            (await optional(pool,`SELECT id FROM ${escalation?'escalation_messages':'support_messages'} LIMIT 0`));
        if(!ready)return{available:false,rows:[],total:null,message:'This feature will become available after the operations migration.'};
        const where=['1=1'],args=[];const paging=page(query);
        if(escalation?!owner(actor):!staff(actor)){where.push(`c.${creator}=?`);args.push(actor.id);}
        if(query.userId&&staff(actor)&&!escalation){where.push('c.user_id=?');args.push(id(query.userId));}
        if(query.status){where.push('c.status=?');args.push(query.status);}
        if(query.category){where.push('c.category=?');args.push(query.category);}
        if(query.q){where.push(`(c.${title} LIKE ? OR CONCAT('${escalation?'UE':'UC'}-',c.id+1000) LIKE ? OR u.email LIKE ?)`);args.push(...Array(3).fill(`%${String(query.q).slice(0,120)}%`));}
        const from=`FROM ${table} c LEFT JOIN users u ON u.id=c.${creator} WHERE ${where.join(' AND ')}`;
        const [[count]]=await pool.query(`SELECT COUNT(*) AS total ${from}`,args);
        const [rows]=await pool.query(`SELECT c.*,CONCAT(u.fname,' ',u.lname) AS person_name,CONCAT('${escalation?'UE':'UC'}-',c.id+1000) AS reference ${from} ORDER BY c.id DESC LIMIT ? OFFSET ?`,[...args,paging.limit,paging.offset]);
        return {rows,total:Number(count.total),...paging};
    }
    async function detail(actor,kind,caseId,query={}) {
        const row=await accessible(pool,actor,kind,caseId);const escalation=kind==='escalations';const pagingLimit=50;
        const [messages]=await pool.query(`SELECT m.id,m.actor_id,m.body,m.created_at${escalation?'':',m.internal'},CONCAT(u.fname,' ',u.lname) AS author
            FROM ${escalation?'escalation_messages':'support_messages'} m LEFT JOIN users u ON u.id=m.actor_id
            WHERE m.${escalation?'escalation_id':'case_id'}=? ${!escalation&&!staff(actor)?'AND m.internal=0':''} ${query.before?'AND m.id<?':''} ORDER BY m.id DESC LIMIT ?`,[row.id,...(query.before?[id(query.before)]:[]),pagingLimit+1]);
        const hasMore=messages.length>pagingLimit;if(hasMore)messages.pop();
        const assignee=escalation?row.handled_by:row.assigned_to;
        const [[assigned]]=await pool.query("SELECT CONCAT(fname,' ',lname) AS name FROM users WHERE id=?",[assignee||0]);
        return {...row,reference:`${escalation?'UE':'UC'}-${row.id+1000}`,assigned_name:assigned?.name||null,messages:messages.reverse(),hasMore};
    }
    async function create(actor,kind,body) {
        const escalation=kind==='escalations';if(escalation&&!staff(actor))fail(403,'Administrative access required');
        const allowed=escalation?escalationCategories:categories;if(!allowed.includes(body.category))fail(400,'Choose a valid category');
        const title=text(body[escalation?'title':'subject'],'Subject',180),description=text(body.description,'Description');
        return tx(pool,async db=>{
            let result;
            if(escalation){
                const priority=body.priority||'NORMAL';if(!['NORMAL','HIGH','URGENT'].includes(priority))fail(400,'Invalid priority');
                const references=[['related_user_id','users'],['support_case_id','support_cases'],['subject_id','subjects'],['order_id','payment_orders']];
                for(const [key,table]of references)if(body[key]){const [[exists]]=await db.query(`SELECT id FROM ${table} WHERE id=?`,[body[key]]);if(!exists)fail(400,'Related record not found');}
                [result]=await db.query(`INSERT INTO admin_escalations (created_by,category,title,description,priority,related_user_id,support_case_id,order_id,subject_id)
                    VALUES (?,?,?,?,?,?,?,?,?)`,[actor.id,body.category,title,description,priority,body.related_user_id||null,body.support_case_id||null,body.order_id||null,body.subject_id||null]);
            }else [result]=await db.query('INSERT INTO support_cases (user_id,category,subject,description) VALUES (?,?,?,?)',[actor.id,body.category,title,description]);
            await audit(db,actor,escalation?'ESCALATION_CREATED':'SUPPORT_CREATED',escalation?'escalation':'support_case',result.insertId,{category:body.category});
            return {id:result.insertId,reference:`${escalation?'UE':'UC'}-${result.insertId+1000}`};
        });
    }
    async function update(actor,kind,caseId,body) {
        const escalation=kind==='escalations';if(escalation?!owner(actor):!staff(actor))fail(403,'Insufficient authority');
        return tx(pool,async db=>{
            const row=await accessible(db,actor,kind,caseId,true);const table=escalation?'admin_escalations':'support_cases';
            const statuses=escalation?['OPEN','IN_REVIEW','RESOLVED']:['OPEN','IN_PROGRESS','RESOLVED'];
            const status=body.status||row.status;
            if(!statuses.includes(status)||statuses.indexOf(status)<statuses.indexOf(row.status)||statuses.indexOf(status)>statuses.indexOf(row.status)+1)fail(409,'Use the next case status; resolved history cannot be reset');
            const assigned=body.assignedTo==null||body.assignedTo===''?(escalation?row.handled_by:row.assigned_to):id(body.assignedTo);
            if(assigned){const [roles]=await db.query('SELECT r.name FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=?',[assigned]);if(!roles.some(r=>(escalation?['SuperAdmin']:['Admin','SuperAdmin']).includes(r.name)))fail(400,'Choose an authorized assignee');}
            let resolution=null;if(escalation&&status==='RESOLVED')resolution=text(body.resolution||row.resolution,'Resolution');
            await db.query(`UPDATE ${table} SET status=?,${escalation?'handled_by':'assigned_to'}=?${escalation?',resolution=?':''} WHERE id=?`,escalation?[status,assigned,resolution,row.id]:[status,assigned,row.id]);
            const message=`Status: ${status}. Assignment: ${assigned?`user #${assigned}`:'unassigned'}.${resolution?` Resolution: ${resolution}`:''}`;
            await db.query(`INSERT INTO ${escalation?'escalation_messages':'support_messages'} (${escalation?'escalation_id':'case_id'},actor_id,body) VALUES (?,?,?)`,[row.id,actor.id,message]);
            await audit(db,actor,escalation?'ESCALATION_UPDATED':'SUPPORT_UPDATED',escalation?'escalation':'support_case',row.id,{status,assignedTo:assigned});
            return {success:true};
        });
    }
    async function message(actor,kind,caseId,body) {
        return tx(pool,async db=>{
            const row=await accessible(db,actor,kind,caseId,true),escalation=kind==='escalations';
            const content=text(body.body,'Message');if(body.internal&&!staff(actor))fail(403,'Internal notes are administrative only');
            const [result]=await db.query(`INSERT INTO ${escalation?'escalation_messages':'support_messages'} (${escalation?'escalation_id':'case_id'},actor_id,body${escalation?'':',internal'}) VALUES (${escalation?'?,?,?':'?,?,?,?'})`,escalation?[row.id,actor.id,content]:[row.id,actor.id,content,body.internal?1:0]);
            await audit(db,actor,escalation?'ESCALATION_MESSAGE':'SUPPORT_MESSAGE',escalation?'escalation':'support_case',row.id,{messageId:result.insertId,internal:!!body.internal});return{success:true};
        });
    }
    return{list,detail,create,update,message};
}
module.exports={createCases,categories,escalationCategories};
