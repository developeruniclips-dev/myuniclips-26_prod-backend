'use strict';
if(process.argv.length!==2){console.error('Preview only: arguments and execution are forbidden');process.exitCode=1;}
else console.log(require('../src/services/coursePayments/schema').statements.join(';\n')+';');
