'use strict';
exports.paystackWebhook=async(req,res)=>{
 try{const runtime=require('../services/paystackNigeria/runtime').paymentRuntime();if(!runtime.enabled)return res.status(503).json({code:'PAYSTACK_DISABLED'});await runtime.webhook(req.body,req.headers);return res.sendStatus(200);}
 catch(e){return res.status([400,401].includes(e.status)?e.status:503).json({code:[400,401].includes(e.status)?e.code:'PAYSTACK_WEBHOOK_UNAVAILABLE'});}
};
