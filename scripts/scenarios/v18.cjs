'use strict';
/**
 * scripts/scenarios/v18.cjs — 第 009 轮验收（发布前纠错）
 *
 * 1. 右上角按钮语义：复制「软件目录 + 一句引导语」，且清单文件真实存在、内容对得上
 * 2. 清单随索引更新：skills.index.md 的分组标题与 skill 数一致
 * 3. 设置页：没有「更新仓库」输入框；有「项目地址」「检查更新」；版本 1.0.0
 * 4. 按钮在所有视图都可见（不再只挂在「全部 Skill」）
 */

const fs = require('node:fs');
const path = require('node:path');
const { clipboard } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

module.exports = async function run({ win, delay, shot }) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`
    window.__T = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      until: async (fn, ms = 8000, step = 120) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, step)); }
        return false;
      }
    };
    1;
  `);
  await delay(900);

  /* ---------------- 1. 复制给智能体 ---------------- */
  const meta = await js(`(async () => (await window.atelier.call('config:get', {})).data.meta)()`);
  await js(`(async () => { window.__goto('skills'); await window.__T.wait(500); return 1; })()`);
  const copied = await js(`
    (async () => {
      const btn = document.getElementById('copyPathsBtn');
      btn.click();
      await window.__T.wait(700);
      return { label: btn.textContent.trim(), tip: btn.dataset.tip || '' };
    })()
  `);
  const text = String((await clipboard.readText()) || '');
  const indexFile = meta.indexFile;
  const exists = fs.existsSync(indexFile);
  const body = exists ? fs.readFileSync(indexFile, 'utf8') : '';

  check('按钮文案为「复制给智能体」', /复制给智能体/.test(copied.label), copied);
  check('剪贴板含软件目录', text.includes(meta.appHome), { appHome: meta.appHome });
  check('剪贴板含清单路径且指向同目录', text.includes('skills.index.md') && indexFile.endsWith('skills.index.md'), { indexFile });
  check('清单文件真实存在', exists, { exists });

  /* ---------------- 2. 清单内容与索引一致 ---------------- */
  const skillCount = (await js(`(async () => (await window.atelier.call('config:get', {})).data.skills.length)()`)) || 0;
  const rows = body.split('\n').filter((l) => /^\| .+ \| .+ \| `.+` \|$/.test(l)).length;
  check('清单列出全部 skill（行数 = 索引条数）', rows === skillCount && skillCount > 0, { rows, skillCount });
  check('清单分「全局 / 项目」两段', /## 全局 skill/.test(body) && /## 项目 skill/.test(body), {
    global: /## 全局 skill/.test(body), project: /## 项目 skill/.test(body)
  });
  check('清单不含密钥样式字符串', !/sk-[A-Za-z0-9]{16,}/.test(body), { leak: /sk-[A-Za-z0-9]{16,}/.test(body) });

  /* ---------------- 3. 设置页 ---------------- */
  const set = await js(`
    (async () => {
      window.__goto('settings');
      await window.__T.wait(600);
      const txt = document.body.textContent;
      return {
        hasRepoInput: !!document.getElementById('updateRepo'),
        hasRepoRow: /项目地址/.test(txt),
        hasCheck: !!document.getElementById('checkUpdate'),
        hasOpenRepo: !!document.getElementById('openRepo'),
        version: (document.querySelector('#checkUpdate') ? txt.match(/Skill Atelier v([0-9.]+)/) || [] : [])[1] || '',
        repoText: (txt.match(/github\\.com\\/[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+/) || [])[0] || ''
      };
    })()
  `);
  check('设置页不再有「更新仓库」输入框', set.hasRepoInput === false, { hasRepoInput: set.hasRepoInput });
  check('设置页有「项目地址」行且可打开', set.hasRepoRow && set.hasOpenRepo && /github\.com\/kelai061\/skill-manage/.test(set.repoText), {
    repoText: set.repoText
  });
  check('「检查更新」只保留一个入口', set.hasCheck === true, { hasCheck: set.hasCheck });
  check('版本号为 1.0.0', set.version === '1.0.0', { version: set.version });
  await shot('53-settings-about');

  /* ---------------- 4. 按钮在所有视图可见 ---------------- */
  const vis = await js(`
    (async () => {
      const out = {};
      for (const v of ['groups', 'combos', 'products', 'settings', 'skills']) {
        window.__goto(v);
        await window.__T.wait(320);
        out[v] = !document.getElementById('copyPathsBtn').classList.contains('hidden');
      }
      return out;
    })()
  `);
  check('复制按钮在所有视图都可见', Object.values(vis).every(Boolean), vis);

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v18',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v18.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v18.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
