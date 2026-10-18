/* views/products.js — 产品登记 · 项目层级 · 项目 skill 增删 */

import { icon } from '../icons.js';
import { state, products, refresh } from '../state.js';
import { api } from '../api.js';
import { esc, fmtTime, shortPath, debounce } from '../util.js';
import { toast, dialog, confirm, emptyState, menu, busyButton, promptText } from '../ui.js';

function counts(productId) {
  const all = state.config.skills.filter((s) => s.productId === productId);
  return {
    global: all.filter((s) => s.scope === 'global').length,
    project: all.filter((s) => s.scope === 'project').length,
    total: all.length
  };
}

function projectSkillCount(projectId) {
  return state.config.skills.filter((s) => s.projectId === projectId).length;
}

function rootsChips(p) {
  const roots = p.manualRoots || [];
  if (!roots.length) return '';
  return `<div class="chip-row">${roots.map((r) =>
    `<span class="badge" title="${esc(r.root)}">${icon('folder', 'icon--sm')}${esc(shortPath(r.root, 30))}</span>`).join('')}</div>`;
}

function projectRows(p) {
  const projs = p.projects || [];
  if (!projs.length) {
    return `<p class="muted" style="margin:4px 0;font:var(--type-body-s)">
      还没有登记项目。项目 skill 指某个项目文件夹里自带的 skill，不会和全局 skill 重复计数。
    </p>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:2px">
    ${projs.map((pr) => {
      const n = projectSkillCount(pr.id);
      return `
      <div class="list-item" data-prid="${pr.id}" style="padding:7px 8px;cursor:pointer">
        <span style="color:var(--md-on-surface-variant)">${icon('folder', 'icon--sm')}</span>
        <div class="list-item__body">
          <div class="list-item__title truncate" style="font-size:13px">${esc(pr.name)}</div>
          <div class="list-item__sub mono truncate" title="${esc(pr.path)}">${esc(shortPath(pr.path, 48))}</div>
        </div>
        ${pr.auto ? '<span class="badge badge--auto" data-tip="从 agent 工具里自动发现">自动</span>' : ''}
        <span class="badge ${n ? 'badge--project' : ''}">${n} 个 skill</span>
        <button class="iconbtn iconbtn--sm" data-pact="new" data-tip="新建 skill">${icon('plus')}</button>
        <button class="iconbtn iconbtn--sm" data-pact="rescan" data-tip="重新扫描">${icon('refresh')}</button>
        <button class="iconbtn iconbtn--sm" data-pact="more" data-tip="更多">${icon('more')}</button>
      </div>`;
    }).join('')}
  </div>`;
}

export function renderProducts(host) {
  const ps = products();

  host.innerHTML = `
    <div class="page-head">
      <p>一个产品 = 一套全局 skill + 若干项目；项目 skill 与全局 skill 分开计数</p>
      <button class="btn btn--filled btn--sm" id="addProduct">${icon('plus')}添加产品</button>
    </div>

    ${ps.length ? `<div class="grid grid--wide">${ps.map((p) => {
      const c = counts(p.id);
      const projs = p.projects || [];
      return `
        <article class="card" data-pid="${p.id}">
          <div class="card__head">
            <div class="card__avatar" style="background:var(--md-primary-container);color:var(--md-on-primary-container)">
              ${icon('cpu', 'icon--sm')}
            </div>
            <div style="min-width:0;flex:1">
              <h3 class="card__title">${esc(p.name)}</h3>
              <div class="card__meta mono truncate" title="${esc(p.launchPath)}">${esc(shortPath(p.launchPath, 44))}</div>
            </div>
            <button class="iconbtn iconbtn--sm" data-more>${icon('more')}</button>
          </div>

          <div class="row" style="gap:8px;flex-wrap:wrap">
            <span class="badge badge--primary">全局 ${c.global}</span>
            <span class="badge badge--project">项目 ${c.project}</span>
            <span class="badge">${projs.length} 个项目</span>
            <span class="badge">${p.lastScan ? '扫描于 ' + fmtTime(p.lastScan) : '未扫描'}</span>
            ${(p.hidden || []).length ? `<span class="badge badge--warn">隐藏 ${p.hidden.length}</span>` : ''}
          </div>

          ${rootsChips(p)}
          ${projectRows(p)}

          <div class="card__foot">
            <button class="btn btn--tonal btn--sm" data-rescan>${icon('refresh')}重新扫描</button>
            <button class="btn btn--text btn--sm" data-autoproj>${icon('zap')}自动发现项目</button>
            <button class="btn btn--text btn--sm" data-addproj>${icon('folderPlus')}手动添加</button>
            <button class="btn btn--text btn--sm" data-discover>${icon('search')}扫目录</button>
          </div>
        </article>`;
    }).join('')}</div>` : emptyState({
      iconName: 'cpu',
      title: '还没有登记任何产品',
      text: '给出一个智能体产品的启动路径（例如 Antigravity.exe 的完整路径），平台会自动找出它使用的全局 skill 目录。',
      action: `<button class="btn btn--filled" data-add>${icon('plus')}添加第一个产品</button>`
    })}
  `;

  host.querySelector('#addProduct').addEventListener('click', openAddProduct);
  host.querySelector('[data-add]')?.addEventListener('click', openAddProduct);

  host.querySelectorAll('[data-pid]').forEach((cardEl) => {
    const pid = cardEl.dataset.pid;
    const p = products().find((x) => x.id === pid);

    cardEl.querySelector('[data-rescan]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      busyButton(btn, true);
      try {
        const r = await api.rescan(pid);
        await refresh('data');
        toast(`扫描完成：共 ${r.total} 个 skill，新增 ${r.added} 个`, 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        busyButton(btn, false);
      }
    });

    cardEl.querySelector('[data-addproj]').addEventListener('click', async () => {
      const r = await api.pickPath('dir');
      if (!r.path) return;
      try {
        const res = await api.addProject(pid, r.path);
        await refresh('data');
        toast(`已添加项目「${res.project.name}」，收录 ${res.total} 个 skill`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });

    cardEl.querySelector('[data-autoproj]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      busyButton(btn, true);
      try {
        const r = await api.autoProjects(pid);
        await refresh('data');
        toast(
          r.found
            ? `从 ${r.adapters.join(' / ') || '工具数据'} 找到 ${r.found} 个项目，新增 ${r.added} 个`
            : '没有从该工具的数据里找到项目；可以试试「扫目录」手动挑',
          r.found ? 'success' : '',
          { duration: 3600 }
        );
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        busyButton(btn, false);
      }
    });

    cardEl.querySelector('[data-discover]').addEventListener('click', () => openDiscover(pid));

    cardEl.querySelector('[data-more]').addEventListener('click', (e) => {
      menu(e.currentTarget, [
        { label: '在资源管理器中显示', icon: 'external', onClick: () => api.openPath(p.launchPath) },
        {
          label: '显示已隐藏的 skill',
          icon: 'eye',
          onClick: () => {
            state.productId = pid;
            state.showHidden = true;
            window.__goto('skills');
          }
        },
        { sep: true },
        {
          label: '移除产品',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await confirm({
              title: `移除「${p.name}」？`,
              text: '会移除该产品及其项目的索引记录，磁盘上的 skill 文件完全不受影响。',
              confirmText: '移除',
              danger: true
            });
            if (!ok) return;
            await api.removeProduct(pid);
            if (state.productId === pid) state.productId = null;
            await refresh('data');
            toast('已移除', 'success');
          }
        }
      ], { alignRight: true });
    });

    cardEl.querySelectorAll('[data-prid]').forEach((row) => {
      const prid = row.dataset.prid;
      const pr = (p.projects || []).find((x) => x.id === prid);

      row.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-pact]');
        if (!act) {
          state.productId = pid;
          state.scope = 'project';
          state.projectId = prid;
          window.__goto('skills');
          return;
        }
        const a = act.dataset.pact;
        if (a === 'new') return openCreateSkill(pid, pr);
        if (a === 'rescan') {
          try {
            const r = await api.rescanProject(pid, prid);
            await refresh('data');
            toast(`项目重扫完成：${r.total} 个 skill，新增 ${r.added}`, 'success');
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (a === 'more') {
          menu(act, [
            { label: '查看该项目的 skill', icon: 'eye', onClick: () => {
              state.productId = pid; state.scope = 'project'; window.__goto('skills');
            } },
            { label: '新建 skill', icon: 'plus', onClick: () => openCreateSkill(pid, pr) },
            { label: '在资源管理器中显示', icon: 'external', onClick: () => api.openPath(pr.path) },
            { sep: true },
            {
              label: '移除项目',
              icon: 'trash',
              danger: true,
              onClick: async () => {
                const ok = await confirm({
                  title: `移除项目「${pr.name}」？`,
                  text: '只移除索引记录，项目文件夹与其中的 skill 文件不受影响。',
                  confirmText: '移除',
                  danger: true
                });
                if (!ok) return;
                await api.removeProject(pid, prid);
                await refresh('data');
                toast('项目已移除', 'success');
              }
            }
          ], { alignRight: true });
        }
      });
    });
  });
}

/* ---------------------------- 新建 skill ---------------------------- */

export function openCreateSkill(productId, project) {
  const parentDefault = project ? project.path.replace(/[\\/]+$/, '') + '\\skills' : '';
  dialog({
    title: '新建 skill',
    subtitle: project ? `将创建在 ${project.name} / skills 下` : '',
    body: `
      <label class="field">
        <span class="field__label">名称（同时作为目录名）</span>
        <input class="input" id="skName" placeholder="例如：release-checklist" />
      </label>
      <label class="field">
        <span class="field__label">描述</span>
        <textarea class="textarea" id="skDesc" style="min-height:80px"
          placeholder="这个 skill 做什么、什么时候用、边界在哪。"></textarea>
      </label>
      <div class="field">
        <span class="field__label">父目录</span>
        <input class="input input--mono" id="skParent" value="${esc(parentDefault)}" />
        <span class="field__label" style="font-weight:400">留空则创建在项目根目录下。</span>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建',
        kind: 'filled',
        onClick: async (ref) => {
          const name = ref.body.querySelector('#skName').value.trim();
          const desc = ref.body.querySelector('#skDesc').value.trim();
          const parent = ref.body.querySelector('#skParent').value.trim() || (project ? project.path : '');
          if (!name) { toast('请填写名称', 'error'); return; }
          try {
            const r = await api.createSkill({
              parentDir: parent,
              name,
              description: desc,
              productId,
              projectId: project ? project.id : ''
            });
            await refresh('data');
            toast('skill 已创建', 'success', { actionLabel: '打开', onAction: () => api.reveal(r.skill.path) });
          } catch (e) { toast(e.message, 'error'); }
        }
      }
    ],
    onMount(ref) { setTimeout(() => ref.body.querySelector('#skName').focus(), 60); }
  });
}

/* ---------------------------- 发现项目 ---------------------------- */

function openDiscover(productId) {
  const p = products().find((x) => x.id === productId);
  const registered = new Set(((p && p.projects) || []).map((x) => x.path.toLowerCase()));
  const lastRoot = (state.config.ui && state.config.ui.discoverRoot) || '';
  const seed = lastRoot || ((p && p.projects && p.projects[0] && p.projects[0].path.replace(/[\\/][^\\/]+$/, '')) || 'D:\\AI');

  const d = dialog({
    title: '发现项目文件夹',
    subtitle: '选一个父目录，平台会把下面的文件夹连同各自的 skill 数量列出来',
    wide: true,
    body: `
      <label class="field">
        <span class="field__label">父目录</span>
        <div class="row">
          <input class="input input--mono" id="droot" value="${esc(seed)}" placeholder="例如 D:\\AI 或 D:\\Projects" style="flex:1" />
          <button class="btn btn--outlined btn--sm" id="dpick">${icon('folder')}浏览</button>
        </div>
        <span class="field__label" style="font-weight:400">列的是这个目录下的一级文件夹；每个文件夹后面的数字是它里面能扫到的 skill 数。</span>
      </label>
      <div class="row" style="margin:2px 0 8px">
        <label class="row" style="gap:6px;font:var(--type-body-s);color:var(--md-on-surface-variant);cursor:pointer">
          <input type="checkbox" id="dall" style="width:16px;height:16px;accent-color:var(--md-primary)" />
          连没有 skill 的文件夹也列出来
        </label>
        <button class="btn btn--text btn--sm" id="dselall">${icon('check')}全选可登记项</button>
      </div>
      <div id="dlist" style="max-height:320px;overflow:auto">
        <p class="muted" style="font:var(--type-body-s)">点「扫描」开始。</p>
      </div>`,
    actions: [
      { label: '关闭' },
      { label: '扫描', icon: 'search', keepOpen: true, onClick: () => { runScan(); return false; } },
      {
        label: '添加选中',
        kind: 'filled',
        keepOpen: true,
        onClick: async (ref) => {
          const picked = [...ref.body.querySelectorAll('[data-pick]:checked')].map((x) => x.dataset.pick);
          if (!picked.length) { toast('先勾选要添加的项目', 'error'); return false; }
          let added = 0;
          for (const pth of picked) {
            try { await api.addProject(productId, pth); added++; } catch { /* 已存在就跳过 */ }
          }
          ref.close();
          await refresh('data');
          toast(added ? `已添加 ${added} 个项目` : '这些项目都已经登记过了', added ? 'success' : '');
        }
      }
    ]
  });

  const list = d.body.querySelector('#dlist');

  async function runScan() {
    const root = d.body.querySelector('#droot').value.trim();
    if (!root) { toast('先填一个父目录', 'error'); return; }
    const all = d.body.querySelector('#dall').checked;
    list.innerHTML = `<div class="row" style="gap:10px;color:var(--md-on-surface-variant)">
      <span class="spinner"></span><span style="font:var(--type-body-s)">正在扫描…</span></div>`;
    try {
      const r = await api.discoverProjects(root, all);
      await api.patchConfig({ ui: { discoverRoot: root } }).catch(() => {});
      if (!r.list.length) {
        list.innerHTML = `<p class="muted" style="font:var(--type-body-s)">这个目录下没有子文件夹。</p>`;
        return;
      }
      const totalSkills = r.list.reduce((a, x) => a + x.skillCount, 0);
      list.innerHTML = `
        <div class="row" style="margin-bottom:6px">
          <span class="badge badge--primary">${r.list.length} 个文件夹</span>
          <span class="badge">共 ${totalSkills} 个 skill</span>
        </div>
        ${r.list.map((it) => {
          const on = registered.has(it.path.toLowerCase());
          return `
          <label class="list-item" style="cursor:${on ? 'default' : 'pointer'};opacity:${on ? 0.55 : 1}">
            <input type="checkbox" data-pick="${esc(it.path)}" ${on ? 'disabled' : ''}
              style="width:17px;height:17px;accent-color:var(--md-primary)" />
            <div class="list-item__body">
              <div class="list-item__title">${esc(it.name)}</div>
              <div class="list-item__sub mono truncate" title="${esc(it.path)}">${esc(shortPath(it.path, 60))}</div>
            </div>
            <span class="badge ${it.skillCount ? 'badge--project' : ''}">${it.skillCount} 个 skill</span>
            ${on ? '<span class="badge">已登记</span>' : ''}
          </label>`;
        }).join('')}`;
    } catch (e) {
      list.innerHTML = `<p style="color:var(--md-error);font:var(--type-body-s)">${esc(e.message)}</p>`;
    }
  }

  d.body.querySelector('#dpick').addEventListener('click', async () => {
    const r = await api.pickPath('dir');
    if (r.path) { d.body.querySelector('#droot').value = r.path; runScan(); }
  });

  d.body.querySelector('#dall').addEventListener('change', () => runScan());

  d.body.querySelector('#dselall').addEventListener('click', () => {
    const boxes = [...d.body.querySelectorAll('[data-pick]:not([disabled])')];
    const allOn = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allOn; });
  });

  setTimeout(runScan, 120);
}

/* ---------------------------- 添加产品 ---------------------------- */

export function openAddProduct() {
  let probed = null;

  const d = dialog({
    title: '添加智能体产品',
    subtitle: '填入产品启动路径，平台自动探测它使用的 skill 目录。',
    wide: true,
    body: `
      <label class="field">
        <span class="field__label">启动路径</span>
        <div class="row">
          <input class="input input--mono" id="launch" placeholder="C:\\Users\\you\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" style="flex:1" />
          <button class="btn btn--outlined btn--sm" id="browse">${icon('folder')}浏览</button>
        </div>
        <span class="field__label" style="font-weight:400">也接受安装目录、或任意包含 skill 的目录。</span>
      </label>

      <label class="field">
        <span class="field__label">产品名称</span>
        <input class="input" id="pname" placeholder="留空则自动取名" />
      </label>

      <div class="field">
        <span class="field__label">探测结果</span>
        <div id="probeBox" style="border:1px solid var(--md-outline-variant);border-radius:var(--shape-md);padding:12px;min-height:64px">
          <span class="muted" style="font:var(--type-body-s)">填入路径后自动开始探测…</span>
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      { label: '探测', icon: 'search', onClick: () => { runProbe(); return false; }, keepOpen: true },
      {
        label: '添加',
        kind: 'filled',
        keepOpen: true,
        onClick: async (apiRef) => {
          const launchPath = apiRef.body.querySelector('#launch').value.trim();
          if (!launchPath) return toast('请填写启动路径', 'error') && false;
          const name = apiRef.body.querySelector('#pname').value.trim();
          if (!probed) {
            const ok = await runProbe();
            if (!ok) return false;
          }
          const roots = (probed.roots || []).filter((r) => r.count > 0).map((r) => r.root);
          try {
            const res = await api.addProduct({ launchPath, name: name || probed.suggestedName, roots });
            apiRef.close();
            await refresh('data');
            toast(`已添加「${res.product.name}」，收录 ${res.skills.length} 个 skill`, 'success', {
              actionLabel: '查看',
              onAction: () => window.__goto('skills')
            });
          } catch (err) {
            toast(err.message, 'error');
          }
          return false;
        }
      }
    ]
  });

  const box = d.body.querySelector('#probeBox');
  const launch = d.body.querySelector('#launch');
  const pname = d.body.querySelector('#pname');

  async function runProbe() {
    const v = launch.value.trim();
    if (!v) { toast('请先填入启动路径', 'error'); return false; }
    box.innerHTML = `<div class="row" style="gap:10px;color:var(--md-on-surface-variant);font:var(--type-body-s)">
      <span class="spinner"></span>正在搜索目录…</div>`;
    try {
      const r = await api.probe(v);
      probed = r;
      if (!pname.value.trim()) pname.value = r.suggestedName;

      const rows = r.roots.filter((x) => x.count > 0);
      box.innerHTML = `
        <div class="row" style="margin-bottom:8px">
          <span class="badge ${r.valid ? 'badge--success' : 'badge--warn'}">${r.valid ? '路径有效' : '路径不存在'}</span>
          <span class="badge badge--primary">共发现 ${r.totalSkills} 个 skill</span>
          ${r.usedFallback ? '<span class="badge badge--warn">使用了通用位置兜底</span>' : ''}
        </div>
        ${rows.length ? rows.map((x) => `
          <div class="list-item" style="padding:6px 8px">
            <span style="color:var(--md-primary)">${icon('check', 'icon--sm')}</span>
            <div class="list-item__body">
              <div class="list-item__title mono truncate" style="font-size:12px" title="${esc(x.root)}">${esc(shortPath(x.root, 70))}</div>
              <div class="list-item__sub">${esc(x.label)}</div>
            </div>
            <span class="badge">${x.count}</span>
          </div>`).join('')
          : `<p class="muted" style="margin:6px 0;font:var(--type-body-s)">
              没有在预期位置找到 SKILL.md。可以直接把这个产品使用的 skill 目录填进「启动路径」，平台会把它当作根目录扫描。
             </p>`}
      `;
      return r.totalSkills > 0 || r.valid;
    } catch (e) {
      probed = null;
      box.innerHTML = `<span style="color:var(--md-error);font:var(--type-body-s)">${esc(e.message)}</span>`;
      return false;
    }
  }

  d.body.querySelector('#browse').addEventListener('click', async () => {
    const r = await api.pickPath('file');
    if (r.path) { launch.value = r.path; runProbe(); }
  });

  launch.addEventListener('input', debounce(() => { if (launch.value.trim().length > 3) runProbe(); }, 800));
  setTimeout(() => launch.focus(), 80);
}
