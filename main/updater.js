'use strict';

// Release metadata and downloads always belong to this repository.
const REPO = 'kelai061/skill-manage';
const RELEASES = `https://github.com/${REPO}/releases`;
const IDENTIFIER = '(?:0|[1-9]\\d*)';
const SEMVER = new RegExp(`^v?(${IDENTIFIER})\\.(${IDENTIFIER})\\.(${IDENTIFIER})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`, 'i');

function parseVer(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: match.slice(1, 4), pre, version: value.replace(/^v/i, '') };
}

function compareNumber(a, b) {
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a === b ? 0 : a > b ? 1 : -1;
}

function cmp(a, b) {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) throw new Error('版本号格式无效，应使用 major.minor.patch。');
  for (let i = 0; i < 3; i++) {
    const difference = compareNumber(x.core[i], y.core[i]);
    if (difference) return difference;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return compareNumber(x.pre[i], y.pre[i]);
    if (xn !== yn) return xn ? -1 : 1;
    return x.pre[i] > y.pre[i] ? 1 : -1;
  }
  return 0;
}

class UpdateError extends Error {}

function conciseNotes(body) {
  const section = String(body || '').split(/^##\s+/m).find((part) => /^v?\d+\.\d+\.\d+/.test(part.trim())) || String(body || '');
  return section.split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line))
    .slice(0, 4).map((line) => line.replace(/^\s*[-*]\s+/, '• ').replace(/[*`]/g, '').trim().slice(0, 100)).join('\n').slice(0, 400);
}

async function check(current, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (!parseVer(current)) throw new UpdateError('当前应用版本号无效，无法检查更新。');
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  try {
    // Cover the complete response body too. Some proxies return headers then stall.
    const request = (async () => {
      const response = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': 'SkillAtelier', Accept: 'application/vnd.github+json' },
        signal: controller.signal
      });
      if (response.status === 404) {
        return { current, latest: current, hasUpdate: false, url: RELEASES, notes: '', publishedAt: '', repo: REPO, empty: true };
      }
      if (response.status === 403 || response.status === 429) throw new UpdateError('GitHub API 请求受限，请稍后再试。');
      if (!response.ok) throw new UpdateError(`检查更新失败（HTTP ${response.status}）。`);
      let release;
      try { release = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new UpdateError('GitHub 返回的更新信息无效，请稍后重试。');
      }
      const version = parseVer(release?.tag_name);
      if (!version) throw new UpdateError('GitHub 发布版本号无效，请稍后重试。');
      const officialUrl = `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}`;
      return {
        current, latest: version.version,
        hasUpdate: release.draft !== true && release.prerelease !== true && !version.pre.length && cmp(version.version, current) > 0,
        url: officialUrl,
        notes: conciseNotes(release.body),
        publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
        repo: REPO,
        tag: release.tag_name,
        assets: (Array.isArray(release.assets) ? release.assets : [])
          .filter((asset) => typeof asset.name === 'string' && /^(?:SHA256SUMS\.txt|SkillAtelier-[\w.+-]+\.(?:exe|zip))$/.test(asset.name))
          .map((asset) => ({ name: asset.name, size: Number(asset.size) || 0 }))
      };
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new UpdateError('检查更新超时，请稍后重试。'));
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (timedOut || /abort/i.test(String(error?.name))) throw new UpdateError('检查更新超时，请稍后重试。');
    if (error instanceof UpdateError) throw error;
    throw new UpdateError('网络不可达，无法访问 GitHub（可能需要代理）。');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { check, cmp, parseVer, conciseNotes, REPO };
