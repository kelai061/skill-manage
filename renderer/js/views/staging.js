/* views/staging.js — 暂存区：粘贴链接导入 + 攒够阈值后归位 */

import { icon } from '../icons.js';
import { state, refresh } from '../state.js';
import { api } from '../api.js';
import { esc, shortPath, fmtTime } from '../util.js';
import { toast, dialog, confirm, emptyState, busyButton } from '../ui.js';

let cache = null;

export async function renderStaging(host) {
  host.innerHTML = `<div class="page-head"><p>读取暂存区…</p></div>`;
  try {
    cache = await api.staging();
  } catch (e) {
    host.innerHTML = `<div class="page-head"><p style="color:var(--md-error)">${esc(e.message)}</p></div>`;
    return;
  }

  const { root, exists, items = [], skillCount = 0, threshold = 6, other = [], categories = [] } = cache;
  const pct = Math.min(100, Math.round((skillCount / Math.max(1, threshold)) * 100));

  host.innerHTML = `
    <div class="page-head">
      <p>${skillCount} 个待整理</p>
      <button class="btn btn--outlined btn--sm" id="setRoot">${icon('folder')}${root ? '更换暂存目录' : '设置暂存目录'}</button>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card__head">
        <div class="card__avatar" style="background:var(--md-primary-container);color:var(--md-on-primary-container)">
          ${icon('zap', 'icon--sm')}
        </div>
        <div style="min-width:0;flex:1">
          <h3 class="card__title">暂存目录</h3>
          <div class="card__meta mono truncate" title="${esc(root || '')}">
            ${root ? esc(shortPath(root, 62)) : '尚未设置（请选择接收新 skill 的文件夹）'}
          </div>
        </div>
        ${root ? `<button class="btn btn--text btn--sm" id="openRoot">${icon('external')}打开</button>` : ''}
      </div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card__head">
        <div class="card__avatar" style="background:var(--md-secondary-container);color:var(--md-on-secondary-container)">
          ${icon('arrowRight', 'icon--sm')}
        </div>
        <div style="min-width:0;flex:1">
          <h3 class="card__title">粘贴链接导入</h3>
          <div class="card__meta">支持 GitHub 仓库 / 仓库子目录 / zip 直链 / SKILL.md 直链</div>
        </div>
      </div>
      <div class="row" style="margin-top:4px">
        <input class="input input--mono" id="impUrl" style="flex:1"
          placeholder="https://github.com/owner/repo 或 https://…/SKILL.md" ${root ? '' : 'disabled'} />
        <button class="btn btn--filled btn--sm" id="impBtn" ${root ? '' : 'disabled'}>${icon('plus')}导入</button>
      </div>
      <div id="impResult" class="muted" style="font:var(--type-body-s);margin-top:6px"></div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="row" style="gap:12px">
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:8px">
            <h3 class="card__title" style="margin:0">待归档</h3>
            <span class="badge badge--primary">${skillCount} / ${threshold}</span>
            ${skillCount >= threshold ? '<span class="badge badge--success">可以归位了</span>' : ''}
          </div>
          <div class="progress" style="margin-top:10px"><i class="progress__bar" style="width:${pct}%;animation:none"></i></div>
        </div>
        <button class="btn btn--tonal btn--sm" id="organizeBtn" ${skillCount ? '' : 'disabled'}>
          ${icon('sparkles')}整理归位
        </button>
      </div>

      <div style="margin-top:14px;display:flex;flex-direction:column;gap:2px">
        ${items.length ? items.map((it) => `
          <div class="list-item" data-item="${esc(it.dir)}">
            <span style="color:var(--md-on-surface-variant)">${icon('file', 'icon--sm')}</span>
            <div class="list-item__body">
              <div class="list-item__title truncate">${esc(it.name)}</div>
              <div class="list-item__sub truncate">${esc((it.description || '（无描述）').slice(0, 90))}</div>
            </div>
            <span class="badge">${it.words} 字</span>
            <button class="iconbtn iconbtn--sm" data-open data-tip="打开目录">${icon('external')}</button>
          </div>`).join('')
          : `<p class="muted" style="font:var(--type-body-m);margin:6px 0">
              ${exists ? '暂存区里还没有 skill。' : '暂存目录还不存在，先设置一个。'}
             </p>`}
      </div>

      ${other.length ? `<div class="chip-row" style="margin-top:10px">
        ${other.slice(0, 6).map((o) => `<span class="badge badge--warn">${esc(o)}</span>`).join('')}
      </div>` : ''}

      ${categories.length ? `<div class="chip-row" style="margin-top:12px">
        <span class="muted" style="font:var(--type-body-s)">现有分类：</span>
        ${categories.map((c) => `<span class="badge">${esc(c.name)} · ${c.count}</span>`).join('')}
      </div>` : ''}
    </section>
  `;

  /* ---------------- 目录设置 ---------------- */
  host.querySelector('#setRoot').addEventListener('click', async () => {
    const r = await api.pickPath('dir');
    if (!r.path) return;
    await api.setStagingRoot(r.path);
    toast('暂存目录已更新', 'success');
    renderStaging(host);
  });
  host.querySelector('#openRoot')?.addEventListener('click', () => api.openPath(root));

  /* ---------------- 导入 ---------------- */
  const input = host.querySelector('#impUrl');
  const btn = host.querySelector('#impBtn');
  const out = host.querySelector('#impResult');

  const doImport = async () => {
    const url = input.value.trim();
    if (!url) return toast('先粘贴一个链接', 'error');
    busyButton(btn, true);
    out.innerHTML = `<span class="row" style="gap:8px"><span class="spinner"></span>正在下载…</span>`;
    try {
      const r = await api.importUrl(url);
      input.value = '';
      const names = r.imported.map((x) => x.name).join('、');
      out.innerHTML = `<span style="color:var(--md-success)">已导入：${esc(names)}</span>`;
      await refresh('data');
      await renderStaging(host);
      if (r.reached) {
        toast(`暂存区已有 ${r.skillCount} 个 skill，可以归位了`, 'success', {
          actionLabel: '现在整理',
          onAction: () => host.querySelector('#organizeBtn')?.click()
        });
      } else {
        toast(`已导入 ${r.imported.length} 个，暂存区共 ${r.skillCount} 个`, 'success');
      }
    } catch (e) {
      out.innerHTML = `<span style="color:var(--md-error)">${esc(e.message)}</span>`;
      toast(e.message, 'error');
    } finally {
      busyButton(btn, false);
    }
  };

  btn?.addEventListener('click', doImport);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });

  host.querySelectorAll('[data-item]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-open]')) api.openPath(row.dataset.item);
    });
  });

  /* ---------------- 整理 ---------------- */
  host.querySelector('#organizeBtn')?.addEventListener('click', () => openOrganize(host));
}

async function openOrganize(host) {
  let proposal = null;

  const d = dialog({
    title: '整理归位',
    subtitle: 'AI 先给分类建议，你可以逐条改；确认后才会移动文件夹',
    wide: true,
    body: `<div id="orgBody"><div class="row" style="gap:10px;color:var(--md-on-surface-variant)">
        <span class="spinner"></span><span style="font:var(--type-body-s)">正在让 AI 读一遍这些 skill…</span>
      </div></div>`,
    actions: [
      { label: '取消' },
      {
        label: '确认移动',
        kind: 'filled',
        disabled: true,
        keepOpen: true,
        onClick: async (ref) => {
          if (!proposal) return;
          const moves = [...ref.body.querySelectorAll('[data-mv]')].map((row) => ({
            from: row.dataset.mv,
            category: row.querySelector('input').value.trim()
          })).filter((m) => m.category);
          if (!moves.length) { toast('至少给一个 skill 指定分类', 'error'); return false; }

          const ok = await confirm({
            title: `移动 ${moves.length} 个 skill？`,
            text: '会把暂存区里的文件夹移动到对应的分类目录下。同名目录会自动加后缀，不会覆盖。',
            confirmText: '移动'
          });
          if (!ok) return false;

          try {
            const r = await api.organizeApply(moves);
            ref.close();
            await refresh('data');
            await renderStaging(host);
            if (r.failed) toast(`已移动 ${r.okCount} 个，失败 ${r.failed} 个`, 'error');
            else toast(`已归位 ${r.okCount} 个 skill`, 'success');
          } catch (e) {
            toast(e.message, 'error');
          }
          return false;
        }
      }
    ]
  });

  const body = d.body.querySelector('#orgBody');
  const applyBtn = d.root.querySelector('.dialog__foot .btn--filled');

  try {
    proposal = await api.organizePropose(cache?.root || '');
  } catch (e) {
    body.innerHTML = `<p style="color:var(--md-error);font:var(--type-body-m)">${esc(e.message)}</p>
      <p class="muted" style="font:var(--type-body-s)">可以直接手动填写分类，或者去「设置 → AI 接口」检查 Key。</p>`;
  }

  const cats = (cache?.categories || []).map((c) => c.name);
  const items = proposal?.items || (cache?.items || []).map((i) => ({ ...i, category: '', reason: '' }));

  if (!items.length) {
    body.innerHTML = '<p class="muted">暂存区里没有可归档的 skill。</p>';
    return;
  }

  body.innerHTML = `
    <datalist id="catList">${cats.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
    <div style="display:flex;flex-direction:column;gap:2px">
      ${items.map((it) => `
        <div class="list-item" data-mv="${esc(it.dir)}" style="align-items:flex-start">
          <div class="list-item__body">
            <div class="list-item__title">${esc(it.name)}</div>
            <div class="list-item__sub">${esc(it.reason || '')}</div>
          </div>
          <input class="input" list="catList" value="${esc(it.category || '')}" placeholder="分类名"
            style="width:170px;flex:0 0 170px" />
        </div>`).join('')}
    </div>
    <p class="muted" style="font:var(--type-body-s);margin-top:10px">
      分类名会直接作为 ${esc(proposal?.root || cache?.root || '')} 下的文件夹名。填一个新名字就等于新建分类。
    </p>`;

  applyBtn.disabled = false;
}
