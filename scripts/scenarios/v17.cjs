'use strict';
/**
 * scripts/scenarios/v17.cjs — 第 008 轮验收（产品化：复制路径 / 帮助 / 联合更新）
 *
 * 1. 右上角「复制路径」：按当前筛选结果复制，每行一条
 * 2. 使用说明：Markdown 文档渲染
 * 3. 联合更新：顶栏提示条 + 详情对话框 + 关闭
 */

const fs = require('node:fs');
const path = require('node:path');
const { clipboard } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

module.exports = async function run({ win, delay, shot }) {
  const results = [];
  const notes = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`
    window.__T = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      until: async (fn, ms = 12000, step = 120) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, step)); }
        return false;
      }
    };
    1;
  `);
  await delay(800);

  /* ---------------- 1. 复制给智能体（软件目录 + 引导语） ---------------- */
  const copy = await js(`
    (async () => {
      window.__goto('skills');
      await window.__T.wait(600);
      const btn = document.getElementById('copyPathsBtn');
      if (!btn) return { ok: false, reason: 'no button' };
      btn.click();
      await window.__T.wait(700);
      return { ok: true, hidden: btn.classList.contains('hidden'), label: btn.textContent.trim() };
    })()
  `);
  const got = String((await clipboard.readText()) || '');
  check('右上角有「复制给智能体」按钮且始终可见', copy.ok && copy.hidden === false, copy);
  check('复制内容是软件目录 + 引导语（不是路径清单）', /skills\.index\.md/.test(got) && /所在目录|目录：/.test(got) && got.split('\n').length <= 8, {
    sample: got.slice(0, 160)
  });

  /* ---------------- 2. 使用说明 ---------------- */
  const help = await js(`
    (async () => {
      window.__goto('settings');
      await window.__T.wait(500);
      document.querySelector('#replayTour').click();
      const ok = await window.__T.until(() => document.querySelector('.helpdoc h1'), 5000);
      const h1 = document.querySelector('.helpdoc h1');
      return {
        ok,
        title: h1 ? h1.textContent.trim() : '',
        h2: document.querySelectorAll('.helpdoc h2').length,
        tables: document.querySelectorAll('.helpdoc table').length,
        code: document.querySelectorAll('.helpdoc pre').length
      };
    })()
  `);
  check('使用说明按 Markdown 渲染', help.ok && /使用说明/.test(help.title) && help.h2 >= 4 && help.tables >= 1 && help.code >= 1, help);
  await shot('51-help');
  await js(`(async () => {
    const b = [...document.querySelectorAll('.dialog__foot .btn')].find((x) => /知道了/.test(x.textContent));
    if (b) b.click();
    await window.__T.wait(300);
    return 1;
  })()`);

  /* ---------------- 3. 联合更新提示 ---------------- */
  const bar = await js(`
    (async () => {
      window.__atelierDebug.showUpdate({
        current: '1.6.0', latest: '9.9.9', hasUpdate: true,
        url: 'https://github.com/kelai061/skill-manage/releases',
        notes: '- 测试更新说明', publishedAt: new Date().toISOString()
      });
      await window.__T.wait(400);
      const el = document.getElementById('updateBar');
      if (!el) return { ok: false };
      const text = el.textContent.replace(/\\s+/g, ' ').trim();
      el.querySelector('[data-see]').click();
      await window.__T.wait(400);
      const dlg = document.querySelector('.dialog h3');
      const title = dlg ? dlg.textContent : '';
      const btns = [...document.querySelectorAll('.dialog__foot .btn')].map((b) => b.textContent.trim());
      const close = [...document.querySelectorAll('.dialog [data-close]')][0];
      if (close) close.click();
      await window.__T.wait(300);
      const stillBar = !!document.getElementById('updateBar');
      document.querySelector('#updateBar [data-dismiss]')?.click();
      await window.__T.wait(300);
      return { ok: true, text, title, btns, stillBar, dismissed: !document.getElementById('updateBar') };
    })()
  `);
  check('顶栏出现「发现新版本」提示条', bar.ok && /9\.9\.9/.test(bar.text), { text: bar.text });
  check('点「查看更新」打开更新详情', /9\.9\.9/.test(bar.title || ''), { title: bar.title });
  check('更新提示可关闭', bar.dismissed === true, { dismissed: bar.dismissed });
  await shot('52-update');

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v17',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    notes
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v17.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v17.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
