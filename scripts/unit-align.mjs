/**
 * unit-align.mjs — 对齐内核的离线单测（不启动 Electron，秒级）
 *
 * 只测纯字符串逻辑：切句、比例映射、行间配对。
 * 这三块是并排阅读器的地基，错了上面所有同步都会歪。
 */

import assert from 'node:assert/strict';
import { sentenceSpans, spanIndexAt, mapSpan, groupSentences, pairSentences,
  findTermSpan, pickAlignPair, isWordSelection } from '../shared/align.mjs';

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

const EN = 'You are an AI-powered curator. It tracks builders. It writes summaries!';
const ZH = '你是一个 AI 策展助手。它追踪构建者。它写摘要！';

console.log('\n[unit] 切句');

t('英文按 . ! 切句', () => {
  assert.equal(sentenceSpans(EN).length, 3);
});

t('中文按 。！切句', () => {
  assert.equal(sentenceSpans(ZH).length, 3);
});

t('小数与缩写不误切', () => {
  const s = 'Use e.g. 3.5 tokens per call. Then stop.';
  assert.equal(sentenceSpans(s).length, 2);
});

t('空串返回空数组', () => {
  assert.deepEqual(sentenceSpans('   '), []);
});

t('句区间能覆盖到原文', () => {
  const spans = sentenceSpans(ZH);
  for (const sp of spans) assert.ok(ZH.slice(sp.start, sp.end).length > 0);
});

console.log('\n[unit] 偏移映射');

t('首句落在首句', () => {
  const m = mapSpan(EN, ZH, 0, 28);
  assert.equal(m.from, 0);
});

t('末句落在末句', () => {
  const m = mapSpan(EN, ZH, EN.length - 10, EN.length);
  assert.equal(m.to, 2);
});

t('映射结果落在目标文本范围内', () => {
  for (let i = 0; i <= EN.length; i += 7) {
    const m = mapSpan(EN, ZH, i, i + 5);
    assert.ok(m.start >= 0 && m.end <= ZH.length && m.end > m.start, `offset ${i} → ${JSON.stringify(m)}`);
  }
});

t('目标为空时返回 null', () => {
  assert.equal(mapSpan(EN, '   ', 0, 10), null);
});

t('spanIndexAt 越界返回 -1', () => {
  assert.equal(spanIndexAt(sentenceSpans(ZH), 9999), -1);
});

console.log('\n[unit] 行间配对');

t('句数相等时一一对应', () => {
  const pairs = pairSentences(EN, ZH);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0], '你是一个 AI 策展助手。');
});

t('句数不等时不漏句（每句都有译文）', () => {
  const dst = '第一句。第二句。第三句。';
  const pairs = pairSentences('A. B. C.', dst);
  assert.equal(pairs.length, 3);
  for (const p of pairs) assert.ok(p.length > 0, JSON.stringify(pairs));
});

t('分桶不重复：同一句译文只出现一次', () => {
  const dst = '第一句。第二句。';
  const groups = groupSentences(3, dst);
  const used = groups.filter(Boolean).map((g) => dst.slice(g.start, g.end));
  assert.equal(new Set(used).size, used.length, JSON.stringify(used));
  assert.ok(groups.some((g) => g === null), '多出来的源句应留空而不是复制');
});

t('分桶顺序不乱、不重叠', () => {
  const dst = '一。二。三。四。五。';
  const groups = groupSentences(3, dst).filter(Boolean);
  for (let i = 1; i < groups.length; i++) {
    assert.ok(groups[i].start >= groups[i - 1].end, JSON.stringify(groups));
  }
});

t('目标句数少于源句时，译文行数不超过目标句数', () => {
  const pairs = pairSentences('A. B. C. D.', '一。二。');
  assert.ok(pairs.filter((p) => p).length <= 2, JSON.stringify(pairs));
});

t('落单的 ** 被清掉', () => {
  const pairs = pairSentences('One. Two.', '**第一句。 第二句。');
  assert.ok(!pairs.some((p) => (p.match(/\*\*/g) || []).length % 2 === 1), JSON.stringify(pairs));
});


console.log('\n[unit] 词级对齐');

t('findTermSpan 找到词的位置', () => {
  const s = 'The builder writes summaries.';
  const sp = findTermSpan(s, 'writes', 0);
  assert.equal(s.slice(sp.start, sp.end), 'writes');
});

t('findTermSpan 多次出现时取离 near 最近的一处', () => {
  const s = 'skill A, skill B, skill C';
  const near = s.lastIndexOf('skill');
  const sp = findTermSpan(s, 'skill', near);
  assert.equal(sp.start, near);
});

t('pickAlignPair 选中单词能命中包含它的短语', () => {
  const src = 'The builder writes weekly summaries.';
  const pairs = [['builder', '构建者'], ['weekly summaries', '每周摘要']];
  const at = src.indexOf('summaries');
  const hit = pickAlignPair(pairs, src, at, at + 'summaries'.length, 0);
  assert.ok(hit, 'should hit');
  assert.equal(hit.pair[1], '每周摘要');
});

t('pickAlignPair 没重叠时返回 null（交给句子映射兜底）', () => {
  const src = 'The builder writes weekly summaries.';
  const pairs = [['builder', '构建者']];
  const at = src.indexOf('weekly');
  assert.equal(pickAlignPair(pairs, src, at, at + 6, 0), null);
});

t('pickAlignPair 支持从译文侧反查', () => {
  const dst = '这位构建者每周写摘要。';
  const pairs = [['builder', '构建者'], ['weekly summaries', '每周写摘要']];
  const at = dst.indexOf('构建者');
  const hit = pickAlignPair(pairs, dst, at, at + 3, 1);
  assert.ok(hit);
  assert.equal(hit.pair[0], 'builder');
});

t('isWordSelection 区分单词与整段', () => {
  assert.equal(isWordSelection('builder'), true);
  assert.equal(isWordSelection('a'.repeat(60)), false);
});

console.log(`\n[unit] ${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
  process.exit(1);
}
