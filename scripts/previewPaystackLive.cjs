'use strict';
// Output only. Deliberately no apply option, database import or connection.
if(process.argv.length!==2){console.error('Live schema preview only; execution is not supported.');process.exitCode=1;}
else console.log('-- REVIEW ONLY: new Live tables for an independently reviewed production schema; never run on sandbox.\n'+require('../src/services/paystackNigeria/liveSchema').statements.join(';\n')+';');
