'use strict';
// A bounded reconciliation read is evidence only. Incomplete evidence must never
// select a new transfer instruction. Both existing services treat [] as uncertain.
async function findBoundedTransfers(stripe, group) {
    try {
        const page = await require('./reconciliationReadClient').reconciliationReadClient(stripe).transfers.list(
            { transfer_group: group, limit: 2 },
            { timeout: 10000, maxNetworkRetries: 0 }
        );
        if (page?.object !== 'list' || page.has_more !== false || !Array.isArray(page.data) || page.data.length !== 1) return [];
        const transfer = page.data[0];
        if (!transfer || !/^tr_[a-zA-Z0-9_]+$/.test(transfer.id || '') || transfer.transfer_group !== group ||
            !Number.isSafeInteger(transfer.amount) || transfer.amount <= 0 || !/^[a-z]{3}$/.test(transfer.currency || '') ||
            typeof transfer.destination !== 'string' || typeof transfer.source_transaction !== 'string' ||
            !transfer.metadata || typeof transfer.metadata !== 'object' || Array.isArray(transfer.metadata) ||
            transfer.reversed !== false) return [];
        return [transfer];
    } catch {
        // The existing uncertain instruction remains unchanged; no retry/write.
        return [];
    }
}
module.exports = { findBoundedTransfers };
