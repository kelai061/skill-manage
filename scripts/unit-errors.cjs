'use strict';
/**
 * unit-errors.cjs — 012 轮「错误分类」单测（E01 / E02 / E03 的纯逻辑部分）
 *
 * 只起本机模拟接口，不联网、不用真实 Key。
 * 断言重点：分类必须来自真实 HTTP status / 网络 code，绝不能对正文里的数字猜。
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../main/aiService');

let pass = 0;
const fails = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fails.push({ name, message: e.message });
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

const routes = {
  '/c401': () => ({ status: 401, body: { error: { message: 'invalid api key' } } }),
  '/c402': () => ({ status: 402, body: { error: { message: 'Insufficient Balance' } } }),
  '/c404': () => ({ status: 404, body: { error: { message: 'model not found' } } }),
  '/c429': () => ({ status: 429, body: { error: { message: 'rate limit' } } }),
  // 5xx 正文里塞 401/402/429 —— 不能被误判成鉴权/余额/限流
  '/c500': () => ({ status: 500, body: { error: { message: 'request_id=401 upstream 402 429' } } }),
  '/c503': () => ({ status: 503, body: { error: { message: 'request_id=429' } } }),
  '/badjson': () => ({ status: 200, raw: 'not-json-at-all' }),
  '/nocontent': () => ({ status: 200, body: { model: 'm', choices: [] } }),
  '/ok': (body) => ({
    status: 200,
    body: { model: body.model || 'm', choices: [{ message: { content: 'ok' } }] }
  }),
  '/slow': () => ({ delay: 3000, status: 200, body: { model: 'm', choices: [{ message: { content: 'ok' } }] } })
};

let seenModel = '';

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* ignore */ }
  seenModel = body.model || '';

  const key = Object.keys(routes).find((k) => req.url.startsWith(k));
  const out = key ? routes[key](body) : { status: 404, body: {} };
  const send = () => {
    if (out.raw !== undefined) {
      res.writeHead(out.status, { 'Content-Type': 'text/plain' });
      res.end(out.raw);
      return;
    }
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  };
  if (out.delay) setTimeout(send, out.delay);
  else send();
});

const call = (prefix, opts = {}) => ai.chat(
  [{ role: 'user', content: 'hi' }],
  {
    api: { baseUrl: `http://127.0.0.1:${server.address().port}${prefix}`, key: 'fixture-key', model: 'fixture-model' },
    timeout: 5000,
    ...opts
  }
);

const rejects = async (fn, pattern) => {
  try {
    await fn();
  } catch (e) {
    assert.match(e.message, pattern);
    return e;
  }
  throw new Error('预期抛错，但没有抛');
};

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log('\n[unit] HTTP 状态分类（E01）');

  await t('401 → Key 无效', () => rejects(() => call('/c401'), /API Key 无效.*401/));
  await t('402 → 余额不足', () => rejects(() => call('/c402'), /余额不足.*402/));
  await t('404 → 接口/模型路径不符', () => rejects(() => call('/c404'), /接口或模型路径不存在.*404/));
  await t('429 → 请求过于频繁', () => rejects(() => call('/c429'), /请求过于频繁.*429/));
  await t('500（正文含 request_id=401/402/429）→ 服务端错误，不误判鉴权', async () => {
    const e = await rejects(() => call('/c500'), /服务端错误.*500/);
    assert.doesNotMatch(e.message, /API Key 无效|余额不足|请求过于频繁/);
    assert.equal(e.status, 500);
  });
  await t('503 → 服务端错误', () => rejects(() => call('/c503'), /服务端错误.*503/));

  console.log('\n[unit] 结构 / 网络 / 超时（E02）');
  await t('200 但不是 JSON → 结构错误，不说 Key 无效', async () => {
    const e = await rejects(() => call('/badjson'), /不是合法 JSON/);
    assert.equal(e.kind, 'structure');
  });
  await t('200 缺 choices → 结构异常', async () => {
    const e = await rejects(() => call('/nocontent'), /结构异常/);
    assert.equal(e.kind, 'structure');
  });
  await t('连接被拒绝 → 网络不可达', async () => {
    // 先占一个端口再关掉，保证它是「没人监听」而不是 fetch 禁止的端口
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const e = await rejects(() => ai.chat([{ role: 'user', content: 'hi' }], {
      api: { baseUrl: `http://127.0.0.1:${deadPort}`, key: 'k', model: 'm' }, timeout: 3000
    }), /网络不可达/);
    assert.equal(e.kind, 'network');
  });
  await t('响应挂起 → 超时', async () => {
    const e = await rejects(() => call('/slow', { timeout: 400 }), /请求超时/);
    assert.equal(e.kind, 'timeout');
  });

  console.log('\n[unit] 本地错误不被 AI 分类污染（E02）');
  await t('路径里带 401 的本地错误原样透传', () => {
    const raw = 'D:\\skills\\401-skill\\SKILL.md 不存在';
    assert.equal(ai.friendly(new Error(raw)), raw);
  });
  await t('本地 500 / 402 文本也不会被当成 AI 错误', () => {
    assert.equal(ai.friendly(new Error('备份目录 402 不可写')), '备份目录 402 不可写');
  });
  await t('AI 错误仍然翻译成人话', () => {
    const e = new Error('API Key 无效或已失效（401）。');
    e.ai = true;
    assert.match(ai.friendly(e), /API Key 无效/);
  });

  console.log('\n[unit] 测试连接使用表单快照（E03）');
  await t('override 里的 model 真的被发到接口', async () => {
    const r = await ai.testConnection({
      baseUrl: `http://127.0.0.1:${server.address().port}/ok`,
      key: 'snapshot-key',
      model: 'snapshot-model'
    });
    assert.equal(r.ok, true);
    assert.equal(seenModel, 'snapshot-model');
  });
  await t('没有 Key 时给出配置提示，不发请求', async () => {
    await rejects(() => ai.testConnection({ baseUrl: 'http://127.0.0.1:45678', key: '', model: 'm' }), /尚未配置 API Key/);
  });

  console.log(`\n[unit] ${pass}/${pass + fails.length} 通过`);
  server.close();
  if (fails.length) {
    for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
