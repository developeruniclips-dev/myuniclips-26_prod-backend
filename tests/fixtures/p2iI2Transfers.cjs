'use strict';
const crypto=require('crypto');
function context(mode){
 const legacy=mode==='legacy',id=crypto.randomUUID(),secret=crypto.randomBytes(32).toString('hex'),TYPE=require('../../src/services/paymentRelease/stripeProvider').TYPE;
 const snapshot={version:1,nonce:id,buyerId:1,subjectId:10,scholarId:7,universityId:1,amountMinor:600,currency:'EUR',account:'acct_platform',livemode:false,destination:'acct_scholar'};
 const signature=crypto.createHmac('sha256',secret).update('uniclips:legacy_verified:v1\0').update(JSON.stringify(snapshot)).digest('hex');
 const metadata=legacy?{type:TYPE,snapshot:JSON.stringify(snapshot),signature}:{type:'uniclips_order_v1',orderId:id,buyerId:'1',subjectId:'10',scholarId:'7'};
 const identity={account:'acct_platform',livemode:false},session={id:'cs_fixture',client_reference_id:id,metadata,livemode:false,mode:'payment',amount_total:600,currency:'eur',payment_status:'paid'},payment={id:'pi_fixture',status:'succeeded',amount_received:600,currency:'eur',livemode:false,metadata},charge={id:'ch_fixture',paid:true,amount:600,currency:'eur',payment_intent:'pi_fixture',livemode:false,created:Math.floor(Date.now()/1000),amount_refunded:0,disputed:false};
 const instruction={id:1,kind:TYPE,purchaseId:1,paymentId:'pi_fixture',grossMinor:600,amountMinor:420,destination:'acct_scholar',sessionId:'cs_fixture',account:identity.account,livemode:false,chargeId:'ch_fixture',group:'lv_'+id};
 const order={id,buyer_id:1,subject_id:10,scholar_id:7,state:'fulfilled',amount_minor:600,currency:'EUR',provider_account:identity.account,livemode:0,session_id:'cs_fixture',payment_id:'pi_fixture',charge_id:'ch_fixture',refund_state:'none',dispute_state:'none'};
 const phaseInstruction={order_id:id,state:'uncertain',amount_minor:420,currency:'EUR',destination_account:'acct_scholar',attempted_at:new Date(),idempotency_key:'fixture_only'};
 const transfer={id:'tr_fixture',amount:420,currency:'eur',destination:'acct_scholar',source_transaction:'ch_fixture',transfer_group:legacy?instruction.group:'order_'+id,reversed:false,metadata:legacy?{release:TYPE,purchaseId:'1',instructionId:'1'}:{orderId:id}};
 return{mode,id,secret,TYPE,snapshot,instruction,order,phaseInstruction,transfer,evidence:{session,identity,payment,charge},orderId:legacy?'legacy_1':id};
}
function provider(f,list){
 let creates=0,calls=0;const stripe={transfers:{list(...args){calls++;return list(...args);},create(){creates++;throw Error('Unexpected write');}}};
 const adapter=f.mode==='legacy'?require('../../src/services/paymentRelease/stripeProvider').createReleaseStripeProvider(stripe,'https://example.invalid'):require('../../src/services/payments/stripeProvider').createStripeProvider(stripe,'https://example.invalid');
 return{provider:{...adapter,identity:async()=>f.evidence.identity,evidence:async()=>f.evidence,retrieveAccount:async()=>({country:'FI',capabilities:{transfers:'active'},payouts_enabled:true})},creates:()=>creates,calls:()=>calls};
}
function memoryPool(f){
 const state={completed:0,released:0,unlocked:0};const query=async(sql)=>{
  if(sql.includes('GET_LOCK'))return[[{acquired:1}]];
  if(sql.includes('RELEASE_LOCK')){state.unlocked++;return[[{released:1}]];}
  if(sql.startsWith('SELECT id FROM scholar_payouts'))return[[{id:1}]];
  if(sql.startsWith('SELECT * FROM scholar_payouts'))return[[{id:1,scholar_user_id:7,status:'uncertain',amount:'4.20',description:JSON.stringify(f.instruction)}]];
  if(sql.includes('FROM subject_purchases'))return[[{id:1,scholar_id:7,buyer_user_id:1,subject_id:10,transaction_id:'pi_fixture',currency:'EUR',amount:'6.00'}]];
  if(sql.includes('FROM payment_orders'))return[[f.order]];
  if(sql.includes('FROM payment_transfers'))return[[f.phaseInstruction]];
  if(sql.includes('FROM scholar_profile'))return[[{approved:1,stripe_account_id:'acct_scholar'}]];
  if(sql.startsWith('UPDATE')){assertCompleted(sql);state.completed++;return[{affectedRows:1}];}
  throw Error('Unexpected fixture query '+sql);
 };
 function assertCompleted(sql){if(!sql.includes("='completed'"))throw Error('Unexpected financial state write');}
 return{state,pool:{query,getConnection:async()=>({query,release(){state.released++;}})}};
}
function service(f,pool,provider){return f.mode==='legacy'?require('../../src/services/paymentRelease/service').createReleaseService({pool,provider,signingSecret:f.secret}).transferOrder:require('../../src/services/payments/transferService').createTransferService({pool,provider});}
module.exports={context,provider,memoryPool,service};
