'use strict';
function unavailable(){return Object.assign(new Error('Read service is busy. Please try again later.'),{status:503,code:'READ_CAPACITY_UNAVAILABLE'});}
function createReadBudget({global=8,perUser=2}={}){
 let active=0;const users=new Map();
 return {async run(user,work){
  const key=Number.isSafeInteger(Number(user))&&Number(user)>0?String(user):null;
  if(active>=global||(key&&(users.get(key)||0)>=perUser))throw unavailable();
  active++;if(key)users.set(key,(users.get(key)||0)+1);
  try{return await work();}finally{active--;if(key){const n=users.get(key)-1;if(n)users.set(key,n);else users.delete(key);}}
 },status:()=>({active,trackedUsers:users.size})};
}
const catalogueReads=createReadBudget(),libraryReads=createReadBudget({global:4,perUser:2});
async function mapBounded(items,limit,work){
 const results=new Array(items.length);let cursor=0,failed=false;
 const settled=await Promise.allSettled(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!failed&&cursor<items.length){const index=cursor++;try{results[index]=await work(items[index],index);}catch(error){failed=true;throw error;}}
 }));
 const failure=settled.find(r=>r.status==='rejected');if(failure)throw failure.reason;return results;
}
function pageInput(query={},max=100,defaultLimit=max){
 const integer=(value,fallback)=>{if(value===undefined)return fallback;if(typeof value!=='string'||!/^[1-9]\d{0,9}$/.test(value))throw Object.assign(new Error('Invalid pagination'),{status:400});const n=Number(value);if(!Number.isSafeInteger(n)||n>2147483647)throw Object.assign(new Error('Invalid pagination'),{status:400});return n;};
 const limit=integer(query.limit,defaultLimit),before=integer(query.before,2147483647);
 if(limit>max)throw Object.assign(new Error('Invalid pagination'),{status:400});
 return{limit,before};
}
function pageRows(rows,page,id='id'){
 const hasMore=rows.length>page.limit,items=rows.slice(0,page.limit);
 const last=items.at(-1),nextCursor=hasMore&&page.kind&&last?._page_time?Buffer.from(JSON.stringify({v:1,k:page.kind,t:last._page_time,i:Number(last[id]),...(page.kind==='review'?{a:last.approved===null?-1:Number(last.approved)}:{})})).toString('base64url'):null;
 const visible=items.map(row=>{const {_page_time,...item}=row;return item;});
 return{items:visible,pagination:{limit:page.limit,hasMore,nextBefore:hasMore?Number(last[id]):null,...(page.kind?{nextCursor}: {})}};
}
async function readQuery(db,sql,args=[]){
 let connection,failed=false;
 try{connection=typeof db.getConnection==='function'?await db.getConnection():db;return await connection.query({sql,timeout:10000},args);}
 catch(error){failed=true;if(connection!==db)connection?.destroy?.();if(error.message==='Queue limit reached.'||error.code==='PROTOCOL_SEQUENCE_TIMEOUT')throw unavailable();throw error;}
 finally{if(connection&&connection!==db&&!failed)connection.release();}
}
async function readBounded(db,sql,args=[],maxRows=10000){
 return catalogueReads.run(null,async()=>{
  const result=await readQuery(db,sql.replace(/;\s*$/,"")+" LIMIT "+(maxRows+1),args);
  if(result[0].length>maxRows)throw Object.assign(new Error("List is temporarily unavailable"),{status:503,code:"READ_RESULTS_UNAVAILABLE"});
  return result;
 });
}
function requireExplicitPage(query,pagination){
 if(query?.limit===undefined&&pagination.hasMore)throw Object.assign(new Error("Please refresh the application to load the complete collection"),{status:409,code:"COLLECTION_UPDATE_REQUIRED"});
}
module.exports={orderedPageInput,orderedClause,requireExplicitPage,readBounded,createReadBudget,mapBounded,pageInput,pageRows,readQuery,catalogueReads,libraryReads};

const ORDERS={created:'created_at',review:'created_at',saved:'added_at'};
function orderedPageInput(query={},kind='created',max=100,defaultLimit=max){
 const page=pageInput(query,max,defaultLimit);if(!(kind in ORDERS))throw Error('Unknown collection order');
 page.kind=kind;
 if(query.cursor!==undefined){
  const bad=()=>Object.assign(new Error('Invalid pagination'),{status:400});
  if(query.before!==undefined||typeof query.cursor!=='string'||query.cursor.length>240||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw bad();
  let c;try{c=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));}catch{throw bad();}
  if(c?.v!==1||c.k!==kind||!Number.isSafeInteger(c.i)||c.i<=0||c.i>2147483647||typeof c.t!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(c.t)||!Number.isFinite(Date.parse(c.t.replace(' ','T')+'Z'))||(kind==='review'&&![-1,0,1].includes(c.a)))throw bad();
  page.cursor=c;
 }
 return page;
}
function orderedClause(page,alias='',id='id'){
 const p=alias?alias+'.':'',time="CAST(COALESCE("+p+ORDERS[page.kind]+", '1000-01-01 00:00:00') AS DATETIME(6))",approval='COALESCE('+p+'approved,-1)',c=page.cursor;
 let where=p+id+' < ?',args=[page.before];
 if(c){
  const later='('+time+' < ? OR ('+time+' = ? AND '+p+id+' < ?))';
  where=page.kind==='review'?'('+approval+' > ? OR ('+approval+' = ? AND '+later+'))':later;
  args=page.kind==='review'?[c.a,c.a,c.t,c.t,c.i]:[c.t,c.t,c.i];
 }
 return {where,args,select:"DATE_FORMAT("+time+", '%Y-%m-%d %H:%i:%s.%f') AS _page_time",order:(page.kind==='review'?approval+' ASC, ':'')+time+' DESC, '+p+id+' DESC'};
}
