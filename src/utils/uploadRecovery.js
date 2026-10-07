const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../private-uploads/reconciliation');
// A private recovery receipt survives request failure, but local disk is not a
// durable queue. Never automatically retry or delete media after an ambiguous write.
async function startReceipt(scholarId,subjectId){
 const id=crypto.randomUUID(),file=path.join(root,id+'.json');
 const record={id,scholarId,subjectId,createdAt:new Date().toISOString(),state:'provider_pending'};
 await fs.promises.mkdir(root,{recursive:true});
 await fs.promises.writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});
 return {id,async completed(uri){record.state='persistence_pending';record.providerURI=uri;await fs.promises.writeFile(file,JSON.stringify(record),{mode:0o600});},async recorded(){await fs.promises.unlink(file);}};
}
module.exports={startReceipt};
