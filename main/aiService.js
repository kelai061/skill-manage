'use strict';
/**
 * aiService.js — DeepSeek / OpenAI 兼容接口的最小封装
 *
 * 只做三件事：连通性自检、分块翻译、整篇改写。
 * 所有网络失败都抛出带人话说明的错误，由 UI 原样展示。
 */

const store = require('./store');

function cfg() {
  const a = store.get().settings.api || {};
  return {
    baseUrl: String(a.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    key: String(a.key || '').trim(),
    model: String(a.model || 'deepseek-chat'),
    temperature: typeof a.temperature === 'number' ? a.temperature : 0.3
  };
}

function assertReady() {
  const c = cfg();
  if (!c.key) {
    throw new Error('尚未配置 API Key。请到「设置 → AI 接口」填入后重试。');
  }
  return c;
}

function friendly(err) {
  const msg = String((err && err.message) || err);
  if (/401|Unauthorized|invalid_api_key/i.test(msg)) return 'API Key 无效或已失效（401）。';
  if (/402|Insufficient Balance|余额/i.test(msg)) return '账户余额不足（402）。';
  if (/429|rate limit/i.test(msg)) return '请求过于频繁（429），稍后再试。';
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(msg)) return '网络不可达，检查代理或网络连接。';
  if (/timeout|aborted/i.test(msg)) return '请求超时，模型响应过慢。';
  return msg;
}

async function chat(messages, opts = {}) {
  const c = assertReady();
  const url = `${c.baseUrl}/chat/completions`;
  const body = {
    model: opts.model || c.model,
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : c.temperature,
    stream: false
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 120000);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.key}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(friendly(e));
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error.type)) || '';
    } catch {
      try { detail = await res.text(); } catch { /* ignore */ }
    }
    throw new Error(friendly(`${res.status} ${detail}`));
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('接口返回结构异常，缺少 choices[0].message.content。');
  return {
    content,
    usage: json.usage || null,
    model: json.model || body.model
  };
}

function parseJsonLoose(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fallthrough */ }
  }
  const c = s.indexOf('[');
  const d = s.lastIndexOf(']');
  if (c >= 0 && d > c) {
    try { return JSON.parse(s.slice(c, d + 1)); } catch { /* fallthrough */ }
  }
  throw new Error('模型未返回合法 JSON。');
}

const SYSTEM_TRANSLATE = `You are a precise technical translator for developer documentation (SKILL.md files).
Rules:
1. Translate into Simplified Chinese (简体中文).
2. Input is a JSON array of numbered markdown segments. Return JSON: {"t":["...","..."]}.
3. The output array MUST have exactly the same length and order as the input.
4. Never merge, split, reorder, or drop segments.
5. Preserve markdown syntax at the start of each segment exactly: "#", "##", "-", "*", "1.", ">", indentation.
6. Keep code identifiers, file paths, CLI commands, API names, URLs, and frontmatter keys in their original form.
7. Translate the prose faithfully; do not add explanations, notes, or extra punctuation.
8. If a segment is already Chinese or contains no translatable prose, return it unchanged.`;

async function translateSegments(texts, targetLang = 'zh-CN') {
  if (!texts.length) return [];

  // 分块：单块 ≤ 30 段且 ≤ 6000 字符
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const t of texts) {
    if (cur.length >= 30 || curLen + t.length > 6000) {
      if (cur.length) chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(t);
    curLen += t.length;
  }
  if (cur.length) chunks.push(cur);

  const out = [];
  for (const chunk of chunks) {
    const payload = JSON.stringify(chunk);
    const res = await chat(
      [
        { role: 'system', content: SYSTEM_TRANSLATE },
        { role: 'user', content: `target_language: ${targetLang}\nsegments: ${payload}` }
      ],
      { json: true, temperature: 0.1, timeout: 180000 }
    );
    const parsed = parseJsonLoose(res.content);
    const arr = Array.isArray(parsed) ? parsed : parsed.t || parsed.translations || parsed.segments;
    if (!Array.isArray(arr)) throw new Error('译文格式异常：未找到数组字段 t。');
    if (arr.length !== chunk.length) {
      throw new Error(`译文段数不匹配（期望 ${chunk.length}，实得 ${arr.length}）。已放弃本次缓存。`);
    }
    for (const s of arr) out.push(typeof s === 'string' ? s : String(s ?? ''));
  }
  return out;
}

const SYSTEM_REWRITE = `You are a skill file maintainer. You rewrite a SKILL.md file according to the user's instruction.
Rules:
1. Output the COMPLETE new file content only — no commentary, no markdown code fence wrapper.
2. Preserve YAML frontmatter (--- block) with its existing keys unless the instruction explicitly asks to change them.
3. Keep the original language of the document unless asked to translate.
4. Keep the document's existing structure and tone where the instruction does not require change.
5. Never invent file paths or commands that do not exist.`;

async function rewriteSkill(content, instruction, opts = {}) {
  const res = await chat(
    [
      { role: 'system', content: SYSTEM_REWRITE },
      { role: 'user', content: `INSTRUCTION:\n${instruction}\n\nCURRENT FILE:\n${content}` }
    ],
    { temperature: opts.temperature !== undefined ? opts.temperature : 0.2, timeout: 180000, maxTokens: 8000 }
  );
  let out = res.content.trim();
  // 万一模型还是包了围栏
  const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1];
  return { content: out, model: res.model, usage: res.usage };
}

const SYSTEM_ALIGN = `You align an existing translation with its source at word/phrase level.
Input: a JSON array of {"i": id, "s": "source sentence", "d": "translated sentence"}.
Output JSON: {"a": [[["source term","target term"], ...], ...]}

Rules:
1. The output array MUST have exactly one entry per input item, in the same order.
2. Each entry is an array of term pairs. A pair means: "source term" in the source sentence is translated as "target term" in the translated sentence.
3. "source term" MUST be a literal substring of that item's source sentence. "target term" MUST be a literal substring of that item's translated sentence. Never paraphrase.
4. Cover the content words and short phrases that carry meaning: nouns, verbs, adjectives, technical terms, numbers with their unit. Skip pure function words (the, of, 的, 了) unless they are part of a phrase you already selected.
5. Prefer phrases of 1-4 words. Do not emit overlapping terms. Do not emit more than 12 pairs per sentence.
6. If a sentence has no meaningful alignment, return an empty array for it.
7. No commentary, no markdown fences, JSON only.`;

/**
 * 词级对齐：给一批「源句 + 译句」，让模型给出可字面定位的词对。
 *
 * 为什么不用统计对齐（比例映射）：用户要的是「选中一个单词，准确指出译文里
 * 对应的那个词」。比例映射只能保证落在同一句附近，落不到词。宁可多调一次接口，
 * 也要拿到可精确命中的词对。
 *
 * @param {Array<{i:number,s:string,d:string}>} items
 * @returns {Promise<Object<number, Array<[string,string]>>>} key = 段落编号
 */
async function alignSegments(items, targetLang = 'zh-CN') {
  if (!items || !items.length) return {};

  // 分块：单块 ≤ 12 段且 ≤ 6000 字符（对齐比翻译更吃上下文，块要小）
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const it of items) {
    const len = (it.s || '').length + (it.d || '').length;
    if (cur.length >= 12 || curLen + len > 6000) {
      if (cur.length) chunks.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(it);
    curLen += len;
  }
  if (cur.length) chunks.push(cur);

  const out = {};
  for (const chunk of chunks) {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM_ALIGN },
        { role: 'user', content: `target_language: ${targetLang}\nitems: ${JSON.stringify(chunk)}` }
      ],
      { json: true, temperature: 0, timeout: 180000 }
    );
    const parsed = parseJsonLoose(res.content);
    const arr = Array.isArray(parsed) ? parsed : parsed.a || parsed.align || parsed.pairs;
    if (!Array.isArray(arr)) throw new Error('对齐格式异常：未找到数组字段 a。');

    chunk.forEach((it, k) => {
      const pairs = Array.isArray(arr[k]) ? arr[k] : [];
      const clean = [];
      for (const p of pairs) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const s = String(p[0] || '').trim();
        const d = String(p[1] || '').trim();
        // 只收「能在原文/译文里字面找到」的词对 —— 找不到就没法高亮，留着也是噪音
        if (!s || !d) continue;
        if (!String(it.s).includes(s) || !String(it.d).includes(d)) continue;
        clean.push([s, d]);
      }
      if (clean.length) out[it.i] = clean;
    });
  }
  return out;
}

async function testConnection() {
  const c = assertReady();
  const t0 = Date.now();
  const res = await chat(
    [{ role: 'user', content: 'Reply with the single word: ok' }],
    { temperature: 0, timeout: 30000, maxTokens: 8 }
  );
  return {
    ok: true,
    model: res.model,
    ms: Date.now() - t0,
    sample: res.content.trim().slice(0, 40),
    baseUrl: c.baseUrl
  };
}

module.exports = { cfg, chat, translateSegments, alignSegments, rewriteSkill, testConnection, friendly };
