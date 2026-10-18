'use strict';
/**
 * scripts/scenarios/v15.cjs — 第 006 轮验收
 *
 * 1. 分类 UI：全部计数不含被折叠的嵌套；顶部分段含「分组」；分组视图出卡
 * 2. 项目视图：项目 = 一张卡（默认折叠），0 个也出卡，点卡进入
 * 3. 双语对照：词级对齐 —— 选中一个单词，对侧精确高亮对应的词，并给出「词 → 译词」
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

  /* ---------------- 1. 分类 UI：计数与分组 ---------------- */
  const counts = await js(`
    (async () => {
      document.querySelector('[data-scope="all"]').click();
      await window.__T.wait(600);
      const r = await window.atelier.call('config:get', {});
      const skills = r.data.skills || [];
      const detached = new Set(r.data.detachedSkills || []);
      const top = skills.filter((s) => !s.nested || detached.has(s.id));
      const segs = [...document.querySelectorAll('#scopeBar .segmented__item')]
        .map((b) => ({ k: b.dataset.scope, n: Number((b.querySelector('.seg__n') || {}).textContent || 0) }));
      const flat = [...document.querySelectorAll('#grid .card[data-id]')];
      const nestedFlat = flat.filter((c) => {
        const s = skills.find((x) => x.id === c.dataset.id);
        return s && s.nested && !detached.has(s.id);
      }).length;
      return {
        segs,
        top: top.length,
        total: skills.length,
        flat: flat.length,
        nestedFlat,
        collections: document.querySelectorAll('#grid [data-collection]').length
      };
    })()
  `);
  const allSeg = counts.segs.find((x) => x.k === 'all');
  check('「全部」计数不含被折叠的嵌套', !!allSeg && allSeg.n === counts.top, counts);
  check('「全部」里不再平铺嵌套 skill', counts.nestedFlat === 0, { nestedFlat: counts.nestedFlat, collections: counts.collections });

  const gv = await js(`
    (async () => {
      document.querySelector('[data-scope="groups"]').click();
      await window.__T.wait(600);
      return {
        segs: [...document.querySelectorAll('#scopeBar .segmented__item')].map((b) => b.dataset.scope),
        cards: document.querySelectorAll('#grid [data-groupcard]').length,
        flat: document.querySelectorAll('#grid .card[data-id]').length
      };
    })()
  `);
  check('顶部分段控件含「分组」', gv.segs.includes('groups'), gv);
  check('分组视图按分组出卡（默认折叠，不铺 skill）', gv.cards >= 1 && gv.flat === 0, gv);
  await shot('31-groups');

  /* ---------------- 2. 项目视图：卡片化、默认折叠 ---------------- */
  const pv = await js(`
    (async () => {
      document.querySelector('[data-scope="project"]').click();
      await window.__T.wait(700);
      const cards = [...document.querySelectorAll('#grid [data-projcard]')];
      const zero = cards.filter((c) => /0 个 skill/.test(c.textContent)).length;
      return {
        before: cards.length,
        zero,
        nestedLists: document.querySelectorAll('#grid .card[data-id]').length,
        secs: document.querySelectorAll('.projsec').length,
        id: cards[0] ? cards[0].dataset.projcard : ''
      };
    })()
  `);
  check('项目以卡片展示（不再展开成区块）', pv.before > 0 && pv.secs === 0, pv);
  check('项目总览默认折叠（不铺 skill 卡）', pv.nestedLists === 0, { cards: pv.nestedLists });
  check('0 个 skill 的项目也只显示名字卡', pv.zero >= 1, { zero: pv.zero });
  await shot('32-projects');

  const drill = await js(`
    (async () => {
      document.querySelector('#grid [data-projcard]').click();
      await window.__T.wait(800);
      const chips = [...document.querySelectorAll('.chip--removable')].map((x) => x.textContent.trim());
      // 进入某项目后，不该再画出别的项目的技能集
      const r = await window.atelier.call('config:get', {});
      const pid = ${JSON.stringify('')} || (chips.find((t) => t.startsWith('项目：')) || '').replace('项目：', '');
      const pr = (r.data.products || []).flatMap((p) => p.projects || []).find((x) => x.name === pid);
      const ids = new Set((r.data.skills || []).filter((s) => pr && s.projectId === pr.id && s.collectionId).map((s) => s.collectionId));
      return {
        drilled: chips.some((t) => t.startsWith('项目：')),
        chip: chips,
        collections: document.querySelectorAll('#grid [data-collection]').length,
        expectCollections: ids.size
      };
    })()
  `);
  check('点项目卡进入该项目', drill.drilled, { chip: drill.chip });
  check('进入项目后只显示该项目的技能集', drill.collections === drill.expectCollections, drill);
  await shot('32b-project-drill');

  /* ---------------- 3. 词级对齐 ---------------- */
  const word = await js(`
    (async () => {
      document.querySelector('[data-scope="all"]').click();
      await window.__T.wait(500);
      const btn = document.querySelector('#grid .card[data-id] [data-act="read"]');
      if (!btn) return { ok: false, reason: 'no read btn' };
      btn.click();
      const ok = await window.__T.until(() => document.getElementById('readerRoot'), 6000);
      if (!ok) return { ok: false, reason: 'no reader' };
      document.querySelector('[data-mode="side"]').click();
      await window.__T.until(
        () => document.getElementById('paneDst') && document.querySelectorAll('#proseDst .blk').length > 0,
        180000
      );
      await window.__T.wait(900);

      // 找一个普通段落：源词落在单个文本节点里，译文取开头一小段作为「译词」
      const src = document.getElementById('paneSrc');
      let picked = null;
      for (const blk of src.querySelectorAll('.blk[data-seg]')) {
        if (blk.dataset.type !== 'paragraph') continue;
        const dst = document.querySelector('#paneDst .blk[data-seg="' + blk.dataset.seg + '"] .blk__src');
        const dstText = dst ? (dst.textContent || '').trim() : '';
        if (dstText.length < 6) continue;
        const walker = document.createTreeWalker(blk.querySelector('.blk__src'), NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const m = node.nodeValue.match(/[A-Za-z][A-Za-z-]{5,}/);
          if (!m) continue;
          picked = { seg: blk.dataset.seg, node, term: m[0], dstTerm: dstText.slice(0, 4) };
          break;
        }
        if (picked) break;
      }
      if (!picked) return { ok: false, reason: 'no paragraph block' };

      const injected = window.__atelierDebug && window.__atelierDebug.setAlign({
        [picked.seg]: [[picked.term, picked.dstTerm]]
      });
      if (!injected) return { ok: false, reason: 'no debug hook' };

      const i = picked.node.nodeValue.indexOf(picked.term);
      const r = document.createRange();
      r.setStart(picked.node, i);
      r.setEnd(picked.node, i + picked.term.length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      await window.__T.wait(700);

      const hl = CSS.highlights.get('sync');
      const tip = document.querySelector('.wordtip');
      const d = document.getElementById('proseDst');
      return {
        ok: true,
        term: picked.term,
        dstTerm: picked.dstTerm,
        has: !!hl,
        text: hl ? Array.from(hl).map((x) => x.toString()).join(' ') : '',
        inDst: hl ? Array.from(hl).some((x) => d.contains(x.commonAncestorContainer)) : false,
        tip: tip ? tip.textContent.replace(/\\s+/g, ' ').trim() : ''
      };
    })()
  `);
  check('选中单词 → 对侧高亮到「词」而不是整句', word.ok && word.has && word.text === word.dstTerm, word);
  check('词级对照气泡显示「源词 → 译词」', !!word.tip && word.tip.includes(word.term) && word.tip.includes(word.dstTerm), { tip: word.tip });
  await shot('33-word-align');

  const back = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__T.wait(200);
      const info = window.__atelierDebug.getAlign();
      const seg = Object.keys(info || {})[0];
      const pair = info && seg ? info[seg][0] : null;
      if (!pair) return { ok: false, reason: 'no align' };
      const dst = document.querySelector('#paneDst .blk[data-seg="' + seg + '"] .blk__src');
      const walker = document.createTreeWalker(dst, NodeFilter.SHOW_TEXT);
      let node; let start = -1;
      while ((node = walker.nextNode())) {
        const i = node.nodeValue.indexOf(pair[1]);
        if (i >= 0) { start = i; break; }
      }
      if (start < 0) return { ok: false, reason: 'no dst term' };
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, start + pair[1].length);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      await window.__T.wait(700);
      const hl = CSS.highlights.get('sync');
      const s = document.getElementById('proseSrc');
      return {
        ok: true,
        expect: pair[0],
        text: hl ? Array.from(hl).map((x) => x.toString()).join(' ') : '',
        inSrc: hl ? Array.from(hl).some((x) => s.contains(x.commonAncestorContainer)) : false
      };
    })()
  `);
  check('译文选中词 → 原文精确回指到源词', back.ok && back.text === back.expect && back.inSrc, back);

  await js(`(async()=>{ document.querySelector('#rBack')?.click(); await window.__T.wait(300); return 1; })()`);

  const passed = results.filter((r) => r.ok).length;
  const report = {
    at: new Date().toISOString(),
    suite: 'v15',
    version: require(path.join(ROOT, 'package.json')).version,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    notes
  };
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-v15.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n[report] ${passed}/${results.length} passed → docs/test-report-v15.json`);
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
