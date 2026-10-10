// Every READY decision includes fresh provider policy verification; no cached READY grant.
const {createVimeoPrivacy,sharedVimeoPrivacy,providerId,classify}=require('./vimeoPrivacy');
function createVideoReadiness(client,options={}){
 const {now=Date.now,maxReads=60}=options,policy=createVimeoPrivacy(client,options);
 const cache=new Map(),pending=new Map();let windowStart=now(),reads=0;
 async function read(reference,{fresh=false}={}){
  let id;try{id=providerId(reference);}catch{return {state:'UNKNOWN',policyVerified:false};}
  const time=now(),entry=cache.get(id);
  if(!fresh&&entry&&entry.expires>time)return {...entry.result};
  if(pending.has(id))return pending.get(id);
  if(time-windowStart>=60000){windowStart=time;reads=0;}
  if(reads>=maxReads)return {state:'UNKNOWN',policyVerified:false};reads++;
  const work=policy.verify(reference).then(result=>{
   // Processing/unknown caches can only deny; a previously READY asset is always rechecked.
   if(result.state!=='READY'){if(cache.size>=200)cache.delete(cache.keys().next().value);cache.set(id,{result,expires:now()+30000});}
   else cache.delete(id);
   return result;
  }).finally(()=>pending.delete(id));
  pending.set(id,work);return work;
 }
 return {read};
}
const shared=new WeakMap();
function sharedVideoReadiness(client){if(!shared.has(client))shared.set(client,createVideoReadiness(client));return shared.get(client);}
module.exports={createVideoReadiness,sharedVideoReadiness,classify,providerId};
