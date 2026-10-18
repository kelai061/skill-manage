'use strict';
const { runScenario } = require('./test-harness.cjs');
const target = process.argv[2];
if (!target) { console.error('用法：node scripts/run-scenario.cjs <scenario.cjs>'); process.exit(1); }
runScenario(target).then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
