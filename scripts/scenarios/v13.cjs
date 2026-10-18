'use strict';
/**
 * scripts/scenarios/v13.cjs — 第 004 轮验收：项目视图 / 卡片交互 / 筛选折叠 / 提示气泡
 *
 * 覆盖用户这轮提的四件事：
 *   1. 点卡片不再直接打开阅读器，只有右下角「阅读」按钮才打开
 *   2. 项目 skill 按「项目」分组列出，0 个的项目也要出现
 *   3. 从 agent 工具自身的数据里发现项目（以 Antigravity 为例）
 *   4. 提示气泡不再被卡片裁切 / 不在窗口顶上留黑边；筛选栏收敛
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ANTIGRAVITY = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe');

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
      },
      inView: (r) => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    };
    1;
  `);

  await delay(700);

  /* ---------------- 1. 卡片点击 = 选中，不打开阅读器 ---------------- */
  const clickBehavior = await js(`
    (async () => {
      // 卡片墙最前面可能是「技能集」汇总卡（没有 data-id），这里要挑一张真实 skill 卡
      const card = document.querySelector('#grid .card[data-id]');
      if (!card) return { ok: false, reason: 'no card' };
      card.click();
      await window.__T.wait(500);
      return {
        readerOpened: !!document.getElementById('readerRoot'),
        selected: card.classList.contains('card--selected') || document.querySelectorAll('.card--selected').length > 0,
        selectBar: !!document.getElementById('selectbar')
      };
    })()
  `);
  check('点卡片不再打开阅读器', clickBehavior.readerOpened === false, clickBehavior);
  check('点卡片改为选中并浮出操作栏', clickBehavior.selected && clickBehavior.selectBar, clickBehavior);

  const readBtn = await js(`
    (async () => {
      document.querySelectorAll('.card--selected').forEach((c) => c.querySelector('[data-check]').click());
      await window.__T.wait(300);
      const readBtn = document.querySelector('#grid .card [data-act="read"]');
      if (!readBtn) return { ok: false, reason: 'no read btn' };
      readBtn.click();
      const ok = await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      const reader = document.getElementById('readerRoot');
      if (reader) document.querySelector('#rBack').click();
      await window.__T.wait(400);
      return { ok, closed: !document.getElementById('readerRoot') };
    })()
  `);
  check('右下角「阅读」按钮仍能打开阅读器', readBtn.ok, readBtn);

  /* ---------------- 2. 筛选栏折叠 ---------------- */
  const bar = await js(`
    (() => {
      const bar = document.querySelector('.filterbar');
      if (!bar) return { ok: false };
      return {
        ok: true,
        chips: bar.querySelectorAll('.chip').length,
        hasMenu: !!bar.querySelector('[data-filtermenu]'),
        hasSeg: !!bar.querySelector('#scopeBar'),
        height: Math.round(bar.getBoundingClientRect().height)
      };
    })()
  `);
  check('筛选栏收敛成一行（chip ≤ 6）', bar.ok && bar.chips <= 6 && bar.hasMenu && bar.hasSeg, bar);
  await shot('11-filterbar');

  /* ---------------- 5. 收录 Antigravity + 自动发现项目 ---------------- */
  let antigravityExists = false;
  try { antigravityExists = fs.existsSync(ANTIGRAVITY); } catch { /* ignore */ }

  if (!antigravityExists) {
    notes.push('未找到 Antigravity 安装路径，跳过收录测试：' + ANTIGRAVITY);
  } else {
    const added = await js(`
      (async () => {
        const r = await window.atelier.call('product:add', {
          launchPath: ${JSON.stringify(ANTIGRAVITY)},
          name: 'Antigravity'
        });
        if (!r || !r.ok) return { ok: false, error: r && r.error };
        const p = r.data.product;
        return {
          ok: true,
          projects: (p.projects || []).length,
          auto: (p.projects || []).filter((x) => x.auto).length,
          skills: r.data.skills.length,
          global: r.data.skills.filter((s) => s.scope === 'global').length,
          sample: (p.projects || []).slice(0, 5).map((x) => x.name)
        };
      })()
    `).catch((e) => ({ ok: false, error: String(e.message) }));

    check('收录 Antigravity 产品', added.ok, added);
    check('从 Antigravity 自身数据里发现项目（≥3 个）', added.ok && added.projects >= 3, { projects: added.projects, sample: added.sample });
    check('发现的项目被标记为「自动」', added.ok && added.auto >= 3 && added.auto <= added.projects, { auto: added.auto, total: added.projects });
    check('Antigravity 内置 skill 被收进全局', added.ok && added.skills > 0, { skills: added.skills, global: added.global });

    await js(`(async () => { await window.__refreshAll(); return 1; })()`);

    const listed = await js(`
      (async () => {
        const r = await window.atelier.call('config:get', {});
        const p = (r.data.products || []).find((x) => x.name === 'Antigravity');
        return { found: !!p, projects: p ? (p.projects || []).length : 0 };
      })()
    `);
    check('产品写入配置并持久化', listed.found && listed.projects > 0, listed);
  }


  /* ---------------- 3. 项目视图：按项目分组、0 个也列 ---------------- */
  const projView = await js(`
    (async () => {
      document.querySelector('[data-scope="project"]').click();
      await window.__T.wait(700);
      // 006 起：项目 = 一张卡（默认折叠），不再展开成区块
      const cards = [...document.querySelectorAll('#grid [data-projcard]')];
      return {
        sections: cards.length,
        names: cards.slice(0, 6).map((s) => s.querySelector('.projcard__name').textContent.trim()),
        zero: cards.filter((s) => /0 个 skill/.test(s.textContent)).length,
        emptyBlocks: cards.filter((s) => /0 个 skill/.test(s.textContent)).length,
        cards: document.querySelectorAll('#grid .card[data-id]').length
      };
    })()
  `);
  check('项目视图按项目出卡', projView.sections > 0, projView);
  check('没有 skill 的项目也列出来（显示 0）', projView.zero >= 1 && projView.emptyBlocks >= 1, { zero: projView.zero, empty: projView.emptyBlocks });
  await shot('12-project-groups');

  /* ---------------- 4. 提示气泡不越界 ---------------- */
  const tip = await js(`
    (async () => {
      document.querySelector('[data-scope="all"]').click();
      await window.__T.wait(500);
      const btn = document.querySelector('#grid .card [data-act="more"]');
      if (!btn) return { ok: false, reason: 'no btn' };
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await window.__T.wait(500);
      const el = document.querySelector('.tip.is-on');
      if (!el) return { ok: false, reason: 'no tip' };
      const r = el.getBoundingClientRect();
      return { ok: window.__T.inView(r), text: el.textContent, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
    })()
  `);
  check('提示气泡渲染在视口内（不再被卡片裁切）', tip.ok, tip);

  const tipTop = await js(`
    (async () => {
      document.querySelector('.tip.is-on')?.classList.remove('is-on');
      const anchor = document.querySelector('.appbar .iconbtn, .appbar button');
      if (!anchor) return { ok: false, reason: 'no appbar btn' };
      anchor.setAttribute('data-tip', '测试气泡');
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await window.__T.wait(500);
      const el = document.querySelector('.tip.is-on');
      if (!el) return { ok: false, reason: 'no tip' };
      const r = el.getBoundingClientRect();
      anchor.removeAttribute('data-tip');
      return { ok: window.__T.inView(r), top: Math.round(r.top) };
    })()
  `);
  check('贴顶按钮的气泡会翻到下方（无黑边）', tipTop.ok, tipTop);

  /* ---------------- 6. 阅读器顶栏气泡不越界（黑边） ---------------- */
  const readerTip = await js(`
    (async () => {
      const readBtn = document.querySelector('#grid .card [data-act="read"]');
      if (!readBtn) return { ok: false, reason: 'no read btn' };
      readBtn.click();
      await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      await window.__T.wait(600);
      const btn = document.querySelector('#fsBtn');
      if (!btn) return { ok: false, reason: 'no btn' };
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await window.__T.wait(500);
      const el = document.querySelector('.tip.is-on');
      if (!el) return { ok: false, reason: 'no tip' };
      const r = el.getBoundingClientRect();
      const bar = document.querySelector('.reader__bar').getBoundingClientRect();
      return { ok: window.__T.inView(r) && r.top >= 8, top: Math.round(r.top), barH: Math.round(bar.height) };
    })()
  `);
  check('阅读器顶栏气泡不越界（无黑边）', readerTip.ok, readerTip);
  await shot('14-reader-toolbar-tip');
  await js(`(async()=>{ document.querySelector('#rBack')?.click(); await window.__T.wait(400); return 1; })()`);

  /* ---------------- 收尾 ---------------- */
  await js(`(async()=>{ if (window.__goto) window.__goto('products'); await window.__T.wait(600); return 1; })()`);
  await shot('13-products');

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v13',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    notes
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v13.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v13.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
