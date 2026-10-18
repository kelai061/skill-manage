'use strict';
/**
 * updater.js — 从 GitHub Releases 检查新版本
 *
 * 只做「检查」：请求 latest release，比较版本号，返回更新说明与下载页链接。
 * 不做静默下载/自动替换（绿色版替换正在运行的 exe 在 Windows 上不可靠）。
 */

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

async function check(repo, current) {
  const r = String(repo || '').trim();
  if (!r) throw new Error('还没有配置更新仓库。在设置里填 owner/repo（例如 yourname/skill-atelier）。');
  if (!REPO_RE.test(r)) throw new Error('仓库格式不对，应为 owner/repo。');

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

  if (res.status === 404) throw new Error(`仓库或 Release 不存在：${r}`);
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

module.exports = { check, cmp };
