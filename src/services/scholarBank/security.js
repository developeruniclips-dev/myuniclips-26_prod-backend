'use strict';
const crypto=require('node:crypto');
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const opaque=()=>crypto.randomBytes(32).toString('hex');
const uuid=()=>crypto.randomUUID();
function secret(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Bank protection key unavailable');return Buffer.from(value,'hex');}
function protection({encryptionKey,fingerprintKey,keyId}){
 const key=secret(encryptionKey),fp=secret(fingerprintKey);
 if(key.equals(fp)||!/^bank-v[1-9][0-9]{0,2}$/.test(keyId))throw Error('Independent bank protection keys required');
 return {
  encrypt(data,context){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(context));const encrypted=Buffer.concat([c.update(JSON.stringify(data),'utf8'),c.final()]);return JSON.stringify({v:keyId,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:encrypted.toString('base64')});},
  decrypt(value,context){const p=JSON.parse(value);if(p.v!==keyId)throw Error('Bank encryption version unavailable');const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(p.iv,'base64'));d.setAAD(Buffer.from(context));d.setAuthTag(Buffer.from(p.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(p.data,'base64')),d.final()]).toString('utf8'));},
  fingerprint(canonical){return crypto.createHmac('sha256',fp).update(JSON.stringify(['ng-nuban-v1',canonical])).digest('hex');}
 };
}
function accountInput(bank,account){if(typeof bank!=='string'||!/^\d{3,16}$/.test(bank)||typeof account!=='string'||!/^\d{10}$/.test(account))fail(400,'BANK_INPUT_INVALID','Choose a bank and enter a ten-digit Nigerian account number');}
function maskedName(name){return name.split(/\s+/).map(s=>s[0]+'*'.repeat(Math.min(8,Math.max(2,s.length-1)))).join(' ').slice(0,120);}
function bounded(value,max,required=false){if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||(required&&!value.trim()))fail(400,'BANK_INPUT_INVALID','Invalid text (maximum '+max+' characters)');return value.trim();}
module.exports={fail,hash,opaque,uuid,protection,bounded,accountInput,maskedName};
