const paymentMode = () => {
    const mode = process.env.PAYMENT_ARCHITECTURE ?? 'legacy_verified';
    if (!['legacy_verified', 'phase2a'].includes(mode)) {
        throw Object.assign(new Error('Payment configuration is unavailable. Contact support.'), { status: 503 });
    }
    return mode;
};
module.exports = { paymentMode };
