'use strict';
// Additive manual migration only; never executed at application startup.
const statements=[
 `CREATE TABLE ng_bank_destinations (
 id CHAR(36) PRIMARY KEY, scholar_id INT NOT NULL, merchant VARCHAR(32) NOT NULL,
 environment ENUM('test','live') NOT NULL, recipient_code VARCHAR(100) NOT NULL,
 bank_code VARCHAR(16) NOT NULL, bank_name VARCHAR(120) NOT NULL,
 account_last4 CHAR(4) NOT NULL, account_name_masked VARCHAR(120) NOT NULL,
 fingerprint CHAR(64) NOT NULL, operation_id CHAR(36) NOT NULL, created_at DATETIME(3) NOT NULL,
 UNIQUE KEY uq_ng_bank_recipient(merchant,environment,recipient_code),
 UNIQUE KEY uq_ng_bank_operation(operation_id), UNIQUE KEY uq_ng_bank_owner(scholar_id,id),
 FOREIGN KEY(scholar_id) REFERENCES users(id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_profiles (
 scholar_id INT PRIMARY KEY, merchant VARCHAR(32) NOT NULL, environment ENUM('test','live') NOT NULL,
 destination_id CHAR(36) NULL, revision INT UNSIGNED NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
 FOREIGN KEY(scholar_id) REFERENCES users(id),
 FOREIGN KEY(scholar_id,destination_id) REFERENCES ng_bank_destinations(scholar_id,id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_challenges (
 id CHAR(36) PRIMARY KEY, scholar_id INT NOT NULL, profile_revision INT UNSIGNED NOT NULL,
 session_hash CHAR(64) NOT NULL, email_hash CHAR(64) NOT NULL,
 state ENUM('resolved','creating','uncertain','confirmed','expired','cancelled') NOT NULL,
 cipher MEDIUMTEXT NULL, fingerprint CHAR(64) NOT NULL, bank_code VARCHAR(16) NOT NULL,
 bank_name VARCHAR(120) NOT NULL, account_last4 CHAR(4) NOT NULL, account_name_masked VARCHAR(120) NOT NULL,
 recipient_code VARCHAR(100) NULL, created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL,
 FOREIGN KEY(scholar_id) REFERENCES users(id),
 INDEX ix_ng_bank_challenges(scholar_id,state), INDEX ix_ng_bank_expiry(expires_at)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_proofs (
 token_hash CHAR(64) PRIMARY KEY, actor_id INT NOT NULL, session_hash CHAR(64) NOT NULL,
 email_hash CHAR(64) NOT NULL, purpose ENUM('setup','reconcile') NOT NULL,
 target VARCHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, used_at DATETIME(3) NULL,
 FOREIGN KEY(actor_id) REFERENCES users(id), INDEX ix_ng_bank_proof_expiry(expires_at)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_events (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, scholar_id INT NOT NULL,
 actor_id INT NOT NULL, action VARCHAR(64) NOT NULL, details JSON NOT NULL, created_at DATETIME(3) NOT NULL,
 FOREIGN KEY(scholar_id) REFERENCES users(id), FOREIGN KEY(actor_id) REFERENCES users(id),
 INDEX ix_ng_bank_history(scholar_id,id)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_mail (
 id CHAR(36) PRIMARY KEY, scholar_id INT NOT NULL, kind VARCHAR(32) NOT NULL,
 cipher MEDIUMTEXT NULL, state ENUM('pending','sending','sent','review') NOT NULL,
 attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0, next_attempt DATETIME(3) NOT NULL,
 lease_until DATETIME(3) NULL, sent_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL,
 FOREIGN KEY(scholar_id) REFERENCES users(id), INDEX ix_ng_bank_mail(state,next_attempt)
 ) ENGINE=InnoDB`,
 `CREATE TABLE ng_bank_limits (
 actor_id INT NOT NULL, action VARCHAR(24) NOT NULL, bucket BIGINT NOT NULL,
 attempts INT UNSIGNED NOT NULL, PRIMARY KEY(actor_id,action,bucket), FOREIGN KEY(actor_id) REFERENCES users(id)
 ) ENGINE=InnoDB`
];
module.exports={statements};
