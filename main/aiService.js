'use strict';
/**
 * aiService.js — DeepSeek / OpenAI 兼容接口的最小封装
 *
 * 只做三件事：连通性自检、分块翻译、整篇改写。
 * 所有网络失败都抛出带人话说明的错误，由 UI 原样展示。
 */

const store = require('./store');

function storedApi() {
  try { return store.get().settings.api || {}; } catch { return {}; }
}

function cfg(override) {
  const stored = storedApi();
  const a = override && typeof override === 'object' ? { ...stored, ...override } : stored;
  return {
    baseUrl: String(a.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    key: String(a.key || '').trim(),
    model: String(a.model || 'deepseek-chat'),
    temperature: typeof a.temperature === 'number' ? a.temperature : 0.3
  };
}

/** AI 通道的错误：带结构化 kind / status，UI 与日志都据此分类 */
function aiError(message, extra = {}) {
  const e = new Error(message);
  e.ai = true;
  Object.assign(e, extra);
  return e;
}

function assertReady(override) {
  const c = cfg(override);
  if (!c.key) {
    throw aiError('尚未配置 API Key。请到「设置 → AI 接口」填入后重试。', { kind: 'config' });
  }
  return c;
}

/** 只按真实 HTTP status 分类，绝不对任意文本里的数字猜状态码 */
function httpMessage(status, detail) {
  const tail = detail ? `（${String(detail).slice(0, 160)}）` : '';
  if (status === 401) return `API Key 无效或已失效（401）${tail}。请到「设置 → AI 接口」核对 Key。`;
  if (status === 402) return `账户余额不足（402）${tail}。请先充值后重试。`;
  if (status === 403) return `请求被拒绝（403）${tail}：当前 Key 没有访问该模型的权限。`;
  if (status === 404) return `接口或模型路径不存在（404）${tail}。请检查 Base URL 是否需要带 /v1，以及模型名是否正确。`;
  if (status === 429) return `请求过于频繁或额度受限（429）${tail}，稍后再试。`;
  if (status >= 500) return `服务端错误（${status}）${tail}，这是服务方的问题，稍后重试。`;
  if (status >= 400) return `请求被拒绝（${status}）${tail}。`;
  return `接口返回了意外状态（${status}）${tail}。`;
}

const NET_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

/**
 * 从 fetch 的错误链里挖出真实网络错误码。
 * undici 会把它包成 `TypeError: fetch failed`，真正的 code 藏在
 * cause 里；多地址场景还可能是 AggregateError（cause.errors[]）。
 */
function netCode(err, depth = 0) {
  if (!err || depth > 4) return '';
  const code = String(err.code || '');
  if (NET_CODES.has(code.toUpperCase())) return code;
  const nested = err.cause;
  if (nested) {
    const hit = netCode(nested, depth + 1);
    if (hit) return hit;
  }
  const list = err.errors || (nested && nested.errors);
  if (Array.isArray(list)) {
    for (const item of list) {
      const hit = netCode(item, depth + 1);
      if (hit) return hit;
    }
  }
  return '';
}

/**
 * 只把「AI 通道自己的错误」翻译成人话。
 * 本地文件错误（如 `.../401-skill/SKILL.md 不存在`）必须原样透传 ——
 * 006 轮对任意文本搜 401/402/429，把路径里的数字也当成了鉴权失败。
 */
function friendly(err) {
  if (err && err.ai) return err.message;
  return String((err && err.message) || err);
}

async function chat(messages, opts = {}) {
  const c = assertReady(opts.api);
  const url = `${c.baseUrl}/chat/completions`;
  const body = {
    model: opts.model || c.model,
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : c.temperature,
    stream: false
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools) body.tools = opts.tools;

  const ctrl = new AbortController();
  const cancel = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 120000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.key}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
      } catch { /* 错误体不是 JSON，忽略 */ }
      throw aiError(httpMessage(res.status, detail), { kind: 'http', status: res.status });
    }

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // 正文读到一半被超时打断 —— 这是超时，不是结构错误
      if (ctrl.signal.aborted || (e && e.name === 'AbortError')) throw e;
      throw aiError(`接口返回的不是合法 JSON（HTTP ${res.status}）。请检查 Base URL 是否指向 OpenAI 兼容端点。`, {
        kind: 'structure', status: res.status
      });
    }
    const message = json?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== 'string' && !(opts.tools && Array.isArray(message?.tool_calls) && message.tool_calls.length)) {
      throw aiError('接口返回结构异常：缺少 choices[0].message.content。请确认模型名与端点匹配。', {
        kind: 'structure', status: res.status
      });
    }
    return {
      content: content || '',
      ...(opts.tools ? { toolCalls: message.tool_calls || [] } : {}),
      usage: json.usage || null,
      model: json.model || body.model
    };
  } catch (e) {
    if (e && e.ai) throw e;
    if (ctrl.signal.aborted || (e && e.name === 'AbortError')) {
      throw aiError('请求超时：模型在规定时间内没有返回，检查网络或换更快的模型。', { kind: 'timeout' });
    }
    const code = netCode(e);
    if (code) {
      throw aiError(`网络不可达（${code}）：检查代理、DNS 或 Base URL 是否可访问。`, { kind: 'network', code });
    }
    throw aiError('请求失败：' + ((e && e.message) || String(e)), { kind: 'unknown' });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', cancel);
  }
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
      const seen = new Set();
      for (const p of pairs) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const s = String(p[0] || '').trim();
        const d = String(p[1] || '').trim();
        // 只收「能在原文/译文里字面找到」的词对 —— 找不到就没法高亮，留着也是噪音
        if (!s || !d) continue;
        // 跨行词对 = 跨列表项/段落，一定是错的；超长词条也不是词级对应
        if (s.includes('\n') || d.includes('\n')) continue;
        if (s.length > 60 || d.length > 60) continue;
        if (!String(it.s).includes(s) || !String(it.d).includes(d)) continue;
        const sig = s + '\u0000' + d;
        if (seen.has(sig)) continue;
        seen.add(sig);
        clean.push([s, d]);
        if (clean.length >= 16) break;
      }
      if (clean.length) out[it.i] = clean;
    });
  }
  return out;
}

async function testConnection(override) {
  const c = assertReady(override);
  const t0 = Date.now();
  const res = await chat(
    [{ role: 'user', content: 'Reply with the single word: ok' }],
    { temperature: 0, timeout: 30000, maxTokens: 8, api: override }
  );
  return {
    ok: true,
    model: res.model,
    ms: Date.now() - t0,
    sample: res.content.trim().slice(0, 40),
    baseUrl: c.baseUrl
  };
}

module.exports = {
  cfg, chat, translateSegments, alignSegments, rewriteSkill, testConnection,
  friendly, aiError, httpMessage, NET_CODES
};
