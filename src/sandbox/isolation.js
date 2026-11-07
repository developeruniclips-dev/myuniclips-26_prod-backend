'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const fail = code => { throw Object.assign(new Error('Sandbox prerequisite unavailable'), {code, status:503}); };
const DATABASE = 'uniclipspsngsandbox';
function settings(env) {
  if(env.SANDBOX_APPROVAL_MODE!=='single-owner-v1'||env.SANDBOX_REVIEWER_PUBLIC_KEY)fail('SANDBOX_OWNER_MODE_REQUIRED');
  if (env.UNICLIPS_SANDBOX !== 'paystack-test-v1' || env.NODE_ENV !== 'test' ||
      env.DB_NAME !== DATABASE || !['psngsandboxapp','psngsandboxmigrator'].includes(env.DB_USER) ||
      !env.DB_HOST || !env.DB_PASS || env.DB_SSL !== 'true' || !env.DB_SSL_CA ||
      env.PAYMENT_ARCHITECTURE !== 'legacy_verified') fail('SANDBOX_ISOLATION_REQUIRED');
  for (const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','VIMEO_ACCESS_TOKEN','SMTP_PASS']) {
    if (env[key]) fail('SANDBOX_EXTERNAL_CREDENTIAL_FORBIDDEN');
  }
  if (env.PAYSTACK_NG_LIVE_CHECKOUT && env.PAYSTACK_NG_LIVE_CHECKOUT !== 'disabled') fail('PAYSTACK_LIVE_NOT_SUPPORTED');
  const origin = new URL(env.FRONTEND_URL);
  if (origin.protocol !== 'https:' || origin.origin !== env.FRONTEND_URL ||
      env.ALLOWED_ORIGINS !== origin.origin || /(^|\.)myuniclips\.com$/i.test(origin.hostname) ||
      origin.hostname === 'taupe-empanada-b7dfa9.netlify.app') fail('SANDBOX_FRONTEND_REQUIRED');
  return {database:DATABASE, origin:origin.origin};
}
function sourceDigest(root = path.resolve(__dirname, '../..')) {
  const files = ['package.json','package-lock.json','.node-version'];
  function walk(dir) { for (const e of fs.readdirSync(path.join(root,dir),{withFileTypes:true})) {
    const p=dir+'/'+e.name; if(e.isSymbolicLink()) fail('SANDBOX_SOURCE_SYMLINK');
    if(e.isDirectory())walk(p); else if(e.isFile())files.push(p);
  }}
  walk('src');
  return crypto.createHash('sha256').update(JSON.stringify(files.sort().map(f=>{
    const bytes=fs.readFileSync(path.join(root,f)),text=bytes.toString('utf8');
    const canonical=Buffer.from(text).equals(bytes)?Buffer.from(text.replace(/\r\n/g,'\n')):bytes;
    return[f,crypto.createHash('sha256').update(canonical).digest('hex')];
  }))).digest('hex');
}
function identity(env, source = sourceDigest()) {
  if (!/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE_ID || '') || !/^[A-Za-z0-9_-]{1,128}$/.test(env.RENDER_INSTANCE_ID || '')) fail('SANDBOX_RENDER_IDENTITY_REQUIRED');
  return Object.freeze({service:env.RENDER_SERVICE_ID,generation:crypto.randomUUID(),source,instance:env.RENDER_INSTANCE_ID});
}
module.exports={settings,identity,sourceDigest,fail,DATABASE};
