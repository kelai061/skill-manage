'use strict';
/**
 * scripts/scenarios/v14.cjs — 第 005 轮验收
 *
 * 1. 卡片底部的复制按钮（复制 skill 目录路径）
 * 2. 嵌套 skill：技能集收成一张卡、下钻可见、可手动移出
 * 3. 中文排版：译文列表按项渲染、中英文之间补空格
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
      until: async (fn, ms = 15000, step = 120) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, step)); }
        return false;
      }
    };
    1;
  `);

  await delay(700);

  /* ---------------- 1. 卡片复制按钮 ---------------- */
  const copyInfo = await js(`
    (() => {
      const btn = document.querySelector('#grid .card [data-act="copy"]');
      if (!btn) return { ok: false };
      const card = btn.closest('.card');
      // 只数真实 skill 卡：技能集汇总卡没有复制按钮（它不是一个 skill）
      return { ok: true, cards: document.querySelectorAll('#grid .card[data-id]').length,
               withCopy: document.querySelectorAll('#grid .card[data-id] [data-act="copy"]').length };
    })()
  `);
  check('每张 skill 卡片都有复制按钮', copyInfo.ok && copyInfo.withCopy === copyInfo.cards, copyInfo);

  if (copyInfo.ok) {
    // Electron 44 的 clipboard.readText 返回 Promise，必须 await（踩过：[object Promise]）
    await clipboard.writeText('');
    const dir = await js(`
      (async () => {
        const btn = document.querySelector('#grid .card [data-act="copy"]');
        const id = btn.closest('.card').dataset.id;
        btn.click();
        await window.__T.wait(500);
        const r = await window.atelier.call('config:get', {});
        const s = (r.data.skills || []).find((x) => x.id === id);
        return s ? s.dir : '';
      })()
    `);
    const got = String((await clipboard.readText()) || '');
    check('点复制按钮把目录路径写进剪贴板', !!dir && got === dir, { got: got.slice(0, 60), dir: dir.slice(0, 60) });
  }

  /* ---------------- 2. 嵌套 skill / 技能集 ---------------- */
  // 先重扫一遍：嵌套关系是扫描时标注的，旧索引里没有这些字段
  await js(`(async () => {
    const r = await window.atelier.call('config:get', {});
    for (const p of (r.data.products || [])) {
      if ((p.projects || []).length) await window.atelier.call('product:rescan', { id: p.id });
    }
    await window.__refreshAll();
    await window.__T.wait(600);
    return 1;
  })()`);

  await js(`(async () => {
    const r = await window.atelier.call('config:get', {});
    const nested = (r.data.skills || []).filter((s) => s.nested);
    window.__nestedInfo = {
      total: (r.data.skills || []).length,
      nested: nested.length,
      collections: [...new Set(nested.map((s) => s.collectionName).filter(Boolean))],
      sample: nested.slice(0, 3).map((s) => ({ id: s.id, name: s.name, col: s.collectionName }))
    };
    await window.__refreshAll();
    await window.__T.wait(500);
    return 1;
  })()`);

  const nestedInfo = await js(`window.__nestedInfo`);
  check('扫描识别出嵌套 skill', nestedInfo.nested > 0, { total: nestedInfo.total, nested: nestedInfo.nested, collections: nestedInfo.collections });

  const colView = await js(`
    (async () => {
      const cols = [...document.querySelectorAll('[data-collection]')];
      if (!cols.length) return { ok: false, reason: 'no collection card' };
      const before = document.querySelectorAll('#grid .card').length;
      cols[0].click();
      await window.__T.wait(600);
      const cards = [...document.querySelectorAll('#grid .card')];
      return {
        ok: cards.length > 0,
        before,
        after: cards.length,
        nestedBadges: document.querySelectorAll('#grid .badge--nested').length,
        filterChip: [...document.querySelectorAll('.chip--removable')].map((x) => x.textContent.trim())
      };
    })()
  `);
  check('技能集收成一张卡，点开能看到里面的 skill', colView.ok && colView.after > 1, colView);
  check('集合内的 skill 带「嵌套」标记', colView.nestedBadges > 0, { badges: colView.nestedBadges });
  await shot('21-collection-drill');

  const detach = await js(`
    (async () => {
      const card = document.querySelector('#grid .card');
      const id = card.dataset.id;
      const r = await window.atelier.call('skill:detach', { id, detach: true });
      if (!r || !r.ok) return { ok: false, error: r && r.error };
      await window.__refreshAll();
      // 清掉下钻，回到全部，看它是否出现在顶层
      document.querySelector('[data-unfilter="collection"]')?.click();
      await window.__T.wait(600);
      const shown = !!document.querySelector('#grid .card[data-id="' + id + '"]');
      return { ok: shown, id };
    })()
  `);
  check('手动「移出嵌套」后出现在顶层', detach.ok, detach);

  // 复原
  await js(`(async () => {
    await window.atelier.call('skill:detach', { id: ${JSON.stringify(detach.id || '')}, detach: false });
    await window.__refreshAll();
    return 1;
  })()`);

  /* ---------------- 3. 中文排版 ---------------- */
  const open = await js(`
    (async () => {
      document.querySelector('[data-scope="all"]').click();
      await window.__T.wait(500);
      const cards = [...document.querySelectorAll('#grid .card')];
      const target = cards.find((c) => (c.querySelector('.card__title') || {}).textContent === 'obsidian-file-color-byself') || cards[0];
      target.querySelector('[data-act="read"]').click();
      const ok = await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      if (!ok) return { ok: false };
      document.querySelector('[data-mode="side"]').click();
      const tr = await window.__T.until(
        () => document.getElementById('paneDst') && document.querySelectorAll('#proseDst .blk').length > 0
              && !document.querySelector('.tr-pending'),
        120000
      );
      await window.__T.wait(600);
      const dst = document.getElementById('proseDst');
      const lis = dst.querySelectorAll('li').length;
      const ps = [...dst.querySelectorAll('p')];
      // 中文紧贴拉丁字母 = 没加空格（代码块与行内代码除外）
      const bad = [];
      for (const p of ps) {
        const clone = p.cloneNode(true);
        clone.querySelectorAll('code, pre').forEach((c) => c.remove());
        const t = clone.textContent || '';
        const m = t.match(/[\\u4e00-\\u9fa5][A-Za-z]/);
        if (m) bad.push(t.slice(Math.max(0, m.index - 8), m.index + 12));
      }
      return { ok: true, lis, ps: ps.length, bad: bad.slice(0, 3), badCount: bad.length };
    })()
  `);
  check('译文列表渲染成真正的列表项（不再是压成一段）', open.ok && open.lis >= 2, { lis: open.lis, ps: open.ps });
  check('译文中英文之间有空格', open.ok && open.badCount === 0, { bad: open.bad });
  await shot('22-dst-typography');

  await js(`(async()=>{ document.querySelector('#rBack')?.click(); await window.__T.wait(400); return 1; })()`);

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v14',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    notes
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v14.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v14.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
