'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ win, app, delay, shot }) => {
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const root = path.join(app.getPath('userData'), 'manual-apps');
  fs.mkdirSync(root, { recursive: true });
  const first = path.join(root, 'First App.exe');
  const second = path.join(root, 'Second App.exe');
  fs.writeFileSync(first, 'fixture, never executed');
  fs.writeFileSync(second, 'fixture, never executed');
  await js(`(async () => {
    window.__discovery = await import('app://local/js/views/products.js');
    window.__discovery.openAddProduct();
    window.__setLaunch = (value) => {
      const field = document.querySelector('#launch');
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.__add = () => [...document.querySelectorAll('.scrim .dialog__foot button')].find((b) => b.textContent.trim() === '添加').click();
    return true;
  })()`);
  await js(`window.__setLaunch(${JSON.stringify('"' + first + '"')}); true`);
  await delay(1100);
  assert.match(await js("document.querySelector('#probeBox').textContent"), /路径有效/);
  // Change the path and immediately submit, before the debounce can probe it.
  await js(`window.__setLaunch(${JSON.stringify('"' + second + '" --profile "test profile"')}); window.__add(); true`);
  await delay(1300);
  const state = (await js("window.atelier.call('config:get', {})")).data;
  const product = state.products.find((p) => p.launchPath === second);
  assert.ok(product, 'changed input must add the normalized second executable');
  assert.equal(product.name, 'Second App');
  assert.ok(!state.products.some((p) => p.launchPath === first));
  assert.ok(!await js("!!document.querySelector('#launch')"));
  console.log('[PASS] quoted EXE, quoted arguments, changed path, and immediate submit use fresh probe');

  // A slow, older response must never overwrite the current probe.
  await js(`(async () => {
    const { api } = await import('app://local/js/api.js');
    window.__originalProbe = api.probe;
    let old = true;
    api.probe = async (value) => {
      const wait = old ? 1500 : 0; old = false;
      const result = await window.__originalProbe(value);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return result;
    };
    window.__discovery.openAddProduct();
    window.__setLaunch(${JSON.stringify(first)});
    return true;
  })()`);
  await delay(900);
  await js(`window.__setLaunch(${JSON.stringify(second)}); true`);
  await delay(1900);
  assert.equal(await js("document.querySelector('#pname').value"), 'Second App');
  await shot('discovery-fresh-probe');
  await js(`(async () => {
    const { api } = await import('app://local/js/api.js'); api.probe = window.__originalProbe;
    window.__setLaunch(${JSON.stringify(path.join(root, 'Missing.exe'))});
    window.__add(); return true;
  })()`);
  await delay(300);
  assert.match(await js("document.querySelector('#probeBox').textContent"), /路径不存在/);
  assert.ok(await js("!!document.querySelector('#launch')"));
  console.log('[PASS] stale response ignored; missing EXE cannot be registered');
  return { ok: true, summary: { passed: 2 } };
};
