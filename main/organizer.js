'use strict';
/**
 * organizer.js — 暂存区归位：AI 提议分类 → 人工确认 → 移动
 *
 * 只做「移动」，绝不删除。目标目录已存在同名时自动加后缀，不覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');
const scanner = require('./scanner');
const ai = require('./aiService');
const importer = require('./importer');

const MAX_PER_CATEGORY = 6;

/** 列出归位目标根（暂存区的上一级）与其下分类 */
function categories(stagingRoot) {
  const staging = scanner.norm(stagingRoot);
  const root = path.dirname(staging);
  if (!fs.existsSync(root)) return { root, list: [] };

  const list = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (scanner.key(path.join(root, e.name)) === scanner.key(staging)) continue;
    const dir = path.join(root, e.name);
    const skills = scanner.walkForSkills(dir, 2).map((d) => path.basename(d));
    list.push({ name: e.name, dir, skills, count: skills.length });
  }
  return { root, list };
}

const SYSTEM = `你是 skill 归档助手。任务：把一批待归档的 skill 分到合适的分类目录里。

规则：
1. 优先放进已有分类；只有当所有已有分类都不合适时，才提出一个新分类名。
2. 新分类名必须是 kebab-case 英文（如 obsidian-toolkit），要能一眼看出它装什么。
3. 每个分类建议不超过 ${MAX_PER_CATEGORY} 个 skill；已经满的分类不要再塞。
4. 按「这个 skill 产出什么」判断，而不是按「它读什么」判断。
5. 只输出 JSON：{"moves":[{"name":"<待归档目录名>","category":"<分类名>","reason":"<一句话理由>"}]}
6. moves 必须覆盖输入的每一个 name，不多不少。`;

async function propose(stagingRoot) {
  const st = importer.stagingState(stagingRoot);
  if (!st.items.length) throw new Error('暂存区里没有可归档的 skill');
  return classify(st.items, path.dirname(scanner.norm(stagingRoot)), stagingRoot);
}

/** 对任意一组 {name,dir,description} 做分类建议 */
async function classify(items, targetRoot, stagingRoot) {
  const root = scanner.norm(targetRoot);
  const list = categories(stagingRoot || path.join(root, 'AAA-new')).list;

  const catBrief = list.map((c) => `- ${c.name}（${c.count} 个）：${c.skills.slice(0, 8).join('、') || '空'}`).join('\n');
  const itemBrief = items.map((i) => `- ${i.name}：${(i.description || '无描述').slice(0, 180)}`).join('\n');

  const res = await ai.chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `现有分类（父目录 ${root}）：\n${catBrief || '（暂无分类）'}\n\n待归档 skill：\n${itemBrief}\n\n请给出归类建议。`
      }
    ],
    { json: true, temperature: 0.2, timeout: 120000 }
  );

  let parsed;
  const raw = res.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { parsed = JSON.parse(raw); } catch {
    const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
    parsed = JSON.parse(raw.slice(a, b + 1));
  }
  const moves = Array.isArray(parsed.moves) ? parsed.moves : [];
  const byName = new Map(moves.map((m) => [String(m.name), m]));

  return {
    root,
    categories: list,
    items: items.map((i) => {
      const m = byName.get(i.name);
      return {
        ...i,
        category: m ? String(m.category || '') : '',
        reason: m ? String(m.reason || '') : '模型未给出建议'
      };
    })
  };
}

/** 执行移动：moves = [{from, category}]，targetRoot = 分类目录所在的根 */
function apply(moves, targetRoot) {
  const results = [];
  for (const mv of moves || []) {
    const from = scanner.norm(mv.from);
    const category = String(mv.category || '').trim();
    try {
      if (!from || !fs.existsSync(from)) throw new Error('源目录不存在');
      if (!category) throw new Error('未指定分类');
      if (!/^[A-Za-z0-9._-]+$/.test(category)) throw new Error('分类名只能是字母数字和 -_');

      const root = targetRoot ? scanner.norm(targetRoot) : path.dirname(path.dirname(from));
      let dest = path.join(root, category, path.basename(from));
      let n = 2;
      while (fs.existsSync(dest)) {
        dest = path.join(root, category, `${path.basename(from)}-${n++}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.renameSync(from, dest);
      } catch {
        // 跨盘时 rename 会失败，退化为复制后删源
        copyDir(from, dest);
        fs.rmSync(from, { recursive: true, force: true });
      }
      results.push({ ok: true, from, to: dest, category });
    } catch (e) {
      results.push({ ok: false, from, category, error: e.message });
    }
  }
  return results;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

module.exports = { propose, classify, apply, categories, MAX_PER_CATEGORY };
