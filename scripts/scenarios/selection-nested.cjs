'use strict';
/**
 * scripts/scenarios/selection-nested.cjs — 012 轮端到端验收
 *
 * 覆盖《要求.md》里必须跑在真实 Electron 渲染中的用例：
 *   S01 / S02 / S03 / S04  双语选中精确对应（真实 IPC + 缓存 + 渲染）
 *   S08                    上下文隔离：慢响应文档不得污染新文档
 *   N06 / N07              嵌套默认折叠、逐级进入、返回、搜索可达
 *
 * 只读断言；数据全部来自隔离 profile 与临时 fixture 目录。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

/** 报告要能自证跑的是哪个二进制、哪份源码 */
function sha256File(file) {
  try {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    fs.closeSync(fd);
    return h.digest('hex');
  } catch {
    return null;
  }
}

function sourceCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

module.exports = async function run({ win, app, delay, shot }) {
  const results = [];
  const notes = [];

  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  /* ---------------- 页面内工具 ---------------- */
  await js(`
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('unhandled: ' + String(e.reason)));
    window.__S = {
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      until: async (fn, ms = 30000, step = 150) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          try { if (fn()) return true; } catch (e) { /* keep polling */ }
          await new Promise((r) => setTimeout(r, step));
        }
        return false;
      },
      title: (el) => ((el.querySelector('.card__title') || {}).textContent || '').trim(),
      cards: () => [...document.querySelectorAll('#grid .card[data-id]')],
      cardByName: (name) => window.__S.cards().find((c) => window.__S.title(c) === name) || null,
      names: () => window.__S.cards().map((c) => window.__S.title(c)),
      openByName: (name) => {
        const c = window.__S.cardByName(name);
        if (!c) return false;
        c.querySelector('[data-act="read"]').click();
        return true;
      },
      close: () => { const b = document.getElementById('rBack'); if (b) b.click(); },
      segOf: (pane, needle) => {
        for (const b of document.querySelectorAll('#' + pane + ' .blk[data-seg]')) {
          const h = b.querySelector('.blk__src');
          if (h && (h.textContent || '').includes(needle)) return Number(b.dataset.seg);
        }
        return -1;
      },
      holder: (pane, seg) => document.querySelector('#' + pane + ' .blk[data-seg="' + seg + '"] .blk__src'),
      select: (pane, seg, needle, off = 0, len = null, nth = 0) => {
        const root = window.__S.holder(pane, seg);
        if (!root) return null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let seen = 0;
        let n;
        while ((n = walker.nextNode())) {
          let from = 0;
          for (;;) {
            const idx = n.nodeValue.indexOf(needle, from);
            if (idx < 0) break;
            if (seen === nth) {
              const r = document.createRange();
              r.setStart(n, idx + off);
              r.setEnd(n, idx + off + (len === null ? needle.length : len));
              const sel = getSelection();
              sel.removeAllRanges();
              sel.addRange(r);
              document.dispatchEvent(new Event('selectionchange'));
              return { text: r.toString(), seg, nth };
            }
            seen++;
            from = idx + 1;
          }
        }
        return null;
      },
      selectSpan: (pane, seg, needleA, offA, needleB, offB) => {
        const root = window.__S.holder(pane, seg);
        if (!root) return null;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        const find = (needle) => nodes.find((x) => x.nodeValue.includes(needle)) || null;
        const a = find(needleA);
        const b = find(needleB);
        if (!a || !b) return null;
        const r = document.createRange();
        r.setStart(a, a.nodeValue.indexOf(needleA) + offA);
        r.setEnd(b, b.nodeValue.indexOf(needleB) + offB);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
        return { text: r.toString(), seg };
      },
      sync: () => {
        const hl = CSS.highlights.get('sync');
        const src = document.getElementById('proseSrc');
        const out = { has: !!hl, n: 0, texts: [], inSrc: false, items: [], tip: '' };
        if (hl) {
          const rs = Array.from(hl);
          out.n = rs.length;
          out.texts = rs.map((r) => r.toString());
          out.inSrc = rs.some((r) => src && src.contains(r.commonAncestorContainer));
          out.items = rs.map((r) => {
            const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
            const li = el && el.closest ? el.closest('li') : null;
            return li ? (li.textContent || '').slice(0, 40) : '';
          });
        }
        const tip = document.querySelector('.wordtip');
        out.tip = tip ? (tip.textContent || '') : '';
        return out;
      },
      modes: () => [...document.querySelectorAll('[data-mode]')].map((b) => [b.dataset.mode, b.getAttribute('aria-pressed')]),
      dstReady: () => !!document.getElementById('paneDst')
        && document.querySelectorAll('#proseDst .blk').length > 0
        && !document.querySelector('.tr-pending'),
      alignReady: () => {
        const a = window.__atelierDebug.getAlign();
        return !!a && Object.keys(a).length > 0;
      },
      dstText: () => (document.getElementById('proseDst') || {}).textContent || '',
      search: (q) => {
        const el = document.getElementById('searchInput');
        el.value = q;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    1;
  `);

  await delay(700);

  /* ---------------- 0. 卡片墙 ---------------- */
  const wall = await js(`({ n: window.__S.cards().length, names: window.__S.names() })`);
  check('卡片墙渲染出 skill 卡片', wall.n > 0, { n: wall.n });
  check('双语 fixture 已入库', wall.names.includes('bilingual-fixture'), { names: wall.names.slice(0, 12) });

  /* ---------------- 1. 打开双语 fixture 并翻译 ---------------- */
  const opened = await js(`
    (async () => {
      const ok = window.__S.openByName('bilingual-fixture');
      const mounted = await window.__S.until(() => document.getElementById('readerRoot'), 6000);
      return { ok, mounted };
    })()
  `);
  check('阅读器能打开双语 fixture', opened.ok && opened.mounted, opened);
  if (!opened.mounted) return finish(results, notes);

  const translated = await js(`
    (async () => {
      document.querySelector('[data-mode="side"]').click();
      const ready = await window.__S.until(() => window.__S.dstReady(), 60000);
      const aligned = await window.__S.until(() => window.__S.alignReady(), 30000);
      await window.__S.wait(400);
      return { ready, aligned, blocks: document.querySelectorAll('#proseDst .blk').length };
    })()
  `);
  check('并排译文就绪', translated.ready, translated);
  check('词级对齐已从接口取回', translated.aligned, translated);
  await shot('11-bilingual-side');

  /* ---------------- 2. S01 译文选「链接」→ 原文 plugin link ---------------- */
  const s01 = await js(`
    (async () => {
      const seg = window.__S.segOf('proseDst', '插件链接');
      const sel = window.__S.select('proseDst', seg, '插件链接', 2, 2);
      await window.__S.wait(500);
      return { seg, sel, sync: window.__S.sync() };
    })()
  `);
  check('S01 译文选「链接」→ 原文只高亮 plugin link', !!s01.sel && s01.sync.has && s01.sync.inSrc
    && /^plugin link$|^link$/.test(s01.sync.texts[0] || ''), s01);
  check('S01 高亮落在第一个列表项，不越到第二项', /^The pill/.test(s01.sync.items[0] || ''), { items: s01.sync.items });
  check('S01 词级气泡显示对应词对', /plugin link|link/.test(s01.sync.tip) && /插件链接|链接/.test(s01.sync.tip), { tip: s01.sync.tip });
  await shot('12-s01-word');

  /* ---------------- 3. S02 第二项整句 ---------------- */
  const s02 = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__S.wait(150);
      const seg = window.__S.segOf('proseDst', '根据描述推断相关性');
      const sel = window.__S.select('proseDst', seg, '根据描述推断相关性', 0, 16);
      await window.__S.wait(500);
      return { seg, sel, sync: window.__S.sync() };
    })()
  `);
  check('S02 第二项整句 → 只对应 Deduce… 那句', !!s02.sel
    && s02.sync.texts[0] === 'Deduce relevance from the description, not guesswork.', s02);
  check('S02 不落第一项', /^Deduce/.test(s02.sync.items[0] || ''), { items: s02.sync.items });

  /* ---------------- 4. S03 重复词第二次出现 ---------------- */
  const s03 = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__S.wait(150);
      const seg = window.__S.segOf('proseDst', '只有在插件运行后');
      // 第二个「插件链接」（第一项里还有一个，必须选第二次出现）
      const sel = window.__S.select('proseDst', seg, '插件链接', 2, 2, 1);
      await window.__S.wait(500);
      return { seg, sel, sync: window.__S.sync() };
    })()
  `);
  check('S03 第二个「插件链接」→ 对应第三项的 plugin link', !!s03.sel
    && s03.sync.texts[0] === 'plugin link' && /^Send the plugin link/.test(s03.sync.items[0] || ''), s03);

  /* ---------------- 5. S04 跨两个列表项 ---------------- */
  const s04 = await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__S.wait(150);
      const seg = window.__S.segOf('proseDst', '胶囊按钮');
      const sel = window.__S.selectSpan('proseDst', seg, '辅助窗格', 2, '推断相关性', 4);
      await window.__S.wait(500);
      return { seg, sel, sync: window.__S.sync() };
    })()
  `);
  check('S04 跨两个列表项 → 覆盖两项完整语义范围', !!s04.sel && s04.sync.n === 1
    && /^The pill/.test(s04.sync.texts[0] || '') && /guesswork\./.test(s04.sync.texts[0] || ''), s04);

  /* ---------------- S09 模式切换与高亮卫生 ---------------- */
  const s09 = await js(`
    (async () => {
      const seg = window.__S.segOf('proseDst', '插件链接');
      window.__S.select('proseDst', seg, '插件链接', 2, 2);
      await window.__S.wait(450);
      const before = window.__S.sync();

      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      await window.__S.wait(450);
      const after = window.__S.sync();

      const states = [];
      for (const m of ['off', 'side', 'interlinear', 'side']) {
        document.querySelector('[data-mode="' + m + '"]').click();
        await window.__S.wait(520);
        states.push({
          m,
          pressed: window.__S.modes().filter((x) => x[1] === 'true').map((x) => x[0]),
          dstPane: !!document.getElementById('paneDst'),
          inlineTr: document.querySelectorAll('#proseSrc .blk__tr').length
        });
      }

      const ready = await window.__S.until(() => window.__S.dstReady(), 20000);
      const seg2 = window.__S.segOf('proseDst', '插件链接');
      window.__S.select('proseDst', seg2, '插件链接', 2, 2);
      await window.__S.wait(500);
      return { before, after, states, ready, again: window.__S.sync() };
    })()
  `);
  check('S09 取消选区后同步高亮清空，不留上次范围', s09.before.n > 0 && !s09.after.has,
    { before: s09.before.n, after: s09.after });
  check('S09 取消选区后词级气泡消失', !s09.after.tip, { tip: s09.after.tip });
  check('S09 模式按钮 aria-pressed 与当前模式一一对应',
    s09.states.length === 4 && s09.states.every((s) => s.pressed.length === 1 && s.pressed[0] === s.m),
    { states: s09.states });
  check('S09 原文/行间不残留双栏，只有并排才出现译文栏',
    s09.states.every((s) => (s.m === 'side' ? s.dstPane : !s.dstPane)), { states: s09.states });
  check('S09 行间模式在原文块内显示译文',
    s09.states.filter((s) => s.m === 'interlinear').every((s) => s.inlineTr > 0), { states: s09.states });
  check('S09 切回并排后重新选中，高亮只属于本次选择',
    s09.ready && s09.again.n === 1 && /^plugin link$|^link$/.test(s09.again.texts[0] || ''), s09.again);

  /* ---------------- 6. S08 上下文隔离 ---------------- */
  await js(`
    (async () => {
      getSelection().removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      window.__S.close();
      await window.__S.wait(400);
      // A：慢响应文档，翻译请求 4.5 秒后才回来
      window.__S.openByName('hang-fixture');
      await window.__S.until(() => document.getElementById('readerRoot'), 6000);
      document.querySelector('[data-mode="side"]').click();
      await window.__S.wait(300);
      return 1;
    })()
  `);

  const s08 = await js(`
    (async () => {
      // A 还在加载时切到 B
      window.__S.close();
      await window.__S.wait(200);
      window.__S.openByName('follow-builders');
      await window.__S.until(() => document.getElementById('readerRoot'), 6000);
      document.querySelector('[data-mode="side"]').click();
      const ready = await window.__S.until(() => window.__S.dstReady(), 90000);
      const before = window.__S.dstText();
      const modesBefore = window.__S.modes();
      // 等 A 的晚响应落地
      await window.__S.wait(5200);
      return {
        ready, beforeLen: before.length,
        afterLen: window.__S.dstText().length,
        same: window.__S.dstText() === before,
        modesBefore,
        modesAfter: window.__S.modes(),
        stillSide: !!document.getElementById('paneDst'),
        pending: !!document.querySelector('.tr-pending'),
        errors: window.__errs.slice()
      };
    })()
  `);
  check('S08 B 文档可独立开始并完成翻译', s08.ready, { ready: s08.ready, len: s08.beforeLen });
  check('S08 A 的晚响应没有改写 B 的正文', s08.same, { before: s08.beforeLen, after: s08.afterLen });
  check('S08 A 的晚响应没有改掉 B 的模式', s08.stillSide
    && s08.modesAfter.some(([m, p]) => m === 'side' && p === 'true'), { before: s08.modesBefore, after: s08.modesAfter });
  check('S08 没有残留 loading 占位', !s08.pending);
  check('S08 期间没有未捕获异常', s08.errors.length === 0, { errors: s08.errors });

  const s08b = await js(`
    (async () => {
      window.__S.close();
      await window.__S.wait(900);
      const closed = !document.getElementById('readerRoot') && !document.querySelector('.seltool');
      window.__S.openByName('follow-builders');
      await window.__S.until(() => document.getElementById('readerRoot'), 6000);
      document.querySelector('[data-mode="side"]').click();
      const ready = await window.__S.until(() => window.__S.dstReady(), 30000);
      return { closed, ready, errors: window.__errs.slice() };
    })()
  `);
  check('S08 关闭后无残留工具条，重新打开可正常翻译', s08b.closed && s08b.ready, s08b);

  /* ---------------- 7. N06 嵌套默认折叠 / 逐级进入 / 返回 ---------------- */
  await js(`(async () => { window.__S.close(); await window.__S.wait(500); return 1; })()`);

  const n06a = await js(`
    (() => {
      const parent = window.__S.cardByName('nest-parent');
      return {
        parent: !!parent,
        childHidden: !window.__S.cardByName('nest-child'),
        grandHidden: !window.__S.cardByName('nest-grand'),
        chip: parent ? (parent.querySelector('[data-nest]') || {}).textContent || '' : '',
        collection: !!document.querySelector('#grid .card--collection'),
        names: window.__S.names()
      };
    })()
  `);
  check('N06 默认折叠：父卡在、子/孙不在顶层', n06a.parent && n06a.childHidden && n06a.grandHidden, n06a);
  check('N06 父卡显示「含 N 个嵌套」', /含\s*1\s*个嵌套/.test(n06a.chip), { chip: n06a.chip });
  check('N06 平铺技能集收成一张集合卡', n06a.collection);
  await shot('13-nested-default');

  const n06b = await js(`
    (async () => {
      const parent = window.__S.cardByName('nest-parent');
      parent.querySelector('[data-nest]').click();
      await window.__S.wait(500);
      const child = window.__S.cardByName('nest-child');
      if (child) child.querySelector('[data-nest]').click();
      await window.__S.wait(500);
      return {
        child: !!child,
        grand: !!window.__S.cardByName('nest-grand'),
        crumb: !!document.querySelector('[data-unfilter="parent"]')
      };
    })()
  `);
  check('N06 逐级进入：父 → 子 → 孙', n06b.child && n06b.grand, n06b);
  check('N06 提供返回入口（嵌套于…）', n06b.crumb);

  const n06c = await js(`
    (async () => {
      for (let i = 0; i < 3; i++) {
        const b = document.querySelector('[data-unfilter="parent"]');
        if (!b) break;
        b.click();
        await window.__S.wait(400);
      }
      return { names: window.__S.names() };
    })()
  `);
  check('N06 返回顶层后子/孙重新折叠', !n06c.names.includes('nest-child') && !n06c.names.includes('nest-grand'), n06c);

  /* ---------------- 8. N07 搜索子/孙可命中 ---------------- */
  const n07 = await js(`
    (async () => {
      window.__S.search('nest-grand');
      await window.__S.wait(800);
      const hit = window.__S.cardByName('nest-grand');
      const names = window.__S.names();
      window.__S.search('');
      await window.__S.wait(500);
      return { found: !!hit, names, backToTop: window.__S.names() };
    })()
  `);
  check('N07 搜索孙 skill 名称能找到并打开', n07.found, { names: n07.names });
  check('N07 清空搜索后恢复折叠视图', !n07.backToTop.includes('nest-grand'), { names: n07.backToTop });

  const errs = await js(`window.__errs.slice()`);
  check('整轮无未捕获异常', errs.length === 0, { errors: errs });

  await shot('14-search-nested');
  return finish(results, notes);

  function finish(list, extra) {
    const passed = list.filter((r) => r.ok).length;
    const profileArg = process.argv.find((a) => a.startsWith('--profile='));
    const report = {
      at: new Date().toISOString(),
      version: require(path.join(ROOT, 'package.json')).version,
      env: {
        packaged: !!(app && app.isPackaged),
        exe: process.execPath,
        exeSha256: sha256File(process.execPath),
        electron: process.versions.electron,
        profile: profileArg ? path.resolve(profileArg.slice('--profile='.length)) : null,
        commit: sourceCommit(),
        node: process.version
      },
      total: list.length,
      passed,
      failed: list.length - passed,
      results: list,
      notes: extra
    };
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-selection-nested.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n[report] ${passed}/${list.length} passed → docs/test-report-selection-nested.json`);
    return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
  }
};
