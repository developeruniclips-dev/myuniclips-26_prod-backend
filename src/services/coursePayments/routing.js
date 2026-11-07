'use strict';
const {createHash}=require('node:crypto');
const {toMinor}=require('../payments/money');
const {readQuery}=require('../../utils/readCapacity');
const {RULE:ngPolicy}=require('../paystackNigeria/policy');
const validId=n=>['number','string'].includes(typeof n)&&/^[1-9]\d*$/.test(String(n))&&Number.isSafeInteger(Number(n));
const error=(code,status=409)=>Object.assign(new Error('Course payment is unavailable'),{code,status});
function stripeConfigured(env=process.env){return /^sk_(test|live)_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY||'')&&!/dummy|placeholder|your_/i.test(env.STRIPE_SECRET_KEY);}
function paymentDecision(row,{stripeReady=stripeConfigured()}={}){
 const country=row?.university_country_code;
 const payment={provider:null,currency:null,amountMinor:null,accessCalendarMonths:5,checkoutEnabled:false,unavailableCode:'INVALID_ACADEMIC_CONTEXT',policyVersion:'country-course-v1'};
 if(!row||![row.id??row.subject_id,row.university_id,row.country_id].every(validId)||!['FI','NG'].includes(country)||Number(row.country_occurrences)!==1)return payment;
 Object.assign(payment,country==='NG'?{provider:'paystack',currency:ngPolicy.currency,amountMinor:ngPolicy.totalMinor,policyVersion:ngPolicy.version}:{provider:'stripe',currency:'EUR',policyVersion:'fi-approved-eur-v1'});
 payment.entity=country==='NG'?ngPolicy.entity:'UNICLIPS_OY';
 if(country==='FI'){try{payment.amountMinor=toMinor(row.bundle_price,'EUR');if(payment.amountMinor<50)throw error('INVALID_PRICE');}catch{payment.unavailableCode='INVALID_PRICE';return payment;}}
 const eligible=Number(row.application_approved)===1&&Number(row.profile_approved)===1&&row.workflow_state==='PUBLISHED'&&Number(row.has_content)===1;
 payment.unavailableCode=!eligible?'OFFERING_UNAVAILABLE':country==='NG'?'PAYSTACK_CHECKOUT_DISABLED':!stripeReady?'STRIPE_UNAVAILABLE':null;
 payment.checkoutEnabled=payment.unavailableCode===null;
 payment.contextVersion=createHash('sha256').update(JSON.stringify([Number(row.id??row.subject_id),Number(row.scholar_id),Number(row.university_id),Number(row.country_id),country,payment.policyVersion,payment.amountMinor])).digest('hex');
 return payment;
}
const select=`SELECT s.id,s.university_id,s.bundle_price,c.id AS country_id,c.code AS university_country_code,
 (SELECT COUNT(*) FROM countries cc WHERE cc.code=c.code) AS country_occurrences,
 ss.scholar_user_id AS scholar_id,ss.approved AS application_approved,sp.approved AS profile_approved,cw.state AS workflow_state,
 EXISTS(SELECT 1 FROM videos v WHERE v.subject_id=s.id AND v.scholar_user_id=ss.scholar_user_id AND v.approved=1) AS has_content
 FROM subjects s LEFT JOIN universities u ON u.id=s.university_id LEFT JOIN countries c ON c.id=u.country_id
 LEFT JOIN scholar_subjects ss ON ss.subject_id=s.id LEFT JOIN scholar_profile sp ON sp.user_id=ss.scholar_user_id
 LEFT JOIN course_workflows cw ON cw.offering_id=ss.id`;
async function offering(db,subjectId,scholarId,options){
 if(!validId(subjectId)||!validId(scholarId))throw error('INVALID_OFFERING',400);
 const[rows]=await readQuery(db,select+' WHERE s.id=? AND ss.scholar_user_id=? LIMIT 2',[subjectId,scholarId]);
 if(rows.length!==1)throw error('OFFERING_UNAVAILABLE',404);
 const row=rows[0];return {subjectId:Number(row.id),scholarId:Number(row.scholar_id),universityId:Number(row.university_id)||null,universityCountryCode:row.university_country_code||null,payment:paymentDecision(row,options)};
}
async function attachPayments(db,rows,options){
 if(!rows.length)return rows;
 const ids=[...new Set(rows.map(r=>Number(r.subject_id??r.id)).filter(validId))];if(!ids.length)return rows;
 if(ids.length>10000)throw error('READ_RESULTS_UNAVAILABLE',503);
 const[contexts]=await readQuery(db,select+' WHERE s.id IN (?) LIMIT 10001',[ids]);if(contexts.length>10000)throw error('READ_RESULTS_UNAVAILABLE',503);
 const grouped=new Map();for(const r of contexts){const k=r.id+':'+r.scholar_id;grouped.set(k,[...(grouped.get(k)||[]),r]);}
 return rows.map(row=>{const matches=grouped.get((row.subject_id??row.id)+':'+(row.scholar_user_id??row.scholar_id))||[];const context=matches.length===1?matches[0]:null;return {...row,university_country_code:context?.university_country_code??null,payment:paymentDecision(context,options)};});
}
function checkoutInput(body={}){
 if(Object.keys(body).some(k=>!['subjectId','scholarId','idempotencyKey','contextVersion'].includes(k)))throw error('CLIENT_PAYMENT_OVERRIDE',400);
 if(!validId(body.subjectId)||!validId(body.scholarId))throw error('INVALID_OFFERING',400);
 return {subjectId:Number(body.subjectId),scholarId:Number(body.scholarId)};
}
async function requireStripeOffering(db,body,options){const ids=checkoutInput(body),result=await offering(db,ids.subjectId,ids.scholarId,options);
 if(body.contextVersion&&body.contextVersion!==result.payment.contextVersion)throw error('PAYMENT_CONTEXT_CHANGED');
 if(result.payment.provider!=='stripe'||!result.payment.checkoutEnabled)throw error(result.payment.unavailableCode||'STRIPE_ONLY_ENDPOINT');return result;
}
module.exports={paymentDecision,offering,attachPayments,requireStripeOffering,checkoutInput,stripeConfigured,error};
