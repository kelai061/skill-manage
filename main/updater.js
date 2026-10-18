'use strict';
/**
 * updater.js — 从 GitHub Releases 检查新版本
 *
 * 只做「检查」：请求 latest release，比较版本号，返回更新说明与下载页链接。
 * 不做静默下载/自动替换（绿色版替换正在运行的 exe 在 Windows 上不可靠）。
 *
 * 仓库地址写死在代码里，不开放给用户填：产品只有一个官方发布源，
 * 让用户填 owner/repo 只会制造「填错了就查不到更新」的假故障。
 */

const REPO = 'kelai061/skill-manage';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => parseInt(x, 10) || 0);
}

function cmp(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function check(current) {
  const r = REPO;
  if (!REPO_RE.test(r)) throw new Error('内置更新仓库格式不对，应为 owner/repo。');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${r}/releases/latest`, {
      headers: { 'User-Agent': 'SkillAtelier', Accept: 'application/vnd.github+json' },
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (/abort/i.test(String(e && e.name))) throw new Error('检查更新超时，请稍后重试。');
    throw new Error('网络不可达，无法访问 GitHub（可能需要代理）。');
  }
  clearTimeout(timer);

  if (res.status === 404) {
    // 仓库还没发过 Release：这不是错误，只是「暂时没有新版本」
    return {
      current,
      latest: current,
      hasUpdate: false,
      url: `https://github.com/${r}/releases`,
      notes: '',
      publishedAt: '',
      repo: r,
      empty: true
    };
  }
  if (res.status === 403) throw new Error('GitHub API 限流（403），稍后再试。');
  if (!res.ok) throw new Error(`检查更新失败（HTTP ${res.status}）`);

  const j = await res.json();
  const latest = String(j.tag_name || j.name || '').replace(/^v/i, '') || current;
  return {
    current,
    latest,
    hasUpdate: cmp(latest, current) > 0,
    url: j.html_url || `https://github.com/${r}/releases`,
    notes: String(j.body || '').slice(0, 4000),
    publishedAt: j.published_at || '',
    repo: r
  };
}

module.exports = { check, cmp, REPO };
