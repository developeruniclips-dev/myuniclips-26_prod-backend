const {readBounded}=require('../../utils/readCapacity');
const { calculateScholarEarnings } = require('../../utils/scholarEarnings');
const { decimal } = require('./money');
async function scholarEarnings(pool, scholarId) {
    // Course sales come from bundle purchases, not legacy individual-video rows.
    // Separate reads avoid UNION collation conflicts across historical schemas.
    const [sales] = await readBounded(pool,`SELECT p.*,s.name AS course_name,'bundle' AS kind,
        (MONTH(p.created_at)=MONTH(CURRENT_DATE()) AND YEAR(p.created_at)=YEAR(CURRENT_DATE())) AS is_current_month
        FROM subject_purchases p LEFT JOIN subjects s ON s.id=p.subject_id
        WHERE p.scholar_id=? ORDER BY p.created_at,p.id`, [scholarId]);
    const [courses] = await readBounded(pool,`SELECT DISTINCT s.id,s.name,s.bundle_price FROM subjects s JOIN scholar_subjects ss
        ON ss.subject_id=s.id WHERE ss.scholar_user_id=?`, [scholarId]);
    let authoritative = [];
    try {
        [authoritative] = await readBounded(pool,`SELECT a.*,o.purchase_id,o.refund_state,o.dispute_state,t.state AS transfer_state,t.transfer_id,t.completed_at FROM payment_allocations a
            JOIN payment_orders o ON o.id=a.order_id JOIN payment_transfers t ON t.order_id=a.order_id WHERE a.scholar_id=?`, [scholarId]);
    } catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
    const byPurchase = new Map(authoritative.map(row => [Number(row.purchase_id), row]));
    const [history] = await readBounded(pool,'SELECT * FROM scholar_payouts WHERE scholar_user_id=? ORDER BY created_at DESC', [scholarId]);
    const releaseRecords = [];
    for (const row of history) {
        let instruction;
        try { instruction = JSON.parse(row.description); } catch { continue; }
        const sale = sales.find(s => Number(s.id) === instruction?.purchaseId);
        if (instruction?.kind === 'uniclips_legacy_verified_v1' && sale && sale.transaction_id === instruction.paymentId &&
            String(sale.currency).toUpperCase() === 'EUR' && String(row.currency).toUpperCase() === 'EUR' &&
            Math.round(Number(sale.amount) * 100) === instruction.grossMinor && Math.round(Number(row.amount) * 100) === instruction.amountMinor &&
            Number.isSafeInteger(instruction.amountMinor) && [70,50].includes(instruction.rate) && Number.isSafeInteger(instruction.ordinal))
            releaseRecords.push({ ...row, ...instruction });
    }
    const releaseByPurchase = new Map(releaseRecords.map(r => [r.purchaseId, r]));
    const scopeCurrencies=new Map();for(const s of sales){const id=Number(s.subject_id);if(!scopeCurrencies.has(id))scopeCurrencies.set(id,new Set());scopeCurrencies.get(id).add(String(s.currency||'UNKNOWN').toUpperCase());}
    const mixedSubjects=new Set([...scopeCurrencies].filter(([,currencies])=>currencies.size>1).map(([id])=>id));
    const neutral=mixedSubjects.size||sales.some(s=>String(s.currency).toUpperCase()==='NGN')?await require('../coursePayments/reporting').purchaseEvidence(pool,sales):[];
    const verifiedProofs=new Map(neutral.filter(s=>s.verificationState==='verified').map(s=>[Number(s.id),s]));
    for (const sale of sales) {
        sale.currency = String(sale.currency || 'UNKNOWN').toUpperCase();
        const record = sale.currency==='EUR' && sale.kind === 'bundle' && byPurchase.get(Number(sale.id));
        if (record) { sale.scholar_minor = Number(record.scholar_minor); sale.accounting_source = 'authoritative'; }
        else if (releaseByPurchase.has(Number(sale.id))) { sale.scholar_minor = releaseByPurchase.get(Number(sale.id)).amountMinor; sale.accounting_source = 'release_verified'; }
        else if(verifiedProofs.has(Number(sale.id))){sale.scholar_minor=verifiedProofs.get(Number(sale.id)).scholarMinor;sale.accounting_source=sale.currency==='NGN'?'ng_held':'audited_verified';}
        else if(sale.currency==='NGN'||sale.currency==='UNKNOWN'||mixedSubjects.has(Number(sale.subject_id))){sale.scholar_minor=0;sale.accounting_source='unreconciled';}
        else sale.accounting_source = 'legacy_calculated';
    }
    const currencies = [...new Set(['EUR', ...sales.map(s => s.currency), ...history.map(p => String(p.currency).toUpperCase())])];
    const summaries = {};
    let salesByCourse = [];
    for (const currency of currencies) {
        const matching = sales.filter(s => s.currency === currency);
        const report = calculateScholarEarnings(matching, currency === 'EUR' ? courses : []);
        const records = authoritative.filter(a => a.currency === currency && currency==='EUR');
        const earned = records.reduce((n, a) => n + Number(a.scholar_minor), 0);
        const transferred = records.filter(a => a.transfer_state === 'completed').reduce((n, a) => n + Number(a.scholar_minor), 0);
        const pending = records.filter(a => a.transfer_state === 'pending' && a.refund_state === 'none' && a.dispute_state === 'none').reduce((n, a) => n + Number(a.scholar_minor), 0);
        const legacy = calculateScholarEarnings(matching.filter(s => s.accounting_source === 'legacy_calculated')).summary;
        const legacyPaid = history.filter(p => currency!=='NGN' && String(p.currency).toUpperCase() === currency && p.status === 'completed')
            .reduce((n, p) => n + Math.round(Number(p.amount) * 100), 0);
        const release = releaseRecords.filter(r => r.currency === currency && !byPurchase.has(r.purchaseId));
        const releasePending = release.filter(r => r.status === 'pending').reduce((n,r) => n + r.amountMinor, 0);
        summaries[currency] = { ...report.summary, currency, totalPaid: decimal(legacyPaid + transferred),
            pendingBalance: decimal(pending + releasePending), payoutCount: history.filter(p => String(p.currency).toUpperCase() === currency).length + records.filter(a => a.transfer_state === 'completed').length,
            legacyCalculatedEarnings: legacy.scholarEarnings, legacyRecordedTransfers: decimal(legacyPaid),
            legacyReconciliationRequired: matching.some(s => s.accounting_source === 'legacy_calculated'),
            authoritativeEarned: decimal(earned), authoritativeTransferred: decimal(transferred),
            verifiedReleaseEarned: decimal(release.reduce((n,r)=>n+r.amountMinor,0)),
            uncertainTransferAmount: decimal(records.filter(a => a.transfer_state === 'uncertain').reduce((n, a) => n + Number(a.scholar_minor), 0) + release.filter(r=>r.status==='uncertain').reduce((n,r)=>n+r.amountMinor,0)) };
        if(currency==='NGN')Object.assign(summaries[currency],{payoutState:'held',automaticPayoutsEnabled:false,heldScholarAmount:decimal(matching.filter(s=>s.accounting_source==='ng_held').reduce((n,s)=>n+s.scholar_minor,0))});
        const unresolved=matching.some(s=>s.accounting_source==='unreconciled');
        if(unresolved)Object.assign(summaries[currency],{scholarEarnings:null,platformFee:null,monthlyEarnings:null,legacyReconciliationRequired:true});
        for(const course of report.salesByCourse)if(matching.some(s=>Number(s.subject_id)===course.id&&s.accounting_source==='unreconciled'))Object.assign(course,{scholarEarnings:null,monthlyEarnings:null,reconciliationRequired:true});
        salesByCourse.push(...report.salesByCourse.map(row => ({ ...row, currency })));
    }
    return { summary: summaries.EUR, summariesByCurrency: summaries, salesByCourse,
        accountingNote: 'Legacy earnings are calculated estimates; new earnings are immutable allocations. Transfers are not bank payouts. Pending excludes legacy and uncertain transfers.',
        payoutHistory: [...history.map(p => ({ id: p.id, amount: Number(p.amount).toFixed(2), currency: p.currency,
            status: p.status, stripeTransferId: p.stripe_transfer_id, date: p.created_at, source: 'legacy_recorded_transfer' })),
            ...authoritative.filter(a => a.transfer_state === 'completed').map(a => ({ id: a.order_id, amount: decimal(a.scholar_minor),
                currency: a.currency, status: 'Transferred to Stripe', stripeTransferId: a.transfer_id, date: a.completed_at, source: 'authoritative_transfer' }))]
            .sort((a,b) => new Date(b.date)-new Date(a.date)).slice(0,20),
        transfers: authoritative.map(a => ({ orderId: a.order_id, amount: decimal(a.scholar_minor), currency: a.currency, state: a.transfer_state })) };
}
module.exports = { scholarEarnings };
