'use strict';
function createRuntime({pool,env=process.env,fetchImpl,mailer}={}){
 if(env.PAYSTACK_NG_BANK_DETAILS!=='enabled')return null;
 const {protection}=require('./security');
 const protect=protection({encryptionKey:env.PAYSTACK_NG_BANK_ENCRYPTION_KEY,fingerprintKey:env.PAYSTACK_NG_BANK_FINGERPRINT_KEY,keyId:env.PAYSTACK_NG_BANK_KEY_ID});
 const provider=require('./provider').createProvider({secret:env.PAYSTACK_NG_BANK_API_SECRET,merchant:env.PAYSTACK_NG_BANK_MERCHANT,mode:env.PAYSTACK_NG_BANK_MODE,fetchImpl});
 return require('./service').createService({pool,provider,protection:protect,sendMail:require('./mail').createMailer({env,mailer}),merchant:env.PAYSTACK_NG_BANK_MERCHANT,environment:env.PAYSTACK_NG_BANK_MODE});
}
module.exports={createRuntime};
