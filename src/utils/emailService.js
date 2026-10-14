'use strict';
const nodemailer = require('nodemailer');
const { logError } = require('./safeLogging');
const { normalizeEmail, RESET_MINUTES } = require('./authSecurity');
const { domainToASCII } = require('node:url');
const failure = () => ({ success: false, error: 'Email delivery failed' });
const escapeHTML = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function text(value, fallback) {
 if (value == null) return fallback;
 if (typeof value !== 'string' || value.length > 256 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) throw Error('Invalid email content');
 return value || fallback;
}
async function mailbox(value) {
 // Reject compound/address-object input before it reaches the mail parser.
 if (typeof value !== 'string' || value.length > 254 || /[\x00-\x20\x7f-\x9f<>,;"\\]/.test(value)) throw Error('Invalid mailbox');
 const normalized = await normalizeEmail(value);
 if (!normalized) throw Error('Invalid mailbox');
 const at = normalized.lastIndexOf('@'), domain = domainToASCII(normalized.slice(at + 1));
 const address = normalized.slice(0, at + 1) + domain;
 if (!domain || Buffer.byteLength(address, 'utf8') > 254) throw Error('Invalid mailbox');
 return address;
}
function link(value, kind, env) {
 if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f-\x9f]/.test(value)) throw Error('Invalid mail link');
 const url = new URL(value);
 if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Invalid mail link');
 if (kind === 'reset') {
  const frontend = new URL(env.FRONTEND_URL || 'https://myuniclips.com');
  if (frontend.protocol !== 'https:' || frontend.username || frontend.password || url.origin !== frontend.origin || url.pathname !== '/reset-password') throw Error('Invalid reset origin');
 } else if (url.port || !(url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) throw Error('Invalid verification origin');
 return url.href;
}
function transportOptions(env) {
 const port = env.EMAIL_PORT === undefined || env.EMAIL_PORT === '' ? 587 : Number(env.EMAIL_PORT);
 if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || (env.EMAIL_PORT && !/^\d{1,5}$/.test(env.EMAIL_PORT))) throw Error('Invalid email configuration');
 for (const key of ['EMAIL_REQUIRE_TLS','EMAIL_SECURE']) if (env[key] !== undefined && !['true','false'].includes(env[key])) throw Error('Invalid email configuration');
 return {
  // Preserve service selection: Nodemailer service presets override host/port/secure.
  service: env.EMAIL_SERVICE || 'gmail', host: env.EMAIL_HOST || 'smtp.gmail.com', port,
  secure: env.EMAIL_SECURE === 'true', auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASSWORD },
  requireTLS: env.EMAIL_REQUIRE_TLS === 'true', opportunisticTLS: false,
  tls: { rejectUnauthorized: true },
  connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 30000, dnsTimeout: 10000,
  disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false
 };
}
function renderMail(kind,name,url,items) {
 const requirementsList=items.length?items.map(item=>'<li>'+escapeHTML(item)+'</li>').join(''):'<li>Identity verification</li>';
 if(kind==='reset')return{html:`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Password Reset</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 28px;">🔑 Password Reset</h1>
                </div>
                
                <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
                    <p style="font-size: 16px;">Hi <strong>${escapeHTML(name)}</strong>,</p>
                    
                    <p style="font-size: 16px;">We received a request to reset your password for your Uniclips account. Click the button below to create a new password:</p>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${escapeHTML(url)}" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-size: 16px; font-weight: bold; display: inline-block;">Reset Password</a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">If the button doesn't work, copy and paste this link into your browser:</p>
                    <p style="font-size: 12px; color: #888; word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 5px;">${escapeHTML(url)}</p>
                    
                    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
                    
                    <p style="font-size: 14px; color: #666;">⏰ This link will expire in <strong>${RESET_MINUTES} minutes</strong> for security reasons.</p>
                    
                    <p style="font-size: 14px; color: #666;">If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
                    
                    <p style="font-size: 14px; color: #999; margin-top: 30px;">
                        Best regards,<br>
                        <strong>The Uniclips Team</strong>
                    </p>
                </div>
                
                <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
                    <p>© ${new Date().getFullYear()} Uniclips. All rights reserved.</p>
                    <p>This is an automated message. Please do not reply to this email.</p>
                </div>
            </body>
            </html>
        `,text:`
Hi ${name},

We received a request to reset your password for your Uniclips account.

Click the link below to create a new password:
${url}

This link will expire in ${RESET_MINUTES} minutes for security reasons.

If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.

Best regards,
The Uniclips Team
        `};
 return{html:`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Stripe Verification Required</title>
            </head>
            <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #635bff 0%, #8b5cf6 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                    <h1 style="color: white; margin: 0; font-size: 28px;">💳 Verification Required</h1>
                </div>
                
                <div style="background: #ffffff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
                    <p style="font-size: 16px;">Hi <strong>${escapeHTML(name)}</strong>,</p>
                    
                    <p style="font-size: 16px;">Great news! Your Stripe account is almost ready. To start receiving payouts for your course sales, Stripe requires some additional verification:</p>
                    
                    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                        <strong style="color: #92400e;">Pending Requirements:</strong>
                        <ul style="color: #92400e; margin: 10px 0 0 0; padding-left: 20px;">
                            ${requirementsList}
                        </ul>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${escapeHTML(url)}" style="background: linear-gradient(135deg, #635bff 0%, #8b5cf6 100%); color: white; padding: 15px 40px; text-decoration: none; border-radius: 25px; font-size: 16px; font-weight: bold; display: inline-block;">Complete Verification</a>
                    </div>
                    
                    <p style="font-size: 14px; color: #666;">If the button doesn't work, copy and paste this link into your browser:</p>
                    <p style="font-size: 12px; color: #888; word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 5px;">${escapeHTML(url)}</p>
                    
                    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
                    
                    <p style="font-size: 14px; color: #666;">⏰ Please complete this verification soon to avoid any delays in receiving your earnings.</p>
                    
                    <p style="font-size: 14px; color: #666;">This is a secure link powered by Stripe. Your information is protected with bank-level security.</p>
                    
                    <p style="font-size: 14px; color: #999; margin-top: 30px;">
                        Best regards,<br>
                        <strong>The Uniclips Team</strong>
                    </p>
                </div>
                
                <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
                    <p>© ${new Date().getFullYear()} Uniclips. All rights reserved.</p>
                    <p>This is an automated message. Please do not reply to this email.</p>
                </div>
            </body>
            </html>
        `,text:`
Hi ${name},

Great news! Your Stripe account is almost ready. To start receiving payouts for your course sales, Stripe requires some additional verification.

Click the link below to complete your verification:
${url}

Please complete this verification soon to avoid any delays in receiving your earnings.

Best regards,
The Uniclips Team
        `};
}
function createEmailService({ env = process.env, mailer = nodemailer, logger = console } = {}) {
 async function deliver(kind, to, suppliedLink, suppliedName, requirements = []) {
  let transporter;
  try {
   const recipient = await mailbox(to), sender = await mailbox(env.EMAIL_USER || 'noreply@uniclips.com');
   const name = text(suppliedName, kind === 'reset' ? 'User' : 'Scholar'), url = link(suppliedLink, kind, env);
   if (!Array.isArray(requirements) || requirements.length > 100) throw Error('Invalid requirements');
   const items = requirements.map(value => text(value, 'Identity verification').replace(/_/g, ' '));
   const reset = kind === 'reset', subject = reset ? 'Password Reset Request - Uniclips' : 'Action Required: Complete Your Stripe Verification - Uniclips';
   const {html,text:plain}=renderMail(kind,name,url,items);
   transporter = mailer.createTransport(transportOptions(env));
   const info = await transporter.sendMail({from:{name:'Uniclips',address:sender},to:{address:recipient},envelope:{from:sender,to:[recipient]},subject,html,text:plain,disableFileAccess:true,disableUrlAccess:true});
   logger.log(reset ? 'Password reset email delivery completed' : 'Verification email delivery completed');
   return { success: true, messageId: info.messageId };
  } catch (error) {
   logError(kind === 'reset' ? 'Password reset email delivery failed' : 'Verification email delivery failed', error, logger);
   return failure();
  } finally { try { transporter?.close?.(); } catch {} }
 }
 return {
  sendPasswordResetEmail: (to, url, name = 'User') => deliver('reset', to, url, name),
  sendStripeVerificationEmail: (to, url, name = 'Scholar', requirements = []) => deliver('verification', to, url, name, requirements),
  verifyEmailConfig: async () => {
   let transporter;
   try { transporter = mailer.createTransport(transportOptions(env)); await transporter.verify(); logger.log('Email configuration is valid'); return true; }
   catch (error) { logError('Email configuration verification failed', error, logger); return false; }
   finally { try { transporter?.close?.(); } catch {} }
  }
 };
}
module.exports = { ...createEmailService(), createEmailService, mailbox, transportOptions };
