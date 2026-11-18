'use strict';
const {mailbox,transportOptions}=require('../../utils/emailService');
function createMailer({env=process.env,mailer=require('nodemailer')}={}){
 return async item=>{
  if(item.kind!=='registered'||!/^[a-f0-9-]{36}$/.test(item.id))throw Error('Invalid bank notification');
  const frontend=new URL(env.FRONTEND_URL||'https://myuniclips.com');
  if(frontend.protocol!=='https:'||frontend.username||frontend.password||frontend.pathname!=='/'||frontend.search||frontend.hash)throw Error('Bank notification configuration unavailable');
  const to=await mailbox(item.email),from=await mailbox(env.EMAIL_USER);let transport;
  try{
   transport=mailer.createTransport({...transportOptions(env),requireTLS:true});
   await transport.sendMail({from:{name:'UniClips',address:from},to:{address:to},envelope:{from,to:[to]},
    subject:'UniClips payout bank account registered',
    text:'Your UniClips payout bank account has been registered.\n\nEarnings remain held. Registration does not initiate a payout, establish full KYC or prove legal account ownership.\n\nIf you did not register this account, contact UniClips support immediately.\n\n'+frontend.origin+'/support',
    messageId:'<bank-'+item.id+'@myuniclips.com>',disableFileAccess:true,disableUrlAccess:true});
  }finally{try{transport?.close?.();}catch{}}
 };
}
module.exports={createMailer};
