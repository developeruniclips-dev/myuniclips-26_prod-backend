'use strict';
const transport=require('../src/services/paystackNigeria/transportSchema').statements;
const fresh=[...require('../src/services/paystackNigeria/schema').statements,...require('../src/services/coursePayments/schema').statements,...transport];
const upgrade=[`ALTER TABLE paystack_ng_events ADD COLUMN claims_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN transaction_identity VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN claims JSON NULL,ADD COLUMN processed_at DATETIME NULL,ADD COLUMN error_code VARCHAR(64) NULL,
 ADD KEY event_transaction_review (merchant_account,environment,transaction_identity,state)`,...transport];
if(require.main===module){const args=process.argv.slice(2);if(args.length&&!(args.length===1&&args[0]==='--upgrade-preview')){console.error('PREVIEW_ONLY');process.exitCode=2;}else console.log('-- PREVIEW ONLY; no DB connection. '+(args.length?'Requires exact Phase 2D schema; partial DDL recovery must be reviewed.':'Fresh eleven-table payment schema, not an existing-schema upgrade.')+'\n'+(args.length?upgrade:fresh).join(';\n\n')+';');}
module.exports={fresh,upgrade};
