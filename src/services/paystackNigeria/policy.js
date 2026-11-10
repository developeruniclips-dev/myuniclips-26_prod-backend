'use strict';
const { allocation } = require('../payments/money');
const RULE = Object.freeze({
    version: 'paystack-ng-course-1500-v1', entity: 'UNICLIPS_NIGERIA_LIMITED',
    currency: 'NGN', totalMinor: 150000, feeBearer: 'UNICLIPS',
    accessCalendarMonths: 5, automaticPayouts: false, automaticRenewals: false,
    automaticRefunds: false, automaticRevocations: false,
});
function fail(code) { throw Object.assign(new Error(code), { code }); }
function id(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_IDENTIFIER');
    return value;
}
function amount(value, currency) {
    if (currency !== RULE.currency || value !== RULE.totalMinor) fail('PAYMENT_AMOUNT_MISMATCH');
}
function share(ordinal, feesMinor = null) {
    id(ordinal);
    if (feesMinor !== null && (!Number.isSafeInteger(feesMinor) || feesMinor < 0)) fail('INVALID_PROCESSING_FEE');
    const result = allocation(RULE.totalMinor, ordinal);
    return { ordinal, currency: RULE.currency, grossMinor: RULE.totalMinor,
        scholarRate: result.rate, scholarMinor: result.scholar, platformGrossMinor: result.platform,
        processingFeesMinor: feesMinor, platformNetMinor: feesMinor === null ? null : result.platform - feesMinor };
}
function createPolicy({ enabled = false, environment = 'test', merchantAccount = '',configuration } = {}) {
    // This phase intentionally supports offline doubles/test-context records only.
    // No environment variables, credentials or application runtime are imported.
    function assertEnabled() {
        if (enabled !== true) fail('PAYSTACK_NG_DISABLED');
        if (environment !== 'test' && !(environment==='live'&&require('./transportConfig').isConfiguration(configuration)&&configuration.environment==='live'&&configuration.merchantAccount===merchantAccount)) fail('PAYSTACK_NG_LIVE_NOT_SUPPORTED');
        if(environment==='live')configuration.assert('verification');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(merchantAccount)) fail('INVALID_MERCHANT_CONTEXT');
    }
    return Object.freeze({ ...RULE, environment, merchantAccount, assertEnabled });
}
module.exports = { RULE, createPolicy, id, amount, share, fail };
