const {fail,id,page,optional}=require('./common');
const roleSql="(SELECT GROUP_CONCAT(r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id)";
async function paginate(db,select,from,args,query,order='id DESC') {
    const paging=page(query);const [[count]]=await db.query(`SELECT COUNT(*) AS total ${from}`,args);
    const [rows]=await db.query(`SELECT ${select} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,[...args,paging.limit,paging.offset]);
    return{rows,total:Number(count.total),...paging};
}
function createData(pool) {
    async function overview() {
        const [[counts]]=await pool.query(`SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.name='Learner') AS learners,
            (SELECT COUNT(*) FROM scholar_profile WHERE approved=1) AS scholars,
            (SELECT COUNT(*) FROM scholar_profile WHERE approved=0) AS scholarApplications,
            (SELECT COUNT(*) FROM scholar_subjects WHERE approved=0) AS courseApplications,
            (SELECT COUNT(*) FROM videos WHERE approved=0) AS videoReviews,
            (SELECT COUNT(*) FROM videos WHERE approved=1) AS publishedVideos,
            (SELECT COUNT(DISTINCT subject_id,scholar_user_id) FROM videos WHERE approved=1) AS publishedCourses,
            (SELECT COUNT(*) FROM universities) AS academicUniversities,
            (SELECT COUNT(*) FROM subject_purchases) AS coursePurchases,
            (SELECT COUNT(*) FROM users WHERE university_id IS NULL) AS unassignedUsers`);
        const support=await optional(pool,"SELECT COUNT(*) AS count FROM support_cases WHERE status!='RESOLVED'");
        const escalations=await optional(pool,"SELECT COUNT(*) AS count FROM admin_escalations WHERE status!='RESOLVED'");
        const [revenue]=await pool.query(`SELECT UPPER(currency) AS currency,SUM(amount) AS amount
            FROM subject_purchases GROUP BY UPPER(currency)`);
        return {...counts,openSupport:support?Number(support[0].count):null,openEscalations:escalations?Number(escalations[0].count):null,revenue,
            operationsAvailable:!!support&&!!escalations,
            operationsMessage:!support||!escalations?'Support and escalations will become available after the operations migration.':null,
            revenueBasis:'Recorded course purchases only; historical video records are excluded. Not a reconciled provider balance.'};
    }
    async function people(query) {
        const where=['1=1'],args=[];
        if(query.q){where.push("(CONCAT(u.fname,' ',u.lname) LIKE ? OR u.email LIKE ?)");args.push(...Array(2).fill(`%${String(query.q).slice(0,120)}%`));}
        if(query.role){where.push('EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.name=?)');args.push(query.role);}
        if(query.university==='unassigned')where.push('u.university_id IS NULL');else if(query.university){where.push('u.university_id=?');args.push(id(query.university));}
        if(query.programme){where.push('u.degree_programme=?');args.push(String(query.programme).slice(0,255));}
        return paginate(pool,`u.id,u.fname,u.lname,u.email,u.created_at,u.degree_programme,uni.name AS university,${roleSql} AS roles`,
            `FROM users u LEFT JOIN universities uni ON uni.id=u.university_id WHERE ${where.join(' AND ')}`,args,query,'u.id DESC');
    }
    async function person(userId,section,query={}) {
        const target=id(userId);const [[person]]=await pool.query(`SELECT u.id,u.fname,u.lname,u.email,u.created_at,u.avatar_id,u.degree_programme,u.university_id,
            uni.name AS university,${roleSql} AS roles FROM users u LEFT JOIN universities uni ON uni.id=u.university_id WHERE u.id=?`,[target]);
        if(!person)fail(404,'Person not found');
        if(section==='learning') return paginate(pool,`sp.id,s.name AS course,sp.subject_id,sp.scholar_id,sp.created_at,sp.access_expires_at,
            sp.is_access_active AND (sp.access_expires_at IS NULL OR sp.access_expires_at>NOW()) AS active,
            (SELECT COUNT(*) FROM videos v WHERE v.subject_id=sp.subject_id AND v.scholar_user_id=sp.scholar_id AND v.approved=1) AS lessons,
            (SELECT COUNT(*) FROM video_progress vp JOIN videos v ON v.id=vp.video_id WHERE vp.user_id=sp.buyer_user_id AND vp.watched=1
                AND v.subject_id=sp.subject_id AND v.scholar_user_id=sp.scholar_id AND v.approved=1) AS watched`,
            'FROM subject_purchases sp LEFT JOIN subjects s ON s.id=sp.subject_id WHERE sp.buyer_user_id=?',[target],query,'sp.id DESC');
        if(section==='purchases')return transactions({...query,userId:target});
        if(section==='scholar'){
            const [application]=await pool.query('SELECT id,user_id,university,degree,year,approved,created_at,task_card_url FROM scholar_profile WHERE user_id=?',[target]);
            const courses=await paginate(pool,'ss.id,ss.subject_id,s.name AS course,ss.degree,ss.expertise,ss.approved,ss.created_at',
                'FROM scholar_subjects ss LEFT JOIN subjects s ON s.id=ss.subject_id WHERE ss.scholar_user_id=?',[target],query,'ss.id DESC');
            const [content]=await pool.query('SELECT approved,COUNT(*) AS count FROM videos WHERE scholar_user_id=? GROUP BY approved',[target]);
            return{application:application[0]||null,courses,content};
        }
        const [[scholar]]=await pool.query('SELECT approved,university,degree,created_at FROM scholar_profile WHERE user_id=?',[target]);
        return{...person,scholar:scholar||null,accountStatus:'Registered account',suspensionAvailable:false};
    }
    const queueDefinitions={
        scholars:{table:'scholar_profile q',user:'q.user_id',fields:'q.id,q.user_id,q.university,q.degree,q.year,q.task_card_url,q.approved,q.created_at'},
        courses:{table:'scholar_subjects q LEFT JOIN subjects s ON s.id=q.subject_id LEFT JOIN universities uni ON uni.id=s.university_id',user:'q.scholar_user_id',fields:'q.id,q.scholar_user_id AS user_id,q.subject_id,s.name AS title,uni.name AS university,q.degree,q.expertise,q.approved,q.created_at'},
        videos:{table:'videos q LEFT JOIN subjects s ON s.id=q.subject_id LEFT JOIN universities uni ON uni.id=s.university_id',user:'q.scholar_user_id',fields:'q.id,q.scholar_user_id AS user_id,q.subject_id,s.name AS course,uni.name AS university,s.degree_programmes AS degree,q.title,q.description,q.video_url,q.sequence_index,q.price,q.is_free,q.approved,q.created_at'}
    };
    async function queue(kind,query) {
        const d=queueDefinitions[kind];if(!d)fail(404,'Queue not found');const args=[],where=['1=1'];
        if(query.status!=='all'){where.push('q.approved=?');args.push(query.status==='approved'?1:0);}
        if(query.q){where.push("(CONCAT(u.fname,' ',u.lname) LIKE ? OR u.email LIKE ?)");args.push(...Array(2).fill(`%${String(query.q).slice(0,120)}%`));}
        if(query.userId){where.push(`${d.user}=?`);args.push(id(query.userId));}
        const videoCounts=kind==='videos'?`,
            (SELECT COUNT(*) FROM videos v WHERE v.subject_id=q.subject_id AND v.scholar_user_id=q.scholar_user_id) AS course_video_count,
            (SELECT COUNT(*) FROM videos v WHERE v.subject_id=q.subject_id AND v.scholar_user_id=q.scholar_user_id AND v.approved=0) AS pending_video_count,
            (SELECT ss.id FROM scholar_subjects ss JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id WHERE ss.subject_id=q.subject_id AND ss.scholar_user_id=q.scholar_user_id AND ss.approved=1 AND sp.approved=1 LIMIT 1) AS offering_id`:'';
        return paginate(pool,`${d.fields},u.fname,u.lname,u.email${videoCounts}`, `FROM ${d.table} JOIN users u ON u.id=${d.user} WHERE ${where.join(' AND ')}`,args,query,'q.id DESC');
    }
    async function transactions(query) {
        const ready=await optional(pool,'SELECT id FROM payment_orders LIMIT 0');
        const legacy=`SELECT CONVERT(CONCAT('bundle-',sp.id) USING utf8mb4) COLLATE utf8mb4_unicode_ci AS reference,sp.buyer_user_id AS user_id,sp.subject_id,sp.scholar_id,sp.amount,UPPER(CONVERT(sp.currency USING utf8mb4)) COLLATE utf8mb4_unicode_ci AS currency,
            _utf8mb4'legacy' COLLATE utf8mb4_unicode_ci AS provider,_utf8mb4'Recorded course purchase' COLLATE utf8mb4_unicode_ci AS status,sp.created_at,sp.access_expires_at,sp.is_access_active AND (sp.access_expires_at IS NULL OR sp.access_expires_at>NOW()) AS active
            FROM subject_purchases sp ${ready?'WHERE NOT EXISTS (SELECT 1 FROM payment_orders o WHERE o.purchase_id=sp.id)':''}
            UNION ALL SELECT CONCAT('video-',p.id),p.buyer_user_id,v.subject_id,v.scholar_user_id,p.amount,UPPER(p.currency),'legacy','Legacy / unreconciled video record',p.created_at,NULL,NULL FROM purchases p LEFT JOIN videos v ON v.id=p.video_id`;
        const modern=ready?` UNION ALL SELECT o.id,o.buyer_id,o.subject_id,o.scholar_id,o.amount_minor/100,o.currency,o.provider,o.state,o.created_at,sp.access_expires_at,
            sp.is_access_active AND (sp.access_expires_at IS NULL OR sp.access_expires_at>NOW()) FROM payment_orders o LEFT JOIN subject_purchases sp ON sp.id=o.purchase_id`:'';
        const where=['1=1'],args=[];
        if(query.userId){where.push('t.user_id=?');args.push(id(query.userId));}
        if(query.q){where.push("(t.reference LIKE ? OR u.email LIKE ? OR s.name LIKE ?)");args.push(...Array(3).fill(`%${String(query.q).slice(0,120)}%`));}
        if(query.currency){where.push('t.currency=?');args.push(query.currency);}
        const from=`FROM (${legacy}${modern}) t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN users scholar ON scholar.id=t.scholar_id LEFT JOIN subjects s ON s.id=t.subject_id WHERE ${where.join(' AND ')}`;
        return{...await paginate(pool,"t.*,CONCAT(u.fname,' ',u.lname) AS learner,u.email,s.name AS course,CONCAT(scholar.fname,' ',scholar.lname) AS scholar",from,args,query,'t.created_at DESC,t.reference DESC'),phase2aAvailable:!!ready,
            message:!ready?'Payment Phase 2A is not migrated. Legacy transactions remain available.':null};
    }
    async function universities() {
        const [rows]=await pool.query(`SELECT uni.id,uni.name,uni.short_name,c.name AS country,
            (SELECT COUNT(*) FROM users u WHERE u.university_id=uni.id) AS users,
            (SELECT COUNT(*) FROM scholar_profile p WHERE p.approved=1 AND (CONVERT(p.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=uni.name OR CONVERT(p.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONCAT(uni.name,' (',uni.short_name,')'))) AS scholars,
            (SELECT COUNT(*) FROM scholar_profile p WHERE p.approved=0 AND (CONVERT(p.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=uni.name OR CONVERT(p.university USING utf8mb4) COLLATE utf8mb4_unicode_ci=CONCAT(uni.name,' (',uni.short_name,')'))) +
            (SELECT COUNT(*) FROM scholar_subjects a JOIN subjects s ON s.id=a.subject_id WHERE s.university_id=uni.id AND a.approved=0) +
            (SELECT COUNT(*) FROM videos v JOIN subjects s ON s.id=v.subject_id WHERE s.university_id=uni.id AND v.approved=0) AS pendingItems,
            (SELECT COUNT(*) FROM subjects s WHERE s.university_id=uni.id) AS courseEntries,
            (SELECT COUNT(DISTINCT s.degree_programmes) FROM subjects s WHERE s.university_id=uni.id) AS programmes
            FROM universities uni JOIN countries c ON c.id=uni.country_id ORDER BY c.name,uni.name`);
        const support=await optional(pool,`SELECT u.university_id,COUNT(*) AS count FROM support_cases c JOIN users u ON u.id=c.user_id WHERE c.status!='RESOLVED' GROUP BY u.university_id`);
        for(const row of rows)row.openSupport=support?Number(support.find(s=>Number(s.university_id)===Number(row.id))?.count||0):null;
        return rows;
    }
    async function catalogue(query) {
        const where=['1=1'],args=[];
        if(query.university){where.push('s.university_id=?');args.push(id(query.university));}
        if(query.programme){where.push('s.degree_programmes=?');args.push(query.programme);}
        if(query.q){where.push('s.name LIKE ?');args.push(`%${String(query.q).slice(0,120)}%`);}
        const result=await paginate(pool,'s.id,s.id AS subject_id,s.name,s.degree_programmes,s.university_id,s.bundle_price,uni.name AS university,c.code AS country_code',
            `FROM subjects s JOIN universities uni ON uni.id=s.university_id JOIN countries c ON c.id=uni.country_id WHERE ${where.join(' AND ')}`,args,query,'s.id ASC');
        result.rows=await require('../../utils/generalCourses').annotateCourses(pool,result.rows);return result;
    }
    async function auditLog(actor,query) {
        const args=[],where=[];
        if(!actor.roles.includes('SuperAdmin')){where.push('a.user_id=?');args.push(actor.id);}
        if(query.q){where.push('(a.action LIKE ? OR a.target_type LIKE ?)');args.push(...Array(2).fill(`%${String(query.q).slice(0,100)}%`));}
        return paginate(pool,"a.id,a.user_id,a.action,a.target_type,a.target_id,a.details,a.created_at,CONCAT(u.fname,' ',u.lname) AS actor",
            `FROM admin_activity_log a LEFT JOIN users u ON u.id=a.user_id${where.length?' WHERE '+where.join(' AND '):''}`,args,query,'a.id DESC');
    }
    async function finance(query) {
        if(query.view==='legacy')return paginate(pool,"p.id,p.amount,p.currency,p.status,p.created_at,p.stripe_transfer_id,CONCAT(u.fname,' ',u.lname) AS scholar",'FROM scholar_payouts p LEFT JOIN users u ON u.id=p.scholar_user_id',[],query,'p.id DESC');
        const ready=(await optional(pool,'SELECT id FROM payment_orders LIMIT 0')) &&
            (await optional(pool,'SELECT order_id FROM payment_allocations LIMIT 0')) &&
            (await optional(pool,'SELECT order_id FROM payment_transfers LIMIT 0'));
        if(!ready)return{available:false,rows:[],total:0,message:'Payment Phase 2A is not migrated. Legacy transactions remain available; new allocations cannot be released here.'};
        if(query.view==='review')return {available:true,...await paginate(pool,'o.id,o.state,o.currency,o.amount_minor,o.refund_state,o.dispute_state,o.created_at,t.state AS transfer_state,t.error_code',
            "FROM payment_orders o LEFT JOIN payment_transfers t ON t.order_id=o.id WHERE o.state='review_required' OR o.refund_state!='none' OR o.dispute_state!='none' OR t.state IN ('failed','uncertain')",[],query,'o.created_at DESC')};
        return{available:true,...await paginate(pool,`a.order_id AS id,a.scholar_id,a.currency,a.gross_minor,a.scholar_minor,a.platform_minor,a.sale_ordinal,a.scholar_rate,
            t.state AS transfer_state,t.transfer_id,o.refund_state,o.dispute_state,s.name AS course,CONCAT(u.fname,' ',u.lname) AS scholar`,
            'FROM payment_allocations a JOIN payment_orders o ON o.id=a.order_id JOIN payment_transfers t ON t.order_id=a.order_id LEFT JOIN subjects s ON s.id=a.subject_id LEFT JOIN users u ON u.id=a.scholar_id',[],query,'a.created_at DESC')};
    }
    return{overview,people,person,queue,transactions,universities,catalogue,auditLog,finance};
}
module.exports={createData,paginate};
