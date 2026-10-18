'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScenario } = require('./test-harness.cjs');
async function main() {
  const suites = fs.readdirSync(__dirname).filter((f) => /^unit-.*\.(cjs|mjs)$/.test(f)).sort();
  for (const suite of suites) {
    console.log(`[test] ${suite}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (r.status !== 0) return r.status || 1;
  }
  for (const scenario of ['reader', 'selection-nested', 'v18', 'audit']) {
    const status = await runScenario(`scripts/scenarios/${scenario}.cjs`);
    if (status !== 0) return status;
  }
  return 0;
}
main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
