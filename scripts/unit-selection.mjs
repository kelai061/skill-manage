/**
 * unit-selection.mjs — 012 轮「选中对应」内核单测（不启动 Electron）
 *
 * 覆盖《要求.md》5.1 的 S01–S06：词级精确、重复词 occurrence、
 * 跨列表项、跨句、多文本节点与错误词对拒绝。
 * 全部用纯字符串坐标，真实 DOM 的接线由 scenarios/selection-nested.cjs 验证。
 */

import assert from 'node:assert/strict';
import {
  resolveSelection, structureOf, findTermSpans, pickAlignPair, plainTerm,
  hasWordBoundary, isWordSelection, ALIGN_VERSION
} from '../shared/align.mjs';

let pass = 0;
const fails = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

/* ---- 与 SKILL.md 截图语义一致的 fixture（列表块 = 三个列表项） ---- */
const SRC_LINES = [
  "The pill toggles the aux pane. DO NOT output a plugin link, if the plugin isn't enabled/running.",
  "Deduce relevance from the description, not guesswork. If no enabled UI plugin's description matches the conversation, don't force a pill.",
  'Send the plugin link only after the plugin is running. A blink means the pane is loading.'
];
const DST_LINES = [
  '胶囊按钮用于切换辅助窗格。如果插件未启用或未运行，不要输出插件链接。',
  '根据描述推断相关性，而不是猜测。如果没有已启用插件的描述与对话匹配，不要强行输出胶囊按钮。',
  '只有在插件运行后才发送插件链接。闪烁表示窗格正在加载。'
];
const SRC = SRC_LINES.join('\n');
const DST = DST_LINES.join('\n');
const PAIRS = [
  ['plugin link', '插件链接'],
  ['aux pane', '辅助窗格'],
  ['Deduce relevance from the description, not guesswork.', '根据描述推断相关性，而不是猜测。'],
  ['blink', '闪烁']
];

const lineStart = (lines, i) => lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
const lineEnd = (lines, i) => lineStart(lines, i) + lines[i].length;

console.log('\n[unit] 结构切分');
t('多行块按行切（3 个列表项 = 3 个单元）', () => {
  const s = structureOf(SRC);
  assert.equal(s.length, 3);
  assert.equal(SRC.slice(s[1].start, s[1].end), SRC_LINES[1]);
});
t('单行块按句切', () => {
  const s = structureOf('First sentence. Second one!');
  assert.equal(s.length, 1);
  assert.equal(s[0].sentences.length, 2);
});
t('空文本返回空结构', () => {
  assert.deepEqual(structureOf('   '), []);
});

console.log('\n[unit] 词边界（S05）');
t('link 不得命中 blink', () => {
  assert.equal(findTermSpans('blink', 'link').length, 0);
});
t('link 不得命中 links', () => {
  const spans = findTermSpans('blink link links', 'link');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 6);
});
t('hasWordBoundary 对中文不设限', () => {
  assert.equal(hasWordBoundary('插件链接', 2, 4), true);
});
t('plainTerm 去掉 markdown 标记', () => {
  assert.equal(plainTerm('**link**'), 'link');
  assert.equal(plainTerm('[链接](http://a)'), '链接');
});

console.log('\n[unit] 选中对应（S01–S04）');
t('S01 译文选「链接」→ 原文只落 plugin link（不越到第二项）', () => {
  const base = lineStart(DST_LINES, 0);
  const at = base + DST_LINES[0].indexOf('插件链接') + 2;
  const r = resolveSelection({ textA: DST, textB: SRC, start: at, end: at + 2, pairs: PAIRS, side: 1 });
  assert.equal(r.kind, 'word');
  assert.equal(SRC.slice(r.start, r.end), 'plugin link');
  assert.ok(r.start >= lineStart(SRC_LINES, 0) && r.end <= lineEnd(SRC_LINES, 0), '不得跨到第二项');
});

t('S01 反向：原文选 plugin link → 译文落「插件链接」', () => {
  const at = lineStart(SRC_LINES, 0) + SRC_LINES[0].indexOf('plugin link');
  const r = resolveSelection({ textA: SRC, textB: DST, start: at, end: at + 11, pairs: PAIRS, side: 0 });
  assert.equal(r.kind, 'word');
  assert.equal(DST.slice(r.start, r.end), '插件链接');
  assert.ok(r.start >= lineStart(DST_LINES, 0) && r.end <= lineEnd(DST_LINES, 0));
});

t('S02 第二项整句 → 只对应 Deduce…，不落第一项', () => {
  const base = lineStart(DST_LINES, 1);
  const at = base + DST_LINES[1].indexOf('根据描述推断相关性');
  const r = resolveSelection({ textA: DST, textB: SRC, start: at, end: at + 16, pairs: PAIRS, side: 1 });
  assert.equal(r.kind, 'word');
  assert.equal(SRC.slice(r.start, r.end), 'Deduce relevance from the description, not guesswork.');
  assert.ok(r.start >= lineStart(SRC_LINES, 1));
});

t('S03 两个 plugin link，选第二次出现 → 对应第三项而不是第一项', () => {
  const base = lineStart(DST_LINES, 2);
  const at = base + DST_LINES[2].indexOf('插件链接') + 2;
  const r = resolveSelection({ textA: DST, textB: SRC, start: at, end: at + 2, pairs: PAIRS, side: 1 });
  assert.equal(r.kind, 'word');
  assert.equal(SRC.slice(r.start, r.end), 'plugin link');
  assert.ok(r.start >= lineStart(SRC_LINES, 2), `应落在第三项，实际 ${r.start}`);
});

t('S04 跨两个列表项 → 覆盖两项完整范围', () => {
  const a = lineStart(DST_LINES, 0) + 4;
  const b = lineStart(DST_LINES, 1) + 6;
  const r = resolveSelection({ textA: DST, textB: SRC, start: a, end: b, pairs: PAIRS, side: 1 });
  assert.equal(r.kind, 'range');
  assert.equal(r.start, lineStart(SRC_LINES, 0));
  assert.equal(r.end, lineEnd(SRC_LINES, 1));
});

t('跨句但同一列表项 → 句子级范围', () => {
  const line = 0;
  const base = lineStart(SRC_LINES, line);
  const a = base + 4;
  const b = base + SRC_LINES[line].indexOf('DO NOT') + 6;
  const r = resolveSelection({ textA: SRC, textB: DST, start: a, end: b, pairs: [], side: 0 });
  assert.ok(r.kind === 'range' || r.kind === 'line');
  assert.ok(r.start >= lineStart(DST_LINES, line) && r.end <= lineEnd(DST_LINES, line));
});

console.log('\n[unit] 段落内多词（S05）');
const PS = 'Click the link, ignore the blink, and open the links panel.';
const PD = '点击链接，忽略闪烁，然后打开链接面板。';
const PP = [['link', '链接'], ['blink', '闪烁'], ['links', '链接']];

t('选 link → 第一个「链接」', () => {
  const at = PS.indexOf('link');
  const r = resolveSelection({ textA: PS, textB: PD, start: at, end: at + 4, pairs: PP, side: 0 });
  assert.equal(r.kind, 'word');
  assert.equal(r.start, PD.indexOf('链接'));
});
t('选 links → 第二个「链接」（不回头取第一次）', () => {
  const at = PS.indexOf('links');
  const r = resolveSelection({ textA: PS, textB: PD, start: at, end: at + 5, pairs: PP, side: 0 });
  assert.equal(r.kind, 'word');
  assert.equal(r.start, PD.lastIndexOf('链接'));
});
t('选 blink → 闪烁', () => {
  const at = PS.indexOf('blink');
  const r = resolveSelection({ textA: PS, textB: PD, start: at, end: at + 5, pairs: PP, side: 0 });
  assert.equal(r.kind, 'word');
  assert.equal(PD.slice(r.start, r.end), '闪烁');
});

console.log('\n[unit] 错误词对拒绝（S06）');
t('词条不在原文里 → 不产生词级结果', () => {
  const at = DST.indexOf('插件链接');
  const r = resolveSelection({
    textA: DST, textB: SRC, start: at, end: at + 4,
    pairs: [['the whole sentence', '插件链接']], side: 1
  });
  assert.notEqual(r.kind, 'word');
  assert.ok(r.kind === 'sentence' || r.kind === 'line' || r.kind === 'range');
});
t('译文词条不存在 → 不产生词级结果', () => {
  const at = SRC.indexOf('plugin link');
  const r = resolveSelection({
    textA: SRC, textB: DST, start: at, end: at + 11,
    pairs: [['plugin link', '不存在的译文']], side: 0
  });
  assert.notEqual(r.kind, 'word');
});
t('跨行词对被拒绝', () => {
  const at = SRC.indexOf('aux pane');
  const hit = pickAlignPair([['aux pane\nDeduce', '辅助窗格']], SRC, at, at + 8, 0);
  assert.equal(hit, null);
});
t('低覆盖率词对（只沾边）被拒绝', () => {
  const at = SRC.indexOf('plugin link');
  const hit = pickAlignPair([['plugin link', '插件链接']], SRC, at + 9, at + 19, 0);
  assert.equal(hit, null);
});
t('空词对 / 空选区 → none', () => {
  assert.equal(resolveSelection({ textA: SRC, textB: DST, start: 3, end: 3, pairs: PAIRS }).kind, 'none');
  assert.equal(resolveSelection({ textA: SRC, textB: '', start: 0, end: 3, pairs: PAIRS }).kind, 'none');
});

console.log('\n[unit] 版本与兼容');
t('对齐算法版本已升到 2', () => {
  assert.equal(ALIGN_VERSION, 2);
});
t('旧接口 isWordSelection 仍然可用', () => {
  assert.equal(isWordSelection('链接'), true);
  assert.equal(isWordSelection('长'.repeat(60)), false);
});

console.log(`\n[unit] ${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
