'use strict';
/**
 * scripts/scenarios/v16.cjs — 第 007 轮验收（产品化收尾）
 *
 * 1. 文件预览：图片按图渲染、代码带行号、非 Markdown 隐藏翻译控件
 * 2. 使用说明：一份 Markdown 文档
 * 3. 工具探测：能列出本机已装工具
 * 4. 分享：导出/导入分享包、组合导出 Markdown
 * 5. 更新：未配置仓库时给明确提示
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SHARE_FILE = path.join(os.tmpdir(), 'sa-share-test-' + Date.now() + '.json');

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
      until: async (fn, ms = 15000, step = 120) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, step)); }
        return false;
      }
    };
    1;
  `);
  await delay(700);

  /* ---------------- 1. 图片 / 代码预览 ---------------- */
  const opened = await js(`
    (async () => {
      document.querySelector('[data-scope="all"]').click();
      await window.__T.wait(500);
      const cards = [...document.querySelectorAll('#grid .card[data-id]')];
      const target = cards.find((c) => (c.querySelector('.card__title') || {}).textContent === 'code-flowchart') || cards[0];
      if (!target) return { ok: false, reason: 'no card' };
      target.querySelector('[data-act="read"]').click();
      const ok = await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      await window.__T.until(() => document.querySelectorAll('#fileList [data-name]').length > 1, 8000);
      return { ok, name: target.querySelector('.card__title').textContent,
               files: [...document.querySelectorAll('#fileList [data-name]')].map((b) => b.dataset.name).slice(0, 20) };
    })()
  `);
  check('打开 skill 且列出附属文件', opened.ok, { name: opened.name, files: (opened.files || []).length });

  const img = await js(`
    (async () => {
      const btn = document.querySelector('#fileList [data-name$=".png"]');
      if (!btn) return { ok: false, reason: 'no png' };
      const name = btn.dataset.name;
      btn.click();
      await window.__T.wait(900);
      const el = document.querySelector('#proseSrc .fileimg img');
      const modeSeg = document.getElementById('modeSeg');
      return {
        ok: true, name,
        has: !!el,
        src: el ? el.src.slice(0, 24) : '',
        w: el ? el.naturalWidth : 0,
        h: el ? el.naturalHeight : 0,
        modeHidden: modeSeg ? getComputedStyle(modeSeg).display === 'none' : false,
        garbage: /\\uFFFD/.test((document.getElementById('proseSrc') || {}).textContent || '')
      };
    })()
  `);
  check('图片按图渲染（不再是乱码）', img.ok && img.has && img.src.startsWith('data:image/') && img.w > 0, img);
  check('图片预览下隐藏翻译控件', img.modeHidden === true, { hidden: img.modeHidden });
  await shot('41-image-preview');

  const code = await js(`
    (async () => {
      const btn = document.querySelector('#fileList [data-name$=".json"]');
      if (!btn) return { ok: false, reason: 'no json' };
      btn.click();
      await window.__T.wait(700);
      const lines = document.querySelectorAll('#proseSrc .filecode .code-line');
      const first = document.querySelector('#proseSrc .filecode .code-ln');
      return {
        ok: true,
        lines: lines.length,
        firstLn: first ? first.textContent.trim() : '',
        hasCode: !!document.querySelector('#proseSrc .filecode')
      };
    })()
  `);
  check('代码文件带行号渲染', code.ok && code.hasCode && code.lines > 3 && code.firstLn === '1', code);
  await shot('42-code-preview');

  await js(`(async()=>{ document.querySelector('#rBack')?.click(); await window.__T.wait(400); return 1; })()`);

  /* ---------------- 2. 使用说明（Markdown） ---------------- */
  const help = await js(`
    (async () => {
      window.__goto('settings');
      await window.__T.wait(500);
      const btn = document.querySelector('#replayTour');
      if (!btn) return { ok: false, reason: 'no button' };
      btn.click();
      const ok = await window.__T.until(() => document.querySelector('.helpdoc h1'), 5000);
      const h1 = document.querySelector('.helpdoc h1');
      const sections = document.querySelectorAll('.helpdoc h2').length;
      const rows = document.querySelectorAll('.helpdoc table tr').length;
      return { ok, title: h1 ? h1.textContent.trim() : '', sections, rows };
    })()
  `);
  check('首次帮助是一份 Markdown 文档', help.ok && /使用说明/.test(help.title) && help.sections >= 4, help);
  await shot('43-help');
  await js(`(async () => {
    const b = [...document.querySelectorAll('.dialog__foot .btn')].find((x) => /知道了/.test(x.textContent));
    if (b) b.click();
    await window.__T.wait(300);
    return 1;
  })()`);

  /* ---------------- 3. 工具探测 ---------------- */
  const detect = await js(`
    (async () => {
      const btn = document.querySelector('#redetect');
      if (!btn) return { ok: false, reason: 'no button' };
      btn.click();
      await window.__T.until(() => document.querySelectorAll('.detect__row').length > 0, 12000);
      const rows = [...document.querySelectorAll('.detect__row')];
      const names = rows.map((r) => (r.querySelector('strong') || {}).textContent || '');
      document.querySelector('.scrim [data-close]')?.click();
      await window.__T.wait(300);
      return { ok: rows.length > 0, rows: rows.length, names };
    })()
  `);
  check('能探测出本机已装的智能体工具', detect.ok, detect);
  await shot('44-detect');

  /* ---------------- 4. 分享 ---------------- */
  const exp = await js(`window.atelier.call('share:export', { path: ${JSON.stringify(SHARE_FILE)} })`);
  let fileOk = false;
  let head = null;
  try {
    const raw = fs.readFileSync(SHARE_FILE, 'utf8');
    head = JSON.parse(raw);
    fileOk = head.kind === 'skill-atelier-share' && Array.isArray(head.products);
  } catch { /* ignore */ }
  check('导出分享包（JSON 落盘且结构正确）', exp && exp.ok && fileOk, {
    ok: exp && exp.ok, error: exp && exp.error, kind: head && head.kind, products: head && head.products && head.products.length
  });

  const imp = await js(`window.atelier.call('share:import', { path: ${JSON.stringify(SHARE_FILE)} })`);
  check('导入分享包（合并、不报错）', imp && imp.ok, { ok: imp && imp.ok, error: imp && imp.error, stat: imp && imp.data });

  const combo = await js(`
    (async () => {
      const r = await window.atelier.call('config:get', {});
      const id = (r.data.skills || [])[0] && r.data.skills[0].id;
      const c = await window.atelier.call('combo:create', { name: '分享测试组合', skillIds: [id], note: 'v16' });
      if (!c.ok) return { ok: false, error: c.error };
      const t = await window.atelier.call('share:comboText', { id: c.data.id });
      return { ok: t.ok, text: t.data && t.data.text };
    })()
  `);
  check('组合可导出为 Markdown 清单', combo.ok && /# 分享测试组合/.test(combo.text || '') && /`/.test(combo.text || ''), {
    ok: combo.ok, head: (combo.text || '').slice(0, 60)
  });

  /* ---------------- 5. 更新检查（未配置仓库） ---------------- */
  const upd = await js(`window.atelier.call('update:check', {})`);
  check('未配置更新仓库时给出明确提示', upd && upd.ok === false && /仓库/.test(String(upd.error)), {
    ok: upd && upd.ok, error: upd && upd.error
  });

  try { fs.unlinkSync(SHARE_FILE); } catch { /* ignore */ }

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v16',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    notes
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v16.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v16.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
