const currencies = Object.freeze({ EUR: 2, NGN: 2 });
function currencyCode(value) {
    const code = String(value || '').toUpperCase();
    if (!(code in currencies)) throw new Error('Unsupported currency');
    return code;
}
function toMinor(value, currency) {
    currencyCode(currency);
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
    if (!match) throw new Error('Invalid monetary amount');
    const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(amount)) throw new Error('Amount outside safe range');
    return amount;
}
function decimal(amount) {
    if (!Number.isSafeInteger(Number(amount))) throw new Error('Invalid minor units');
    return (Number(amount) / 100).toFixed(2);
}
function allocation(amount, ordinal) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('Invalid allocation');
    const rate = ordinal <= 100 ? 70 : 50;
    const scholar = Number((BigInt(amount) * BigInt(rate) + 50n) / 100n);
    return { rate, scholar, platform: amount - scholar };
}
function totalsByCurrency(rows, field) {
    return rows.reduce((totals, row) => {
        const currency = currencyCode(row.currency);
        const total = (totals[currency] || 0) + Number(row[field]);
        if (!Number.isSafeInteger(total)) throw new Error('Invalid monetary total');
        totals[currency] = total;
        return totals;
    }, {});
}
module.exports = { currencyCode, toMinor, decimal, allocation, totalsByCurrency };
