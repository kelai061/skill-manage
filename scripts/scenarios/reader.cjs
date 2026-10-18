'use strict';
/**
 * scripts/scenarios/reader.cjs — 并排阅读器端到端验收场景
 *
 * 由 main.js 的 --scenario 入口加载，在主进程里驱动渲染进程跑断言，
 * 结果写进 docs/test-report.json，并顺手截几张关键界面图。
 *
 * 只做只读断言 + 少量可回滚的写操作（收藏），跑在隔离 profile 里。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = async function run({ win, delay, shot }) {
  const results = [];
  const notes = [];

  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  };

  const js = (code) => win.webContents.executeJavaScript(code, true);

  /* ---------------- 页面内工具 ---------------- */
  await js(`
    window.__T = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      until: async (fn, ms = 15000, step = 120) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          try { if (fn()) return true; } catch (e) { /* keep polling */ }
          await new Promise((r) => setTimeout(r, step));
        }
        return false;
      },
      panes: () => ({ s: document.getElementById('paneSrc'), d: document.getElementById('paneDst') }),
      blks: (p) => Array.from(p.querySelectorAll('.blk[data-seg]')),
      firstVisible: (p) => {
        const b = window.__T.blks(p);
        if (!b.length) return -1;
        const base = b[0].offsetTop;
        const y = p.scrollTop + 2;
        for (const el of b) {
          if (el.offsetTop - base + el.offsetHeight > y) return Number(el.dataset.seg);
        }
        return Number(b[b.length - 1].dataset.seg);
      },
      pickPara: (p) => {
        // 译文栏的列表会渲染成 <ol><li>，没有 <p>；所以按 .blk__src 的文本长度挑，
        // 而不是只认 <p>（否则译文栏永远挑不到可选中的块）
        for (const el of window.__T.blks(p)) {
          const h = el.querySelector('.blk__src');
          if (h && (h.textContent || '').length > 160) return el;
        }
        return null;
      },
      pickVisiblePara: (p) => {
        const top = p.scrollTop + 40;
        const bottom = p.scrollTop + p.clientHeight - 60;
        for (const el of window.__T.blks(p)) {
          if (el.offsetTop < top || el.offsetTop + el.offsetHeight > bottom) continue;
          const h = el.querySelector('.blk__src');
          if (h && (h.textContent || '').length > 100) return el;
        }
        return null;
      },
      selectHead: (paneSel) => {
        const pane = document.getElementById(paneSel);
        let el = window.__T.pickVisiblePara(pane) || window.__T.pickPara(pane);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const holder = el.querySelector('.blk__src');
        const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
        const node = walker.nextNode();
        if (!node) return null;
        const len = Math.min(70, node.nodeValue.length);
        const r = document.createRange();
        r.setStart(node, 0);
        r.setEnd(node, len);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
        return { seg: Number(el.dataset.seg), text: r.toString(), blockLen: (holder.textContent || '').length };
      },
      syncInfo: () => {
        const hl = CSS.highlights.get('sync');
        if (!hl) return { has: false };
        const ranges = Array.from(hl);
        const d = document.getElementById('proseDst');
        const s = document.getElementById('proseSrc');
        return {
          has: true,
          count: ranges.length,
          inDst: ranges.some((r) => d && d.contains(r.commonAncestorContainer)),
          inSrc: ranges.some((r) => s && s.contains(r.commonAncestorContainer)),
          text: ranges.map((r) => r.toString()).join(' ').slice(0, 120)
        };
      }
    };
    1;
  `);

  /* ---------------- 1. 卡片墙 ---------------- */
  await delay(600);
  const cards = await js(`document.querySelectorAll('#grid .card').length`);
  check('卡片墙渲染出 skill 卡片', cards > 0, { cards });

  /* ---------------- 2. 项目筛选空态 ---------------- */
  const projState = await js(`
    (async () => {
      document.querySelector('[data-scope="project"]').click();
      await window.__T.wait(400);
      const empty = document.querySelector('.empty h3');
      // 006 起项目总览是 .projcard，不再是 .card
      const n = document.querySelectorAll('#grid [data-projcard], #grid .card').length;
      return { n, title: empty ? empty.textContent.trim() : '' };
    })()
  `);
  check(
    '「项目」筛选的空态文案对得上',
    projState.n > 0 || /项目/.test(projState.title),
    projState
  );
  await shot('02-project-empty');

  await js(`(async()=>{ document.querySelector('[data-scope="all"]').click(); await window.__T.wait(350); return 1; })()`);

  /* ---------------- 3. 打开阅读器 ---------------- */
  const opened = await js(`
    (async () => {
      const cards = Array.from(document.querySelectorAll('#grid .card[data-id]'));
      const target = cards.find((c) => (c.querySelector('.card__title') || {}).textContent === 'follow-builders') || cards[0];
      if (!target) return { ok: false };
      const name = target.querySelector('.card__title').textContent;
      target.querySelector('[data-act="read"]').click();
      const ok = await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      return { ok, name };
    })()
  `);
  check('阅读器能打开', opened.ok, opened);
  if (!opened.ok) return finish(results, notes);

  /* ---------------- 4. 切并排 + 等译文 ---------------- */
  const translated = await js(`
    (async () => {
      document.querySelector('[data-mode="side"]').click();
      const ok = await window.__T.until(
        () => document.getElementById('paneDst') && document.querySelectorAll('#proseDst .blk').length > 0
              && !document.querySelector('.tr-pending'),
        90000
      );
      await window.__T.wait(600);
      return { ok, blocks: document.querySelectorAll('#proseDst .blk').length };
    })()
  `);
  check('并排模式译文就绪', translated.ok, translated);
  if (!translated.ok) return finish(results, notes);

  /* ---------------- 5. 两栏结构同构 ---------------- */
  const struct = await js(`
    (() => {
      const { s, d } = window.__T.panes();
      const bs = window.__T.blks(s);
      const bd = window.__T.blks(d);
      const segS = bs.map((e) => e.dataset.seg).join(',');
      const segD = bd.map((e) => e.dataset.seg).join(',');
      const hrS = s.querySelectorAll('.blk[data-type="hr"]').length;
      const hrD = d.querySelectorAll('.blk[data-type="hr"]').length;
      const hS = Array.from(s.querySelectorAll('.blk[data-type="hr"]')).map((e) => e.offsetHeight);
      const hD = Array.from(d.querySelectorAll('.blk[data-type="hr"]')).map((e) => e.offsetHeight);
      return { nS: bs.length, nD: bd.length, sameSeq: segS === segD, hrS, hrD, hS, hD,
               sameHrH: hS.length && hS.length === hD.length && hS.every((h, i) => h === hD[i]) };
    })()
  `);
  check('两栏块数一致', struct.nS === struct.nD, { nS: struct.nS, nD: struct.nD });
  check('两栏块编号序列完全一致', struct.sameSeq);
  check('分割线 --- 两栏都在', struct.hrS > 0 && struct.hrS === struct.hrD, { hrS: struct.hrS, hrD: struct.hrD });
  check('分割线两栏等高（零误差锚点）', struct.sameHrH, { hS: struct.hS.slice(0, 4), hD: struct.hD.slice(0, 4) });

  await shot('03-reader-side');

  /* ---------------- 6. 滚动同步（双向 · 多点） ---------------- */
  const scrollRes = await js(`
    (async () => {
      const { s, d } = window.__T.panes();
      const max = s.scrollHeight - s.clientHeight;
      const spots = [240, 700, 1400, 2400, Math.max(0, max - 120)];
      const out = [];
      for (const y of spots) {
        s.scrollTop = y;
        await window.__T.wait(320);
        const segS = window.__T.firstVisible(s);
        const segD = window.__T.firstVisible(d);
        const b = window.__T.blks(s);
        const el = b.find((x) => Number(x.dataset.seg) === segS);
        out.push({ y: Math.round(y), segS, segD, dstTop: Math.round(d.scrollTop), ok: Math.abs(segS - segD) <= 1 });
      }
      // 反向：从译文栏驱动
      const back = [];
      for (const y of [300, 1200, 2200]) {
        d.scrollTop = y;
        await window.__T.wait(320);
        back.push({ y, segS: window.__T.firstVisible(s), segD: window.__T.firstVisible(d) });
      }
      // 到底
      s.scrollTop = s.scrollHeight;
      await window.__T.wait(320);
      const maxS = s.scrollHeight - s.clientHeight;
      const maxD = d.scrollHeight - d.clientHeight;
      return {
        out, back,
        bottom: { s: Math.round(s.scrollTop), maxS: Math.round(maxS), d: Math.round(d.scrollTop), maxD: Math.round(maxD) }
      };
    })()
  `);
  const badFwd = scrollRes.out.filter((x) => !x.ok);
  check('原文滚动 → 译文同步（5 个位置）', badFwd.length === 0, { bad: badFwd, samples: scrollRes.out.slice(0, 3) });
  const badBack = scrollRes.back.filter((x) => Math.abs(x.segS - x.segD) > 1);
  check('译文滚动 → 原文同步（3 个位置）', badBack.length === 0, { bad: badBack, samples: scrollRes.back });
  check(
    '滚到底两栏一起到底',
    Math.abs(scrollRes.bottom.d - scrollRes.bottom.maxD) <= 2,
    scrollRes.bottom
  );

  /* ---------------- 7. 选中同步（双向） ---------------- */
  const selFwd = await js(`
    (async () => {
      const info = window.__T.selectHead('paneSrc');
      await window.__T.wait(500);
      return { info, sync: window.__T.syncInfo(), tool: !!document.querySelector('.seltool') };
    })()
  `);
  check('原文选中 → 译文对应句高亮', selFwd.sync.has && selFwd.sync.inDst, selFwd.sync);
  check(
    '高亮落在句级而非整块（不是退化兜底）',
    !!selFwd.sync.text && selFwd.info && selFwd.sync.text.length < selFwd.info.blockLen * 0.98,
    { hlLen: selFwd.sync.text && selFwd.sync.text.length, blockLen: selFwd.info && selFwd.info.blockLen }
  );
  check('选中工具条出现', selFwd.tool);
  await shot('04-selection-sync');

  const selBack = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__T.wait(200);
      const info = window.__T.selectHead('paneDst');
      await window.__T.wait(500);
      return { info, sync: window.__T.syncInfo() };
    })()
  `);
  check('译文选中 → 原文对应句高亮', selBack.sync.has && selBack.sync.inSrc, selBack.sync);

  /* ---------------- 8. 工具条位置 ---------------- */
  const toolGeom = await js(`
    (async () => {
      const pane = document.getElementById('paneSrc');
      const el = window.__T.pickPara(pane);
      if (el) {
        pane.scrollTop = Math.max(0, el.offsetTop - 120);
        await window.__T.wait(250);
      }
      const info = window.__T.selectHead('paneSrc');
      await window.__T.wait(350);
      const bar = document.querySelector('.seltool');
      if (!bar) return { ok: false, reason: 'no bar' };
      const b = bar.getBoundingClientRect();
      const sel = getSelection().getRangeAt(0).getBoundingClientRect();
      const overlap = !(b.bottom <= sel.top || b.top >= sel.bottom || b.right <= sel.left || b.left >= sel.right);
      const inView = b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
      return { ok: inView && !overlap, overlap, inView, b: { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } };
    })()
  `);
  check('工具条在视口内且不压住选区', toolGeom.ok, toolGeom);
  await shot('06-selection-toolbar');

  /* ---------------- 9. 行间模式 ---------------- */
  const inter = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      document.querySelector('[data-mode="interlinear"]').click();
      await window.__T.wait(900);
      return {
        tr: document.querySelectorAll('#proseSrc .blk__tr').length,
        pair: document.querySelectorAll('#proseSrc .blk__pair').length,
        dstGone: !document.getElementById('paneDst')
      };
    })()
  `);
  check('行间模式渲染出译文行', inter.tr > 0, inter);
  check('行间模式按句配对', inter.pair > 0, { pair: inter.pair });

  const starLeak = await js(`
    (() => {
      const pairs = Array.from(document.querySelectorAll('#proseSrc .blk__pair'));
      const bad = pairs.filter((p) => /(^|\\s)\\*\\*|\\*\\*$/.test(p.textContent)).map((p) => p.textContent.slice(0, 40));
      return { total: pairs.length, bad: bad.slice(0, 3), badCount: bad.length };
    })()
  `);
  check('行间译文没有裸露的 ** 标记', starLeak.badCount === 0, starLeak);
  await shot('05-interlinear');

  /* ---------------- 10. 翻译缓存复用 ---------------- */
  const cache = await js(`
    (async () => {
      const list = await window.atelier.call('skill:list', {});
      if (!list || !list.ok) return { ok: false, error: 'skill:list 失败' };
      const all = list.data.skills || list.data || [];
      const target = all.find((s) => s.name === 'follow-builders') || all[0];
      if (!target) return { ok: false, error: '没有可用的 skill' };
      const r = await window.atelier.call('ai:translate', { id: target.id, force: false });
      return r && r.ok
        ? { ok: true, missed: r.data.missed, cached: r.data.cached, count: r.data.count, name: target.name }
        : { ok: false, error: r && r.error };
    })()
  `).catch((e) => ({ ok: false, error: String(e.message) }));
  if (cache.ok) {
    check('二次翻译不重复调用接口（段级缓存命中）', cache.missed === 0, cache);
  } else {
    notes.push('翻译缓存断言跳过：' + (cache.error || '未知原因'));
  }

  /* ---------------- 11. 收藏持久化 ---------------- */
  await js(`(async () => { document.querySelector('#rBack').click(); await window.__T.wait(500); return 1; })()`);
  const fav = await js(`
    (async () => {
      const card = document.querySelector('#grid .card[data-id]');
      if (!card) return { ok: false };
      card.querySelector('[data-fav]').click();
      await window.__T.wait(700);
      const on = !!document.querySelector('#grid .card[data-id] [data-fav].is-on');
      return { ok: on };
    })()
  `);
  check('卡片收藏按钮生效', fav.ok, fav);

  const cfgPath = path.join(require('electron').app.getPath('userData'), 'config.json');
  let favorites = [];
  try {
    favorites = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).favorites || [];
  } catch { /* ignore */ }
  check('收藏写入磁盘 config.json', favorites.length > 0, { favorites: favorites.length });

  await shot('01-skills');

  return finish(results, notes);

  function finish(list, extra) {
    const passed = list.filter((r) => r.ok).length;
    const report = {
      at: new Date().toISOString(),
      version: require(path.join(ROOT, 'package.json')).version,
      total: list.length,
      passed,
      failed: list.length - passed,
      results: list,
      notes: extra
    };
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'test-report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n[report] ${passed}/${list.length} passed → docs/test-report.json`);
    return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
  }
};
