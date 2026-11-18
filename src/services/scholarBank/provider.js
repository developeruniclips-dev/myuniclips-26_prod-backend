'use strict';
const {fail,accountInput}=require('./security');
// Deliberately contains no transfer, split, subaccount or payout API.
function createProvider({secret,merchant,mode,fetchImpl=fetch}){
 if(!['test','live'].includes(mode)||!new RegExp('^sk_'+mode+'_[A-Za-z0-9]{16,128}$').test(secret||'')||!/^\d{1,20}$/.test(merchant||''))throw Error('Bank provider configuration unavailable');
 async function request(path,method='GET',body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetchImpl('https://api.paystack.co'+path,{method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:controller.signal,redirect:'error'});
   const reader=response.body?.getReader();let raw='';
   if(reader){let size=0;const decoder=new TextDecoder();try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();throw Error('Provider body too large');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();}finally{reader.releaseLock();}}
   else raw=await response.text();
   if(raw.length>262144)throw Error('Provider body too large');
   const result=JSON.parse(raw);if(!response.ok||result.status!==true)throw Error('Provider refused request');return result;
  }catch{fail(502,'BANK_PROVIDER_UNAVAILABLE',method==='POST'?'Recipient registration needs review. Do not submit again.':'Bank verification is unavailable. Please try later.');}finally{clearTimeout(timer);}
 }
 function checkRecipient(data,expected){
  if(!data||typeof data.recipient_code!=='string'||!/^RCP_[A-Za-z0-9]{5,90}$/.test(data.recipient_code)||data.type!=='nuban'||data.currency!=='NGN'||data.domain!==mode||String(data.integration)!==merchant||data.active!==true||String(data.details?.bank_code)!==expected.bankCode||String(data.details?.account_number)!==expected.accountNumber)fail(502,'BANK_RECIPIENT_MISMATCH','The payout destination needs security review');
  if(data.details.account_name&&data.details.account_name.trim().toUpperCase()!==expected.accountName.trim().toUpperCase())fail(502,'BANK_RECIPIENT_MISMATCH','The payout destination needs security review');
  return data.recipient_code;
 }
 return {
  async banks(){let next=null;const all=[];for(let page=0;page<10;page++){
   const params=new URLSearchParams({country:'nigeria',currency:'NGN',type:'nuban',perPage:'100',use_cursor:'true'});if(next)params.set('next',next);
   const r=await request('/bank?'+params);if(!Array.isArray(r.data))fail(502,'BANK_PROVIDER_UNAVAILABLE','Bank list unavailable');
   for(const b of r.data)if(b.active!==false&&b.is_deleted!==true&&/^\d{3,16}$/.test(b.code)&&typeof b.name==='string'&&b.name.length<=120)all.push({code:b.code,name:b.name});
   next=r.meta?.next;if(!next)return [...new Map(all.map(b=>[b.code,b])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  }fail(502,'BANK_PROVIDER_UNAVAILABLE','Bank list pagination could not be completed');},
  async resolve(bankCode,accountNumber){accountInput(bankCode,accountNumber);const r=await request('/bank/resolve?'+new URLSearchParams({bank_code:bankCode,account_number:accountNumber}));if(r.data?.account_number!==accountNumber||typeof r.data?.account_name!=='string'||r.data.account_name.length<2||r.data.account_name.length>120||/[\x00-\x1f\x7f]/.test(r.data.account_name))fail(502,'BANK_RESOLUTION_FAILED','The bank could not confirm this account');return {accountNumber,accountName:r.data.account_name.trim()};},
  async create(input){const r=await request('/transferrecipient','POST',{type:'nuban',name:input.accountName,account_number:input.accountNumber,bank_code:input.bankCode,currency:'NGN',metadata:{uniclips_bank_operation:input.operationId}});return checkRecipient(r.data,input);},
  async inspect(code){if(!/^RCP_[A-Za-z0-9]{5,90}$/.test(code||''))fail(400,'BANK_INPUT_INVALID','Invalid recipient reference');return (await request('/transferrecipient/'+encodeURIComponent(code))).data;},
  checkRecipient
 };
}
module.exports={createProvider};
