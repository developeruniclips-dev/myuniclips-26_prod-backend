// Per-video policy only. Never changes account defaults, retries upload creation, or deletes assets.
const {playerMetadata}=require('./contentAuthorization');
const DOMAINS=Object.freeze(['myuniclips.com','taupe-empanada-b7dfa9.netlify.app']);
const INITIAL_PRIVACY=Object.freeze({view:'nobody',embed:'private',download:false});
const FINAL_PRIVACY=Object.freeze({view:'disable',embed:'whitelist',download:false});
const FIELDS='uri,user.uri,privacy.view,privacy.embed,privacy.download,upload.status,transcode.status';
function providerId(reference){return new URL(playerMetadata(reference).player_url).pathname.split('/').pop();}
function classify(body){
 const upload=body?.upload?.status,transcode=body?.transcode?.status;
 if(['error','canceled'].includes(upload)||transcode==='error')return 'FAILED';
 if(upload==='complete'&&transcode==='complete')return 'READY';
 if(upload==='in_progress'||transcode==='in_progress')return 'PROCESSING';
 return 'UNKNOWN';
}
function exactDomains(domains){return Array.isArray(domains)&&domains.length===DOMAINS.length&&new Set(domains).size===DOMAINS.length&&DOMAINS.every(d=>domains.includes(d));}
const error=code=>Object.assign(new Error('Video security verification unavailable'),{code});
function createVimeoPrivacy(client,{timeoutMs=8000,now=Date.now,maxRequests=240}={}){
 let windowStart=now(),requests=0;
 async function request(method,path,query){
  if(now()-windowStart>=60000){windowStart=now();requests=0;}
  if(requests>=maxRequests)throw error('PROVIDER_BUDGET');requests++;
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(err,body,status)=>{if(done)return;done=true;clearTimeout(timer);
    if(err||!Number.isInteger(status)||status<200||status>=300)return reject(error(status===401||status===403?'PROVIDER_PERMISSION':status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_UNAVAILABLE'));
    resolve(body);};
   const timer=setTimeout(()=>{if(done)return;done=true;reject(error('PROVIDER_TIMEOUT'));},timeoutMs);
   try{client.request({method,path,...(query?{query}:{})},finish);}catch{finish(true);}
  });
 }
 async function account(){const body=await request('GET','/me?fields=uri');if(!/^\/users\/[1-9]\d*$/.test(body?.uri||''))throw error('PROVIDER_OWNER_UNKNOWN');return body.uri;}
 async function asset(uri,owner){
  const body=await request('GET',uri+'?fields='+FIELDS);
  if(body?.uri!==uri||body?.user?.uri!==owner)throw error('PROVIDER_OWNER_MISMATCH');return body;
 }
 async function domains(uri){
  const body=await request('GET',uri+'/privacy/domains?per_page=100&fields=domain,paging.next');
  if(!Array.isArray(body?.data)||body.paging?.next||body.data.length>50)throw error('PROVIDER_DOMAINS_UNKNOWN');
  const list=body.data.map(x=>x.domain);
  if(list.some(d=>typeof d!=='string'||!DOMAINS.includes(d))||new Set(list).size!==list.length)throw error('PROVIDER_DOMAIN_MISMATCH');
  return list;
 }
 const hasPolicy=(body,policy)=>body?.privacy?.view===policy.view&&body?.privacy?.embed===policy.embed&&body?.privacy?.download===policy.download;
 async function inspect(reference){
  const uri='/videos/'+providerId(reference),owner=await account(),body=await asset(uri,owner),list=await domains(uri);
  if(!hasPolicy(body,FINAL_PRIVACY)||!exactDomains(list))throw error('PROVIDER_POLICY_MISMATCH');
  // A validated stored player reference is mandatory; never request broad file/play fields.
  playerMetadata(reference);return {state:classify(body),policyVerified:true};
 }
 async function verify(reference){
  try{return await inspect(reference);}catch(e){return {state:'UNKNOWN',policyVerified:false,code:e.code||'PROVIDER_REFERENCE_INVALID'};}
 }
 async function writeAndRead(method,path,query,check){
  try{await request(method,path,query);}
  catch(e){
   // No write retry. Only uncertain outcomes get a bounded authoritative readback.
   if(!['PROVIDER_TIMEOUT','PROVIDER_UNAVAILABLE'].includes(e.code))throw e;
   if(await check())return;throw e;
  }
  if(!await check())throw error('PROVIDER_WRITE_UNCONFIRMED');
 }
 async function configureNew(reference){
  const uri='/videos/'+providerId(reference),owner=await account();
  if(!hasPolicy(await asset(uri,owner),INITIAL_PRIVACY))throw error('PROVIDER_INITIAL_POLICY_MISMATCH');
  // Reject inherited extras while still private; never remove domains from an existing asset.
  const initial=await domains(uri);
  for(const domain of DOMAINS)if(!initial.includes(domain)){
   await writeAndRead('PUT',uri+'/privacy/domains/'+encodeURIComponent(domain),null,async()=> (await domains(uri)).includes(domain));
  }
  if(!exactDomains(await domains(uri)))throw error('PROVIDER_DOMAIN_MISMATCH');
  await writeAndRead('PATCH',uri,{privacy:{...FINAL_PRIVACY}},async()=>{
   const body=await asset(uri,owner);return hasPolicy(body,FINAL_PRIVACY)&&exactDomains(await domains(uri));
  });
  return inspect(reference); // Fresh ownership, policy, domains and processing readback.
 }
 return {verify,configureNew};
}
const shared=new WeakMap();
function sharedVimeoPrivacy(client){if(!shared.has(client))shared.set(client,createVimeoPrivacy(client));return shared.get(client);}
module.exports={DOMAINS,INITIAL_PRIVACY,FINAL_PRIVACY,FIELDS,providerId,classify,exactDomains,createVimeoPrivacy,sharedVimeoPrivacy};
