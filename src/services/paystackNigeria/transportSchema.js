'use strict';
// Proposed additive DDL only; the preview has no apply path.
const options='ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
const statements=[
`CREATE TABLE paystack_ng_checkouts (
 order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 merchant_account VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 environment VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK(environment='test'),
 email_digest CHAR(64) NOT NULL, credential_digest CHAR(64) NOT NULL,
 state VARCHAR(20) NOT NULL CHECK(state IN ('initializing','ready','uncertain','failed')),
 checkout_url VARCHAR(512) NULL, initialization_digest CHAR(64) NULL,
 attempted_at DATETIME NOT NULL, review_code VARCHAR(64) NULL,
 FOREIGN KEY(order_id,merchant_account,environment) REFERENCES paystack_ng_orders(id,merchant_account,environment)
) ${options}`,
`CREATE TABLE paystack_ng_verifications (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
 order_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 state VARCHAR(16) NOT NULL CHECK(state IN ('verified','pending','failed','review')),
 provider_transaction_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
 response_digest CHAR(64) NULL, credential_digest CHAR(64) NOT NULL,
 receipt JSON NULL, reason VARCHAR(64) NULL, created_at DATETIME(6) NOT NULL,
 CHECK(state<>'verified' OR (receipt IS NOT NULL AND response_digest IS NOT NULL AND provider_transaction_id IS NOT NULL)),
 KEY verification_order(order_id,created_at,id), FOREIGN KEY(order_id) REFERENCES paystack_ng_orders(id)
) ${options}`,
];
module.exports={statements};
