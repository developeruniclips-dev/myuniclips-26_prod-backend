// Synthetic SDK adapter only. No environment, network, provider token or production assets.
const {DOMAINS}=require('../../src/services/vimeoPrivacy');
function syntheticVimeo({beforeRequest=()=>{},state=()=>({})}={}){
 const assets=new Map(),calls=[];
 const create=(id,privacy)=>{const row={uri:'/videos/'+id,user:{uri:'/users/999'},privacy:{...privacy},upload:{status:'complete'},transcode:{status:'complete'},domains:privacy.embed==='whitelist'?[...DOMAINS]:[]};assets.set(String(id),row);return row;};
 const asset=id=>assets.get(String(id))||create(id,{view:'disable',embed:'whitelist',download:false});
 return {calls,assets,asset,
 request(options,done){
  beforeRequest(options);calls.push(options);const flags=state();if(flags.failure)return done(Error('SYNTHETIC_PROVIDER_SECRET'),null,flags.failure);
  if(options.path.startsWith('/me?'))return done(null,{uri:'/users/999'},200);
  const match=options.path.match(/^\/videos\/(\d+)(.*)$/);if(!match)throw Error('Unexpected synthetic endpoint');
  const row=asset(match[1]),suffix=match[2];
  if(options.method==='PUT'){if(!suffix.startsWith('/privacy/domains/'))throw Error('Unexpected mutation');const domain=decodeURIComponent(suffix.split('/').pop());if(!row.domains.includes(domain))row.domains.push(domain);return done(null,null,204);}
  if(options.method==='PATCH'){Object.assign(row.privacy,options.query.privacy);return done(null,{},200);}
  if(options.method!=='GET')throw Error('Provider deletion/creation prohibited in metadata adapter');
  if(suffix.startsWith('/privacy/domains?'))return done(null,{data:row.domains.map(domain=>({domain})),paging:{next:null}},200);
  done(null,{...row,...(flags.processing?{transcode:{status:'in_progress'}}:{}),...(flags.public?{privacy:{view:'anybody',embed:'whitelist',download:false}}:{}),...(flags.wrongOwner?{user:{uri:'/users/1000'}}:{})},200);
 },
 uploaded(uri,options){const id=uri.split('/').pop();create(id,options.privacy);}
 };
}
module.exports={syntheticVimeo};
