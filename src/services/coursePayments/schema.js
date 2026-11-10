'use strict';
// Additive proposal only. No executor, credentials, startup import or seeding.
const options='ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
const statements=[
`CREATE TABLE course_sale_audits (
 subject_id INT NOT NULL,scholar_id INT NOT NULL,review_version INT NOT NULL CHECK(review_version>0),
 baseline_count BIGINT NOT NULL CHECK(baseline_count>=0),baseline_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_revision VARCHAR(100) NOT NULL,review_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 writer_mode VARCHAR(24) NOT NULL CHECK(writer_mode='legacy_verified'),state VARCHAR(16) NOT NULL CHECK(state IN ('approved','blocked')),
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(subject_id,scholar_id,review_version),UNIQUE(review_id),
 FOREIGN KEY(subject_id) REFERENCES subjects(id),FOREIGN KEY(scholar_id) REFERENCES users(id)
) ${options}`,
`CREATE TABLE course_sale_proofs (
 purchase_id INT NOT NULL PRIMARY KEY,subject_id INT NOT NULL,scholar_id INT NOT NULL,sale_ordinal BIGINT NOT NULL CHECK(sale_ordinal>0),
 provider VARCHAR(24) NOT NULL CHECK(provider IN ('stripe','paystack')),entity VARCHAR(40) NOT NULL,
 merchant_account VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,environment VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NOT NULL CHECK(environment IN ('test','live')),
 provider_reference VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 provider_transaction_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,currency CHAR(3) NOT NULL CHECK(currency IN ('EUR','NGN')),
 gross_minor BIGINT NOT NULL CHECK(gross_minor>0),scholar_minor BIGINT NOT NULL,scholar_rate INT NOT NULL,
 source_kind VARCHAR(32) NOT NULL CHECK(source_kind IN ('legacy_verified','phase2a','paystack_ng','audited_opening')),
 source_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,evidence_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 review_version INT NOT NULL,created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((sale_ordinal<=100 AND scholar_rate=70) OR (sale_ordinal>100 AND scholar_rate=50)),
 CHECK(scholar_minor=FLOOR((gross_minor*scholar_rate+50)/100)),
 UNIQUE(subject_id,scholar_id,sale_ordinal),UNIQUE(provider,merchant_account,environment,provider_reference),
 UNIQUE(provider,merchant_account,environment,provider_transaction_id),
 KEY proof_scholar(scholar_id,currency,provider,environment),
 FOREIGN KEY(purchase_id) REFERENCES subject_purchases(id),
 FOREIGN KEY(subject_id,scholar_id,review_version) REFERENCES course_sale_audits(subject_id,scholar_id,review_version)
) ${options}`];
module.exports={statements};
