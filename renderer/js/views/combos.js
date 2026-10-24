/* views/combos.js — 组合与临时组合 */

import { icon } from '../icons.js';
import { state, combos, scratch, skillById, productName, refresh } from '../state.js';
import { api, copy } from '../api.js';
import { esc, shortPath } from '../util.js';
import { toast, dialog, confirm, promptText, emptyState, menu } from '../ui.js';
import { openReader } from './reader.js';

function skillRow(s, onRemove) {
  return `
    <div class="list-item" data-sid="${s.id}">
      <button class="iconbtn iconbtn--sm" data-open data-tip="阅读">${icon('book')}</button>
      <div class="list-item__body">
        <div class="list-item__title truncate">${esc(s.name)}</div>
        <div class="list-item__sub truncate mono">${esc(shortPath(s.dir, 60))}</div>
      </div>
      ${onRemove ? `<button class="iconbtn iconbtn--sm" data-remove data-tip="移出">${icon('x')}</button>` : ''}
    </div>`;
}

function copyPaths(ids, label) {
  if (!ids.length) return toast('组合是空的', 'error');
  api.copyCombo(ids).then((r) => {
    toast(`${label}：已复制 ${r.count} 条路径到剪贴板`, 'success', { duration: 2600 });
  }).catch((e) => toast(e.message, 'error'));
}

export function renderCombos(host) {
  const sc = scratch();
  const scIds = sc.skillIds || [];
  const scSkills = scIds.map(skillById).filter(Boolean);

  host.innerHTML = `
    <div class="page-head">
      <p>我的组合</p>
      <button class="btn btn--filled btn--sm" id="newCombo">${icon('plus')}新建组合</button>
    </div>

    <div class="card card--outlined" id="scratchCard"
      style="border-style:dashed;border-width:2px;margin-bottom:22px;background:var(--md-surface-container-low)">
      <div class="card__head">
        <div class="card__avatar" style="background:var(--md-tertiary-container);color:var(--md-on-tertiary-container)">
          ${icon('zap', 'icon--sm')}
        </div>
        <div style="min-width:0;flex:1">
          <h3 class="card__title">临时组合</h3>
          <div class="card__meta">
            <span>会话级暂存 · ${scSkills.length} 个 skill</span>
            ${sc.updatedAt ? `<span>·</span><span>${new Date(sc.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>` : ''}
          </div>
        </div>
        <div class="row">
          <button class="btn btn--tonal btn--sm" data-sc="copy" ${scSkills.length ? '' : 'disabled'}>${icon('copy')}复制路径</button>
          <button class="btn btn--outlined btn--sm" data-sc="promote" ${scSkills.length ? '' : 'disabled'}>${icon('star')}存为正式</button>
          <button class="btn btn--text btn--sm" data-sc="clear" ${scSkills.length ? '' : 'disabled'}>清空</button>
        </div>
      </div>
      ${scSkills.length
        ? `<div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">${scSkills.map((s) => skillRow(s, true)).join('')}</div>`
        : `<p class="muted" style="margin:6px 0 2px;font:var(--type-body-m)">
             在「全部 Skill」里点卡片右下角的 ＋，就能把 skill 丢进这里，随时凑一份临时清单。
           </p>`}
    </div>

    <div class="section-title">命名组合 <span class="count">${combos().length}</span></div>

    ${combos().length ? `<div class="grid grid--wide">${combos().map((c) => {
      const items = (c.skillIds || []).map(skillById).filter(Boolean);
      return `
        <article class="card" data-cid="${c.id}">
          <div class="card__head">
            <div class="card__avatar" style="background:var(--md-secondary-container);color:var(--md-on-secondary-container)">
              ${icon('layers', 'icon--sm')}
            </div>
            <div style="min-width:0;flex:1">
              <h3 class="card__title">${esc(c.name)}</h3>
              <div class="card__meta">${items.length} 个 skill${c.note ? ' · ' + esc(c.note) : ''}</div>
            </div>
            <button class="iconbtn iconbtn--sm" data-more>${icon('more')}</button>
          </div>
          <div class="chip-row">
            ${items.slice(0, 6).map((s) => `<span class="badge">${esc(s.name)}</span>`).join('')}
            ${items.length > 6 ? `<span class="badge">+${items.length - 6}</span>` : ''}
            ${items.length === 0 ? '<span class="muted" style="font:var(--type-body-s)">空组合</span>' : ''}
          </div>
          <div class="card__foot">
            <button class="btn btn--tonal btn--sm" data-copy ${items.length ? '' : 'disabled'}>${icon('copy')}复制路径</button>
            <button class="btn btn--text btn--sm" data-detail>展开</button>
          </div>
        </article>`;
    }).join('')}</div>` : emptyState({
      iconName: 'layers',
      title: '还没有命名组合',
      text: '选中多个 skill 后点「存为组合」，就能反复复用同一份清单。',
      action: `<button class="btn btn--filled" data-new>${icon('plus')}新建组合</button>`
    })}
  `;

  host.querySelector('#newCombo').addEventListener('click', () => createComboFlow([]));
  host.querySelector('[data-new]')?.addEventListener('click', () => createComboFlow([]));

  /* ---------------- 临时组合 ---------------- */
  const scCard = host.querySelector('#scratchCard');
  scCard.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sc]');
    if (b) {
      const act = b.dataset.sc;
      if (act === 'copy') return copyPaths(scIds, '临时组合');
      if (act === 'clear') {
        const ok = await confirm({ title: '清空临时组合？', text: '只清空暂存清单，不影响任何 skill 文件。', confirmText: '清空', danger: true });
        if (!ok) return;
        await api.clearScratch();
        await refresh('data');
        return;
      }
      if (act === 'promote') {
        const name = await promptText({
          title: '存为正式组合',
          subtitle: `把临时组合里的 ${scSkills.length} 个 skill 固化成一个命名组合。`,
          label: '组合名称',
          placeholder: '例如：重构三件套',
          confirmText: '保存'
        });
        if (!name) return;
        await api.promoteScratch(name);
        await refresh('data');
        toast('已存为正式组合', 'success');
      }
      return;
    }
    const row = e.target.closest('[data-sid]');
    if (row) {
      const sid = row.dataset.sid;
      if (e.target.closest('[data-remove]')) {
        await api.removeScratch(sid);
        await refresh('data');
      } else {
        openReader(sid);
      }
    }
  });

  /* ---------------- 命名组合 ---------------- */
  host.querySelectorAll('[data-cid]').forEach((cardEl) => {
    const cid = cardEl.dataset.cid;
    const c = combos().find((x) => x.id === cid);
    const items = (c.skillIds || []).map(skillById).filter(Boolean);

    cardEl.querySelector('[data-copy]').addEventListener('click', () => copyPaths(c.skillIds || [], c.name));
    cardEl.querySelector('[data-detail]').addEventListener('click', () => openComboDetail(c));

    cardEl.querySelector('[data-more]').addEventListener('click', (e) => {
      menu(e.currentTarget, [
        { label: '展开查看', icon: 'eye', onClick: () => openComboDetail(c) },
        { label: '复制路径', icon: 'copy', onClick: () => copyPaths(c.skillIds || [], c.name) },
        {
          label: '分享为 Markdown',
          icon: 'external',
          onClick: async () => {
            try {
              const r = await api.comboText(cid);
              await copy(r.text);
              toast('已复制 Markdown 清单，可直接粘贴分享', 'success', { duration: 2600 });
            } catch (e) { toast(e.message, 'error'); }
          }
        },
        { label: '重命名', icon: 'edit', onClick: async () => {
          const name = await promptText({ title: '重命名组合', label: '组合名称', value: c.name, confirmText: '保存' });
          if (!name) return;
          await api.updateCombo(cid, { name });
          await refresh('data');
        } },
        { sep: true },
        {
          label: '删除组合',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await confirm({ title: `删除组合「${c.name}」？`, text: '只删除这份清单，skill 文件不受影响。', confirmText: '删除', danger: true });
            if (!ok) return;
            await api.deleteCombo(cid);
            await refresh('data');
            toast('组合已删除', 'success');
          }
        }
      ], { alignRight: true });
    });
  });
}

async function createComboFlow(preset) {
  const picked = new Set(preset);
  const all = state.config.skills;

  const d = dialog({
    title: '新建组合',
    subtitle: '从已收录的 skill 中挑选成员。',
    wide: true,
    body: `
      <label class="field">
        <span class="field__label">组合名称</span>
        <input class="input" id="cname" placeholder="例如：前端重构工具箱" />
      </label>
      <div class="field">
        <span class="field__label">成员（已选 <b id="cnt">${picked.size}</b>）</span>
        <input class="input" id="cfilter" placeholder="过滤 skill…" />
        <div id="clist" style="max-height:320px;overflow:auto;margin-top:8px;display:flex;flex-direction:column;gap:1px"></div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建',
        kind: 'filled',
        keepOpen: true,
        onClick: async (apiRef) => {
          const name = apiRef.body.querySelector('#cname').value.trim();
          if (!name) return toast('请填写组合名称', 'error') && false;
          if (!picked.size) return toast('至少选择一个 skill', 'error') && false;
          await api.createCombo(name, [...picked]);
          apiRef.close();
          await refresh('data');
          toast(`组合「${name}」已创建`, 'success');
        }
      }
    ]
  });

  const list = d.body.querySelector('#clist');
  const cnt = d.body.querySelector('#cnt');

  const paint = (q = '') => {
    const kw = q.trim().toLowerCase();
    const rows = all.filter((s) => !kw ||
      s.name.toLowerCase().includes(kw) ||
      (s.description || '').toLowerCase().includes(kw) ||
      productName(s.productId).toLowerCase().includes(kw));
    list.innerHTML = rows.slice(0, 400).map((s) => `
      <label class="list-item" style="cursor:pointer">
        <input type="checkbox" data-pick="${s.id}" ${picked.has(s.id) ? 'checked' : ''}
          style="width:17px;height:17px;accent-color:var(--md-primary)" />
        <div class="list-item__body">
          <div class="list-item__title truncate">${esc(s.name)}</div>
          <div class="list-item__sub truncate">${esc(productName(s.productId))} · ${esc(shortPath(s.dir, 50))}</div>
        </div>
      </label>`).join('') || '<p class="muted" style="padding:12px">没有匹配项</p>';
    list.querySelectorAll('[data-pick]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) picked.add(cb.dataset.pick);
        else picked.delete(cb.dataset.pick);
        cnt.textContent = picked.size;
      });
    });
  };

  paint();
  d.body.querySelector('#cfilter').addEventListener('input', (e) => paint(e.target.value));
  setTimeout(() => d.body.querySelector('#cname').focus(), 60);
}

function openComboDetail(c) {
  const items = (c.skillIds || []).map(skillById).filter(Boolean);
  const d = dialog({
    title: c.name,
    subtitle: `${items.length} 个 skill · 复制后每行一条绝对路径`,
    wide: true,
    body: `<div style="display:flex;flex-direction:column;gap:1px">${items.map((s) => skillRow(s, false)).join('') || '<p class="muted">空组合</p>'}</div>
      <pre class="diff" style="max-height:180px;padding:10px 14px">${esc(items.map((s) => s.dir).join('\n'))}</pre>`,
    actions: [
      { label: '关闭' },
      { label: '复制路径', kind: 'filled', icon: 'copy', onClick: () => copyPaths(c.skillIds || [], c.name) }
    ]
  });
  d.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-open]')) {
      const row = e.target.closest('[data-sid]');
      if (row) openReader(row.dataset.sid);
    }
  });
}
