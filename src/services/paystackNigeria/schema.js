'use strict';
// Proposed MySQL 8.0.16+ DDL only. No SQL is executed by this module.
const context = `merchant_account VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    environment VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK (environment='test'),
    entity VARCHAR(40) NOT NULL DEFAULT 'UNICLIPS_NIGERIA_LIMITED' CHECK (entity='UNICLIPS_NIGERIA_LIMITED')`;
const orderFK = `FOREIGN KEY (order_id,merchant_account,environment)
    REFERENCES paystack_ng_orders(id,merchant_account,environment)`;
const tableOptions = 'ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
const statements = [
`CREATE TABLE paystack_ng_offerings (
    subject_id INT NOT NULL, scholar_id INT NOT NULL, ${context},
    currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency='NGN'),
    total_minor BIGINT NOT NULL DEFAULT 150000 CHECK (total_minor=150000),
    policy_version VARCHAR(64) NOT NULL, approved BOOLEAN NOT NULL DEFAULT 0,
    revision INT NOT NULL DEFAULT 1 CHECK (revision>0),
    PRIMARY KEY (subject_id,scholar_id,merchant_account,environment),
    FOREIGN KEY (subject_id) REFERENCES subjects(id), FOREIGN KEY (scholar_id) REFERENCES users(id)
) ${tableOptions}`,
`CREATE TABLE paystack_ng_orders (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${context},
    buyer_id INT NOT NULL, subject_id INT NOT NULL, scholar_id INT NOT NULL,
    university_id INT NOT NULL, country_id INT NOT NULL, country_code CHAR(2) NOT NULL CHECK (country_code='NG'),
    route_revision VARCHAR(64) NOT NULL, offering_revision INT NOT NULL CHECK (offering_revision>0),
    idempotency_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reference VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    currency CHAR(3) NOT NULL CHECK (currency='NGN'), total_minor BIGINT NOT NULL CHECK (total_minor=150000),
    policy_version VARCHAR(64) NOT NULL, access_months INT NOT NULL CHECK (access_months=5),
    state VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (state IN ('created','fulfilled','review_required')),
    purchase_id INT NULL, created_at DATETIME NOT NULL, fulfilled_at DATETIME NULL,
    UNIQUE KEY order_context (id,merchant_account,environment),
    UNIQUE KEY order_receipt (id,merchant_account,environment,reference),
    UNIQUE KEY order_scope (id,subject_id,scholar_id),
    UNIQUE KEY order_reference (merchant_account,environment,reference),
    UNIQUE KEY order_request (merchant_account,environment,buyer_id,idempotency_key),
    UNIQUE KEY order_entitlement (buyer_id,subject_id,scholar_id), UNIQUE KEY order_purchase (purchase_id),
    FOREIGN KEY (university_id) REFERENCES universities(id),FOREIGN KEY (country_id) REFERENCES countries(id),
    KEY order_scholar (scholar_id,currency,state),
    FOREIGN KEY (subject_id,scholar_id,merchant_account,environment)
        REFERENCES paystack_ng_offerings(subject_id,scholar_id,merchant_account,environment),
    FOREIGN KEY (buyer_id) REFERENCES users(id), FOREIGN KEY (purchase_id) REFERENCES subject_purchases(id),
    CHECK ((state='fulfilled' AND purchase_id IS NOT NULL AND fulfilled_at IS NOT NULL)
        OR (state<>'fulfilled' AND purchase_id IS NULL AND fulfilled_at IS NULL))
) ${tableOptions}`,
`CREATE TABLE paystack_ng_transactions (
    order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${context},
    provider_transaction_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    reference VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    currency CHAR(3) NOT NULL CHECK (currency='NGN'), amount_minor BIGINT NOT NULL CHECK (amount_minor=150000),
    processing_fees_minor BIGINT NULL CHECK (processing_fees_minor>=0), paid_at DATETIME NOT NULL,
    evidence_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    UNIQUE KEY transaction_id (merchant_account,environment,provider_transaction_id),
    UNIQUE KEY transaction_reference (merchant_account,environment,reference),
    FOREIGN KEY (order_id,merchant_account,environment,reference)
        REFERENCES paystack_ng_orders(id,merchant_account,environment,reference)
) ${tableOptions}`,
`CREATE TABLE paystack_ng_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ${context},
    event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(100) NOT NULL, resource_id VARCHAR(100) NOT NULL,
    payload_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    claims_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    transaction_identity VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    claims JSON NULL, processed_at DATETIME NULL, error_code VARCHAR(64) NULL,
    order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    state VARCHAR(20) NOT NULL DEFAULT 'received', received_at DATETIME NOT NULL,
    UNIQUE KEY event_once (merchant_account,environment,event_key), KEY event_pending (state,id),
    KEY event_transaction_review (merchant_account,environment,transaction_identity,state), ${orderFK}
) ${tableOptions}`,
`CREATE TABLE paystack_ng_sale_counters (
    subject_id INT NOT NULL, scholar_id INT NOT NULL,
    historical_verified_sales BIGINT NOT NULL CHECK (historical_verified_sales>=0),
    ng_successful_sales BIGINT NOT NULL CHECK (ng_successful_sales>=0),
    successful_sales BIGINT NOT NULL,
    CHECK (successful_sales=historical_verified_sales+ng_successful_sales),
    PRIMARY KEY (subject_id,scholar_id), FOREIGN KEY (subject_id) REFERENCES subjects(id),
    FOREIGN KEY (scholar_id) REFERENCES users(id)
) ${tableOptions}`,
`CREATE TABLE paystack_ng_allocations (
    order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, ${context},
    purchase_id INT NOT NULL, subject_id INT NOT NULL, scholar_id INT NOT NULL,
    sale_ordinal BIGINT NOT NULL CHECK (sale_ordinal>0), currency CHAR(3) NOT NULL CHECK (currency='NGN'),
    gross_minor BIGINT NOT NULL CHECK (gross_minor=150000), scholar_rate INT NOT NULL CHECK (scholar_rate IN (70,50)),
    scholar_minor BIGINT NOT NULL CHECK (scholar_minor IN (105000,75000)),
    CHECK ((sale_ordinal<=100 AND scholar_rate=70 AND scholar_minor=105000) OR (sale_ordinal>100 AND scholar_rate=50 AND scholar_minor=75000)),
    platform_gross_minor BIGINT NOT NULL,
    CHECK (platform_gross_minor=150000-scholar_minor),
    policy_version VARCHAR(64) NOT NULL, payout_state VARCHAR(16) NOT NULL DEFAULT 'held' CHECK (payout_state='held'),
    UNIQUE KEY allocated_purchase (purchase_id), UNIQUE KEY allocated_ordinal (subject_id,scholar_id,sale_ordinal),
    KEY scholar_ngn (scholar_id,currency), FOREIGN KEY (purchase_id) REFERENCES subject_purchases(id), ${orderFK},
    FOREIGN KEY (order_id,subject_id,scholar_id) REFERENCES paystack_ng_orders(id,subject_id,scholar_id)
) ${tableOptions}`,
`CREATE TABLE paystack_ng_adjustments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ${context},
    order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('refund','dispute')), state VARCHAR(40) NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor>=0), currency CHAR(3) NOT NULL CHECK (currency='NGN'),
    created_at DATETIME NOT NULL, UNIQUE KEY adjustment_once (merchant_account,environment,event_key,kind),
    KEY adjustment_order (order_id,kind), ${orderFK}
) ${tableOptions}`,
];
module.exports = { statements };
