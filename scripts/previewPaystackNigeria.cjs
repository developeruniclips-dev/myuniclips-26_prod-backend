'use strict';
// Preview only by construction: no DB driver, .env, network or apply function.
const { statements } = require('../src/services/paystackNigeria/schema');
if (require.main === module) {
    if (process.argv.length !== 2) {
        console.error('PREVIEW_ONLY: no execution arguments are supported');
        process.exitCode = 2;
    } else console.log('-- Proposed Paystack Nigeria TEST-context tables; not executed.\n' + statements.join(';\n\n') + ';');
}
module.exports = { statements };
