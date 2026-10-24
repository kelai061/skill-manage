/* views/groups.js — 分组管理 */

import { icon } from '../icons.js';
import { state, groups, groupsOf, refresh } from '../state.js';
import { api } from '../api.js';
import { esc, toneVar, TONES } from '../util.js';
import { toast, dialog, confirm, promptText, emptyState, menu } from '../ui.js';
import { openReader } from './reader.js';

function countOf(gid) {
  const map = state.config.skillGroups || {};
  return Object.values(map).filter((arr) => arr.includes(gid)).length;
}

function membersOf(gid) {
  const map = state.config.skillGroups || {};
  const ids = Object.keys(map).filter((k) => map[k].includes(gid));
  return state.config.skills.filter((s) => ids.includes(s.id));
}

/* ------------------------- 新建 / 编辑分组 ------------------------- */

export function openGroupEditor(group = null) {
  const isEdit = !!group;
  let color = group ? group.color : TONES[Math.floor(Math.random() * TONES.length)];

  const d = dialog({
    title: isEdit ? '编辑分组' : '新建分组',
    subtitle: '分组只存引用，不会移动或复制任何源文件。',
    body: `
      <label class="field">
        <span class="field__label">分组名称</span>
        <input class="input" id="gname" value="${esc(group ? group.name : '')}" placeholder="例如：前端 / 写作 / 已归档" />
      </label>
      <div class="field">
        <span class="field__label">标识色</span>
        <div class="chip-row" id="colors">
          ${TONES.map((t) => `
            <button class="seltool__swatch" data-color="${t}" style="background:${toneVar(t)};width:30px;height:30px;
              border-color:${t === color ? 'var(--md-on-surface)' : 'transparent'}"></button>`).join('')}
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '创建',
        kind: 'filled',
        keepOpen: true,
        onClick: async (apiRef) => {
          const name = apiRef.body.querySelector('#gname').value.trim();
          if (!name) { toast('请填写分组名称', 'error'); return false; }
          if (isEdit) await api.updateGroup(group.id, { name, color });
          else await api.createGroup(name, color);
          apiRef.close();
          await refresh('data');
          toast(isEdit ? '分组已更新' : '分组已创建', 'success');
        }
      }
    ],
    onMount(apiRef) {
      setTimeout(() => apiRef.body.querySelector('#gname').focus(), 60);
      apiRef.body.querySelectorAll('[data-color]').forEach((b) => {
        b.addEventListener('click', () => {
          color = b.dataset.color;
          apiRef.body.querySelectorAll('[data-color]').forEach((x) => {
            x.style.borderColor = x === b ? 'var(--md-on-surface)' : 'transparent';
          });
        });
      });
      apiRef.body.querySelector('#gname').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apiRef.root.querySelector('.dialog__foot .btn--filled').click();
      });
    }
  });
  return d;
}

/* ------------------------- 给 skill 指派分组 ------------------------- */

export function openAssignGroups(skillIds) {
  return new Promise((resolve) => {
    const ids = Array.isArray(skillIds) ? skillIds : [skillIds];
    const first = state.config.skills.find((s) => s.id === ids[0]);
    const current = first ? groupsOf(first.id).map((g) => g.id) : [];
    const checked = new Set(ids.length === 1 ? current : []);

    const listHtml = () => groups().length
      ? groups().map((g) => `
        <label class="list-item" style="cursor:pointer">
          <input type="checkbox" data-g="${g.id}" ${checked.has(g.id) ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:${toneVar(g.color)}" />
          <span class="chip__dot" style="background:${toneVar(g.color)};width:10px;height:10px"></span>
          <div class="list-item__body">
            <div class="list-item__title">${esc(g.name)}</div>
            <div class="list-item__sub">${countOf(g.id)} 个 skill</div>
          </div>
        </label>`).join('')
      : `<p class="muted" style="margin:8px 0">还没有分组，先在下面新建一个。</p>`;

    const d = dialog({
      title: ids.length > 1 ? `为 ${ids.length} 个 skill 设置分组` : '设置所属分组',
      subtitle: ids.length > 1 ? '将覆盖这些 skill 原有的分组归属。' : '一个 skill 可以同时属于多个分组。',
      body: `<div id="glist" style="display:flex;flex-direction:column;gap:2px">${listHtml()}</div>
        <div class="row" style="margin-top:4px">
          <input class="input" id="newg" placeholder="新分组名称" style="flex:1" />
          <button class="btn btn--tonal btn--sm" id="addg">${icon('plus')}新建</button>
        </div>`,
      actions: [
        { label: '取消', onClick: () => resolve(null) },
        {
          label: '应用',
          kind: 'filled',
          onClick: async (apiRef) => {
            const picked = [...apiRef.body.querySelectorAll('[data-g]:checked')].map((x) => x.dataset.g);
            for (const id of ids) await api.setGroups(id, picked);
            await refresh('data');
            toast('分组已更新', 'success');
            resolve(picked);
          }
        }
      ]
    });

    d.body.querySelector('#addg').addEventListener('click', async () => {
      const name = d.body.querySelector('#newg').value.trim();
      if (!name) return;
      const g = await api.createGroup(name, TONES[Math.floor(Math.random() * TONES.length)]);
      checked.add(g.id);
      await refresh('data');
      d.body.querySelector('#glist').innerHTML = listHtml();
      d.body.querySelector('#newg').value = '';
      toast('分组已创建', 'success');
    });

    const orig = d.close;
    d.close = () => { orig(); resolve(null); };
  });
}

/* ------------------------------- 页面 ------------------------------- */

export function renderGroups(host) {
  const gs = groups();

  host.innerHTML = `
    <div class="page-head">
      <p>${gs.length} 个分组</p>
      <button class="btn btn--filled btn--sm" id="newGroup">${icon('plus')}新建分组</button>
    </div>
    ${gs.length ? `<div class="grid">${gs.map((g) => {
      const members = membersOf(g.id).slice(0, 4);
      const n = countOf(g.id);
      return `
        <article class="card card--outlined card--interactive group-tile" data-gid="${g.id}" role="button" tabindex="0" aria-label="打开分组 ${esc(g.name)}">
          <div class="card__head">
            <div class="card__avatar" style="background:${toneVar(g.color)};width:36px;height:36px;border-radius:12px">
              ${icon('folder', 'icon--sm')}
            </div>
            <div style="min-width:0;flex:1">
              <h3 class="card__title">${esc(g.name)}</h3>
              <div class="card__meta">${n} 个 skill</div>
            </div>
            <button class="iconbtn iconbtn--sm" data-more aria-label="分组操作">${icon('more')}</button>
          </div>
          <div class="chip-row">
            ${members.map((s) => `<span class="badge">${esc(s.name)}</span>`).join('')}
            ${n > 4 ? `<span class="badge">+${n - 4}</span>` : ''}
            ${n === 0 ? '<span class="muted" style="font:var(--type-body-s)">空分组</span>' : ''}
          </div>
          <div class="card__foot">
            <span class="group-tile__open" aria-hidden="true">${icon('arrowRight','icon--sm')}</span>
            <span class="spacer"></span>
            <button class="iconbtn iconbtn--sm" data-edit aria-label="编辑分组" data-tip="重命名">${icon('edit')}</button>
          </div>
        </article>`;
    }).join('')}</div>` : emptyState({
      iconName: 'folder',
      title: '还没有分组',
      text: '分组用来把同一类 skill 聚在一起，比如「前端」「写作」「实验性」。',
      action: `<button class="btn btn--filled" data-new>${icon('plus')}新建第一个分组</button>`
    })}
  `;

  host.querySelector('#newGroup')?.addEventListener('click', () => openGroupEditor());
  host.querySelector('[data-new]')?.addEventListener('click', () => openGroupEditor());

  host.querySelectorAll('[data-gid]').forEach((cardEl) => {
    const gid = cardEl.dataset.gid;
    const g = groups().find((x) => x.id === gid);

    const enter = () => {
      Object.assign(state, { scope: 'all', groupId: gid, productId: null, projectId: null, collectionId: null, parentId: null, query: '', onlyFav: false });
      document.getElementById('searchInput').value = '';
      window.__goto('skills');
    };
    cardEl.addEventListener('click', e => { if (!e.target.closest('button, a, input')) enter(); });
    cardEl.addEventListener('keydown', e => {
      if (e.target === cardEl && ['Enter',' '].includes(e.key)) { e.preventDefault(); enter(); }
    });

    cardEl.querySelector('[data-edit]').addEventListener('click', () => openGroupEditor(g));

    cardEl.querySelector('[data-more]').addEventListener('click', (e) => {
      menu(e.currentTarget, [
        { label: '打开分组', icon: 'eye', onClick: enter },
        { label: '重命名 / 换色', icon: 'edit', onClick: () => openGroupEditor(g) },
        { sep: true },
        {
          label: '删除分组',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await confirm({
              title: `删除分组「${g.name}」？`,
              text: '只删除分组本身，组内 skill 与源文件都不受影响。',
              confirmText: '删除',
              danger: true
            });
            if (!ok) return;
            await api.deleteGroup(gid);
            if (state.groupId === gid) state.groupId = null;
            await refresh('data');
            toast('分组已删除', 'success');
          }
        }
      ], { alignRight: true });
    });
  });
}
