'use strict';
const { toMinor } = require('../payments/money');
const { RULE, fail } = require('./policy');
const { requireSchema } = require('./compatibility');
const MAX_BASELINE = 10000;
const number = value => {
    if (!['number','string'].includes(typeof value) || !/^\d+$/.test(String(value))) fail('INVALID_DATABASE_NUMBER');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_DATABASE_NUMBER');
    return n;
};
const orderRow = row => row && ({ id: row.id, buyerId: number(row.buyer_id), subjectId: number(row.subject_id),
    scholarId: number(row.scholar_id), reference: row.reference, idempotencyKey: row.idempotency_key,
    merchantAccount: row.merchant_account, environment: row.environment, entity: row.entity,
    currency: row.currency, totalMinor: number(row.total_minor), policyVersion: row.policy_version,
    accessMonths: number(row.access_months), state: row.state, purchaseId: row.purchase_id == null ? null : number(row.purchase_id),
    universityId:number(row.university_id),countryId:number(row.country_id),countryCode:row.country_code,
    offeringRevision:number(row.offering_revision),routeRevision:row.route_revision,
    createdAt: number(row.created_epoch) * 1000 });
const orderColumns = '*,UNIX_TIMESTAMP(created_at) AS created_epoch';
function limited(rows) { if (rows.length > MAX_BASELINE) fail('BASELINE_REVIEW_REQUIRED'); return rows; }
function createMysqlStore({ pool, resolveHistoricalSales, schemaMetadata } = {}) {
    if (!pool || typeof pool.getConnection !== 'function' || typeof resolveHistoricalSales !== 'function') fail('STORE_DEPENDENCIES_REQUIRED');
    const compatibility = requireSchema(schemaMetadata);
    function transactionApi(db) {
        const query = (sql, args = []) => db.query(sql, args);
        return {
            // NOWAIT provides immediate refusal, not a new application waiting queue.
            async lockSubject(subjectId) {
                const [rows] = await query('SELECT id FROM subjects WHERE id=? FOR UPDATE NOWAIT', [subjectId]);
                if (rows.length !== 1) fail('OFFERING_UNAVAILABLE');
            },
            async offering(subjectId, scholarId, merchantAccount, environment) {
                const [rows] = await query(`SELECT n.*,s.university_id,c.id AS country_id,c.code AS country_code FROM paystack_ng_offerings n
                    JOIN subjects s ON s.id=n.subject_id JOIN universities u ON u.id=s.university_id
                    JOIN countries c ON c.id=u.country_id
                    JOIN scholar_subjects ss ON ss.subject_id=s.id AND ss.scholar_user_id=n.scholar_id AND ss.approved=1
                    JOIN scholar_profile sp ON sp.user_id=n.scholar_id AND sp.approved=1
                    JOIN course_workflows cw ON cw.offering_id=ss.id AND cw.state='PUBLISHED'
                    WHERE n.subject_id=? AND n.scholar_id=? AND n.merchant_account=? AND n.environment=?
                    AND n.approved=1 AND c.code='NG' AND (SELECT COUNT(*) FROM countries cc WHERE cc.code=c.code)=1 AND sp.degree=s.degree_programmes
                    AND (sp.university COLLATE utf8mb4_general_ci=u.name COLLATE utf8mb4_general_ci
                        OR sp.university COLLATE utf8mb4_general_ci=CONCAT(u.name,' (',u.short_name,')') COLLATE utf8mb4_general_ci)
                    AND EXISTS (SELECT 1 FROM videos v WHERE v.subject_id=s.id AND v.scholar_user_id=n.scholar_id AND v.approved=1)`,
                [subjectId, scholarId, merchantAccount, environment]);
                if (rows.length !== 1) fail('OFFERING_UNAVAILABLE');
                return { currency: rows[0].currency, totalMinor: number(rows[0].total_minor),
                    entity: rows[0].entity, policyVersion: rows[0].policy_version,
                    universityId:number(rows[0].university_id),countryId:number(rows[0].country_id),countryCode:rows[0].country_code,
                    offeringRevision:number(rows[0].revision),routeRevision:'country-course-v1' };
            },
            async buyerExists(buyerId) { const [rows] = await query('SELECT id FROM users WHERE id=?', [buyerId]); return rows.length === 1; },
            async existingPurchase(buyerId, subjectId, scholarId) {
                const [rows] = await query('SELECT id FROM subject_purchases WHERE buyer_user_id=? AND subject_id=? AND scholar_id=? LIMIT 1', [buyerId, subjectId, scholarId]);
                return rows.length !== 0; // Any prior purchase blocks, including expired access.
            },
            async existingOrder(buyerId, subjectId, scholarId) {
                const [rows] = await query(`SELECT ${orderColumns} FROM paystack_ng_orders WHERE buyer_id=? AND subject_id=? AND scholar_id=? FOR UPDATE NOWAIT`, [buyerId, subjectId, scholarId]);
                return orderRow(rows[0]);
            },
            async requestOrder(buyerId, key, merchant, environment) {
                const [rows] = await query(`SELECT ${orderColumns} FROM paystack_ng_orders WHERE buyer_id=? AND idempotency_key=? AND merchant_account=? AND environment=?`, [buyerId, key, merchant, environment]);
                return orderRow(rows[0]);
            },
            async insertOrder(o) {
                await query(`INSERT INTO paystack_ng_orders
                    (id,buyer_id,subject_id,scholar_id,merchant_account,environment,entity,idempotency_key,reference,currency,total_minor,policy_version,access_months,university_id,country_id,country_code,offering_revision,route_revision,created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,FROM_UNIXTIME(?))`,
                [o.id,o.buyerId,o.subjectId,o.scholarId,o.merchantAccount,o.environment,o.entity,o.idempotencyKey,o.reference,o.currency,o.totalMinor,o.policyVersion,o.accessMonths,o.universityId,o.countryId,o.countryCode,o.offeringRevision,o.routeRevision,Math.floor(o.createdAt/1000)]);
            },
            async order(id) { const [rows] = await query(`SELECT ${orderColumns} FROM paystack_ng_orders WHERE id=? FOR UPDATE NOWAIT`, [id]); return orderRow(rows[0]); },
            async lockLifetime(subjectId, scholarId) {
                let stripeCounter = null;
                if (compatibility.stripeCounterPresent) {
                    // Select the existing pair before inserting so an existing locked pair
                    // fails immediately. An absent pair is initialized transactionally;
                    // its unique key serializes first creation with Stripe phase2a.
                    const [rows] = await query('SELECT successful_sales FROM payment_sale_counters WHERE subject_id=? AND scholar_id=? FOR UPDATE NOWAIT', [subjectId, scholarId]);
                    if (!rows.length) {
                        await query(`INSERT INTO payment_sale_counters (subject_id,scholar_id,legacy_baseline,successful_sales)
                            SELECT ?,?,COUNT(*),COUNT(*) FROM subject_purchases WHERE subject_id=? AND scholar_id=?
                            ON DUPLICATE KEY UPDATE subject_id=VALUES(subject_id)`, [subjectId,scholarId,subjectId,scholarId]);
                    }
                    const [locked] = await query('SELECT successful_sales FROM payment_sale_counters WHERE subject_id=? AND scholar_id=? FOR UPDATE NOWAIT', [subjectId, scholarId]);
                    stripeCounter = number(locked[0].successful_sales);
                }
                const [rows] = await query(`SELECT historical_verified_sales,ng_successful_sales,successful_sales FROM paystack_ng_sale_counters
                    WHERE subject_id=? AND scholar_id=? FOR UPDATE NOWAIT`, [subjectId,scholarId]);
                const counter = rows[0] && { historicalSales: number(rows[0].historical_verified_sales), ngSales: number(rows[0].ng_successful_sales), successfulSales: number(rows[0].successful_sales) };
                return { counter, stripeCounter };
            },
            async lifetimeSnapshot(subjectId,scholarId){
                let stripeCounter=null;
                if(compatibility.stripeCounterPresent){const [r]=await query('SELECT successful_sales FROM payment_sale_counters WHERE subject_id=? AND scholar_id=?',[subjectId,scholarId]);stripeCounter=r.length?number(r[0].successful_sales):null;}
                const [r]=await query('SELECT historical_verified_sales,ng_successful_sales,successful_sales FROM paystack_ng_sale_counters WHERE subject_id=? AND scholar_id=?',[subjectId,scholarId]);
                return {stripeCounter,counter:r[0]?{historicalSales:number(r[0].historical_verified_sales),ngSales:number(r[0].ng_successful_sales),successfulSales:number(r[0].successful_sales)}:null};
            },
            async sales(subjectId, scholarId) {
                const [rows] = await query(`SELECT id,amount,currency,transaction_id FROM subject_purchases
                    WHERE subject_id=? AND scholar_id=? ORDER BY id LIMIT 10001`, [subjectId,scholarId]);
                return limited(rows).map(row => ({ id: number(row.id), currency: row.currency,
                    amountMinor: toMinor(String(row.amount), row.currency), transactionId: row.transaction_id }));
            },
            async allocations(subjectId, scholarId) {
                const [rows] = await query(`SELECT a.purchase_id,a.sale_ordinal,o.reference,
                    (o.id IS NOT NULL AND o.state='fulfilled' AND o.purchase_id=a.purchase_id
                    AND o.subject_id=a.subject_id AND o.scholar_id=a.scholar_id
                    AND o.merchant_account=a.merchant_account AND o.environment=a.environment AND o.entity=a.entity
                    AND o.policy_version=a.policy_version AND o.currency=a.currency AND o.total_minor=a.gross_minor
                    AND t.order_id IS NOT NULL AND t.reference=o.reference AND t.currency=a.currency
                    AND t.amount_minor=a.gross_minor AND t.merchant_account=o.merchant_account
                    AND t.environment=o.environment AND t.entity=o.entity AND a.payout_state='held') AS validated
                    FROM paystack_ng_allocations a LEFT JOIN paystack_ng_orders o ON o.id=a.order_id
                    LEFT JOIN paystack_ng_transactions t ON t.order_id=a.order_id
                    WHERE a.subject_id=? AND a.scholar_id=? ORDER BY a.sale_ordinal LIMIT 10001`, [subjectId,scholarId]);
                return limited(rows).map(row => {
                    if (Number(row.validated) !== 1) fail('BASELINE_NG_LEDGER_MISMATCH');
                    return { purchaseId: number(row.purchase_id), ordinal: number(row.sale_ordinal), reference: row.reference };
                });
            },
            async historicalProofs(purchases, scope) {
                // No default resolver: it must prove EVERY historical row, including
                // prior currencies/providers. The resolver may use this transaction's
                // query handle only; no provider calls, new connection or writes.
                return resolveHistoricalSales(Object.freeze({
                    query(sql, args = []) {
                        if (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql) || /;|\b(INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE|GET_LOCK|RELEASE_LOCK)\b/i.test(sql)) fail('HISTORICAL_RESOLVER_READ_ONLY');
                        return query(sql, args);
                    },
                }), purchases.map(row => ({ ...row })), Object.freeze({ ...scope }));
            },
            async saveEvidence(o, e) {
                await query(`INSERT INTO paystack_ng_transactions (order_id,merchant_account,environment,entity,provider_transaction_id,reference,currency,amount_minor,processing_fees_minor,paid_at,evidence_digest)
                    VALUES (?,?,?,?,?,?,?,?,?,FROM_UNIXTIME(?),?)`, [o.id,o.merchantAccount,o.environment,o.entity,e.transactionId,e.reference,e.currency,e.amountMinor,e.feesMinor,e.paidAt,e.evidenceDigest]);
            },
            async appendSaleProof(o,purchaseId,s,e){
                const {auditedFacts,appendProof}=require('../coursePayments/historicalResolver');
                const {audit,rows}=await auditedFacts(db,{subjectId:o.subjectId,scholarId:o.scholarId});
                if(rows.length!==s.ordinal-1)fail('BASELINE_AUDIT_MISMATCH');
                await appendProof(db,{purchase_id:purchaseId,subject_id:o.subjectId,scholar_id:o.scholarId,sale_ordinal:s.ordinal,
                    provider:'paystack',entity:o.entity,merchant_account:o.merchantAccount,environment:o.environment,provider_reference:o.reference,
                    currency:o.currency,gross_minor:s.grossMinor,scholar_rate:s.scholarRate,scholar_minor:s.scholarMinor,
                    source_kind:'paystack_ng',source_key:o.id,evidence_digest:e.evidenceDigest,provider_transaction_id:e.transactionId},number(audit.review_version));
            },
            async evidence(orderId) { const [rows] = await query('SELECT provider_transaction_id AS transactionId,reference FROM paystack_ng_transactions WHERE order_id=?', [orderId]); return rows[0]; },
            async transportGuard(o,e){
                const [rows]=await query('SELECT * FROM paystack_ng_checkouts WHERE order_id=? FOR UPDATE NOWAIT',[o.id]);
                if(rows.length!==1||rows[0].review_code||rows[0].merchant_account!==o.merchantAccount||rows[0].environment!==o.environment)fail('PAYSTACK_PAYMENT_REVIEW_REQUIRED');
                const [proof]=await query("SELECT id FROM paystack_ng_verifications WHERE order_id=? AND state='verified' AND provider_transaction_id=? AND response_digest=? AND credential_digest=? LIMIT 1",[o.id,e.transactionId,e.evidenceDigest,rows[0].credential_digest]);
                if(proof.length!==1)fail('PAYSTACK_VERIFICATION_REQUIRED');
                const [holds]=await query("SELECT event_key FROM paystack_ng_events WHERE merchant_account=? AND environment=? AND state='review' AND (transaction_identity=? OR (transaction_identity IS NULL AND (event_type LIKE 'refund.%' OR event_type LIKE 'charge.dispute.%'))) LIMIT 1 FOR UPDATE NOWAIT",[o.merchantAccount,o.environment,e.transactionId]);
                if(holds.length)fail('PAYSTACK_EVENT_REVIEW_REQUIRED');
            },
            async grant(o, e) {
                const [result] = await query(`INSERT INTO subject_purchases (buyer_user_id,subject_id,scholar_id,amount,currency,transaction_id,created_at,access_expires_at,is_access_active)
                    VALUES (?,?,?,'1500.00','NGN',?,FROM_UNIXTIME(?),DATE_ADD(FROM_UNIXTIME(?),INTERVAL 5 MONTH),1)`, [o.buyerId,o.subjectId,o.scholarId,e.reference,e.paidAt,e.paidAt]);
                return number(result.insertId);
            },
            async allocate(o, purchaseId, s) {
                await query(`INSERT INTO paystack_ng_allocations (order_id,merchant_account,environment,entity,purchase_id,subject_id,scholar_id,sale_ordinal,currency,gross_minor,scholar_rate,scholar_minor,platform_gross_minor,policy_version,payout_state)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'held')`, [o.id,o.merchantAccount,o.environment,o.entity,purchaseId,o.subjectId,o.scholarId,s.ordinal,s.currency,s.grossMinor,s.scholarRate,s.scholarMinor,s.platformGrossMinor,o.policyVersion]);
            },
            async advance(o, baseline, ordinal, stripeCounter) {
                await query(`INSERT INTO paystack_ng_sale_counters (subject_id,scholar_id,historical_verified_sales,ng_successful_sales,successful_sales)
                    VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE historical_verified_sales=VALUES(historical_verified_sales),ng_successful_sales=VALUES(ng_successful_sales),successful_sales=VALUES(successful_sales)`,
                [o.subjectId,o.scholarId,baseline.historicalSales,baseline.ngSales+1,ordinal]);
                if (stripeCounter !== null) await query('UPDATE payment_sale_counters SET successful_sales=? WHERE subject_id=? AND scholar_id=?', [ordinal,o.subjectId,o.scholarId]);
            },
            async complete(o, purchaseId) {
                const [result] = await query("UPDATE paystack_ng_orders SET state='fulfilled',purchase_id=?,fulfilled_at=UTC_TIMESTAMP() WHERE id=? AND state='created'", [purchaseId,o.id]);
                if (result.affectedRows !== 1) fail('ORDER_STATE_CHANGED');
            },
        };
    }
    return {
        async readOrder(id) {
            const db = await pool.getConnection();
            try {
                const [[zone]] = await db.query('SELECT @@session.time_zone AS zone');
                if (!['+00:00','UTC'].includes(zone.zone)) fail('UTC_SESSION_REQUIRED');
                const [rows] = await db.query(`SELECT ${orderColumns} FROM paystack_ng_orders WHERE id=?`, [id]); return orderRow(rows[0]);
            }
            finally { db.release(); }
        },
        async transaction(work) {
            const db = await pool.getConnection();
            let started = false, isolationPending = false, destroyed = false;
            try {
                const [[zone]] = await db.query('SELECT @@session.time_zone AS zone');
                if (!['+00:00','UTC'].includes(zone.zone)) fail('UTC_SESSION_REQUIRED');
                // NEXT transaction only: do not change pool/global defaults used
                // by Stripe. RC avoids missing-row search gap-lock upgrades.
                isolationPending = true;
                await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await db.beginTransaction(); started = true; isolationPending = false;
                const result = await work(transactionApi(db));
                await db.commit(); started = false;
                return result;
            } catch (error) {
                if (started) {
                    try { await db.rollback(); }
                    catch { destroyed = true; db.destroy(); fail('PAYSTACK_NG_TRANSACTION_UNCERTAIN'); }
                }
                if (isolationPending) { destroyed = true; db.destroy(); }
                if (['ER_LOCK_NOWAIT','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) fail('PAYSTACK_NG_BUSY');
                throw error;
            } finally { if (!destroyed) db.release(); }
        },
        async earnings(scholarId) {
            const db = await pool.getConnection();
            try {
                const [[row]] = await db.query(`SELECT COUNT(*) AS sales,COALESCE(SUM(gross_minor),0) AS gross,
                    COALESCE(SUM(scholar_minor),0) AS scholar,COALESCE(SUM(platform_gross_minor),0) AS platform
                    FROM paystack_ng_allocations WHERE scholar_id=? AND currency='NGN' AND payout_state='held'`, [scholarId]);
                return { currency: RULE.currency, sales: number(row.sales), grossMinor: number(row.gross), scholarMinor: number(row.scholar), platformGrossMinor: number(row.platform), payoutState: 'held' };
            } finally { db.release(); }
        },
    };
}
module.exports = { createMysqlStore, MAX_BASELINE };
