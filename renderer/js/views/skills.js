/* views/skills.js — 全部 Skill：卡片墙 + 筛选 + 多选操作 */

import { icon } from '../icons.js';
import {
  state, visibleSkills, groups, groupsOf, productName, products, refresh,
  isFavorite, ratingOf, projectName, hiddenSet, activeProduct, detachedSet, isNestedHidden, uniqueSkills
} from '../state.js';
import { api } from '../api.js';
import { esc, initials, toneOf, toneVar, fmtTime, shortPath } from '../util.js';
import { toast, menu, promptText, emptyState, confirm, dialog } from '../ui.js';
import { openReader } from './reader.js';
import { openGroupEditor, openAssignGroups } from './groups.js';
import { openAiRewrite } from '../ai-dialog.js';
import { copyOrganizePrompt } from '../organize-prompts.js';

const SCOPE_LABEL = { global: '全局', project: '项目' };

function customDescription(id) {
  return String((state.config.customDescriptions || {})[id] || '');
}

function descriptionFace(id, original) {
  const note = customDescription(id);
  return `<div class="description-flip" aria-label="自定义说明：${esc(note)}">
    <p class="card__desc clamp-3 description-flip__front">${esc(original)}</p>
    <div class="card__desc description-flip__back"><span>我的说明</span><button class="description-edit" data-description-edit>${note ? esc(note) : '点击添加说明'}</button></div>
  </div>`;
}

function editDescription(id, name) {
  dialog({
    title: '自定义说明', subtitle: name,
    body: `<label class="field"><span class="field__label">悬停或聚焦时显示</span><textarea class="textarea" id="customDescription" maxlength="1000" style="min-height:120px" placeholder="填写自己的说明；留空可清除">${esc(customDescription(id))}</textarea></label>`,
    actions: [ { label: '取消' }, { label: '保存', kind: 'filled', onClick: async (ref) => {
      const note = ref.body.querySelector('#customDescription').value.trim();
      await api.patchConfig({ customDescriptions: { [id]: note } });
      await refresh('data');
      toast(note ? '说明已保存' : '说明已清除', 'success');
    } } ]
  });
}


function stars(n, size = 13) {
  let out = '';
  for (let i = 1; i <= 5; i++) {
    out += `<span class="star ${i <= n ? 'is-on' : ''}" style="font-size:${size}px">★</span>`;
  }
  return out;
}

function groupChips(skill) {
  const gs = groupsOf(skill.id);
  if (!gs.length) return '';
  return `<div class="chip-row">${gs.map((g) => `
    <span class="badge" style="background:color-mix(in srgb, ${toneVar(g.color)} 16%, transparent);color:${toneVar(g.color)}">
      <span class="chip__dot" style="background:${toneVar(g.color)}"></span>${esc(g.name)}
    </span>`).join('')}</div>`;
}

function card(skill, hideProject = false) {
  const selected = state.selection.has(skill.id);
  const fav = isFavorite(skill.id);
  const rate = ratingOf(skill.id);
  const hidden = hiddenSet().has(skill.id);
  const proj = projectName(skill);
  const kids = childCountOf(skill.id);
  const nested = skill.nested && !detachedSet().has(skill.id);

  return `
  <article class="card card--interactive ${selected ? 'card--selected' : ''} ${hidden ? 'card--muted' : ''}"
    data-id="${skill.id}" tabindex="0">
    <button class="card__check" data-check data-on="${selected ? 1 : 0}" aria-label="选择此 skill">${icon('check')}</button>
    <div class="card__head">
      <div class="card__avatar" style="background:${toneVar(toneOf(skill.name))}">${esc(initials(skill.name))}</div>
      <div style="min-width:0;flex:1">
        <h3 class="card__title" title="${esc(skill.name)}">${esc(skill.name)}</h3>
        <div class="card__meta">
          <span class="truncate" style="max-width:110px">${esc(productName(skill.productId))}</span>
          <span>·</span>
          ${skill.readOnly ? `<span class="badge" title="${esc(skill.sourcePath || '')}">内置 · 只读</span><span>·</span>` : ''}
          ${hideProject && proj ? '' : `<span class="badge ${skill.scope === 'project' ? 'badge--project' : ''}" style="height:18px">
            ${proj ? esc(proj) : (SCOPE_LABEL[skill.scope] || skill.scope)}
          </span>`}
          <span>·</span>
          <span>${fmtTime(skill.mtime)}</span>
          ${nested ? `<span class="badge badge--nested">嵌套${skill.collectionName ? ' · ' + esc(skill.collectionName) : ''}</span>` : ''}
        </div>
      </div>
      <button class="card__fav ${fav ? 'is-on' : ''}" data-fav aria-pressed="${fav}"
        data-tip="${fav ? '取消收藏' : '收藏'}">★</button>
    </div>
    ${descriptionFace(skill.id, skill.description || '（此 skill 没有写描述）')}
    ${groupChips(skill)}
    ${kids ? `<div class="chip-row">
      <button class="chip chip--nest" data-nest="${skill.id}" data-tip="这些 skill 收在它下面">
        ${icon('layers', 'icon--sm')}含 ${kids} 个嵌套
      </button>
    </div>` : ''}
    ${hidden ? '<div class="chip-row"><span class="badge badge--warn">在此产品中已隐藏</span></div>' : ''}
    <div class="card__foot">
      <span class="card__path" title="${esc(skill.dir)}">${esc(shortPath(skill.dir, 42))}</span>
      <button class="iconbtn iconbtn--sm" data-act="copy" data-tip="复制路径">${icon('copy')}</button>
      <button class="iconbtn iconbtn--sm" data-act="read" data-tip="阅读">${icon('book')}</button>
      <button class="iconbtn iconbtn--sm" data-act="scratch" data-tip="加入临时组合">${icon('plus')}</button>
      <button class="iconbtn iconbtn--sm" data-act="more" data-tip="更多">${icon('more')}</button>
    </div>
    <div class="card__rate" data-rate="${skill.id}">
      <span class="card__stars">${stars(rate?.stars || 0)}</span>
      <span class="card__note">${esc(rate?.note || '点星评价')}</span>
    </div>
  </article>`;
}

/** 当前产品范围内的 skill —— 筛选条上的所有计数都以它为准，避免「总数 51 / 卡片 43」这种对不上的情况 */
function scoped() {
  const all = state.config.skills;
  return state.productId ? all.filter((s) => s.productId === state.productId) : all;
}

/** 所有已登记的项目（跨产品），带上所属产品名 */
function allProjects() {
  const out = [];
  for (const p of products()) {
    for (const pr of (p.projects || [])) out.push({ ...pr, productId: p.id, productName: p.name });
  }
  return out;
}

/** 当前生效的附加筛选，渲染成可一键移除的小标签 */
function activeFilters() {
  const out = [];
  const cur = activeProduct();
  if (state.onlyFav) out.push({ key: 'fav', label: '收藏' });
  if (state.productId) out.push({ key: 'product', label: `产品：${cur ? cur.name : '未知'}` });
  if (state.groupId) {
    const g = groups().find((x) => x.id === state.groupId);
    out.push({ key: 'group', label: `分组：${g ? g.name : '未知'}` });
  }
  if (state.scope === 'ungrouped') out.push({ key: 'ungrouped', label: '未分组' });
  if (state.projectId) {
    const pr = allProjects().find((x) => x.id === state.projectId);
    out.push({ key: 'project', label: `项目：${pr ? pr.name : '未知'}` });
  }
  if (state.collectionId) {
    const c = collectionsInScope().find((x) => x.id === state.collectionId);
    out.push({ key: 'collection', label: `技能集：${c ? c.name : '未知'}` });
  }
  if (state.parentId) {
    const p = state.config.skills.find((x) => x.id === state.parentId);
    out.push({ key: 'parent', label: `嵌套于：${p ? p.name : '未知'}` });
  }
  if (state.showNested) out.push({ key: 'nested', label: '含嵌套' });
  return out;
}

function filterBar() {
  const base = scoped();
  // 计数口径：被折叠进技能集/父级的 skill 不计入 —— 否则「全部 226」却只有 6 张卡，看着像丢数据
  const shown = uniqueSkills(base.filter((s) => !isNestedHidden(s)));
  const total = shown.length;
  const gCount = uniqueSkills(base.filter((s) => s.scope === 'global' && !isNestedHidden(s))).length;
  const pCount = uniqueSkills(base.filter((s) => s.scope === 'project' && !isNestedHidden(s))).length;
  const favCount = shown.filter((s) => isFavorite(s.id)).length;
  const groupCount = groups().length;
  const act = activeFilters();

  const seg = (key, label, n) => `
    <button class="segmented__item" data-scope="${key}" aria-pressed="${state.scope === key}">
      ${esc(label)}<span class="seg__n">${n}</span>
    </button>`;

  return `
    <div class="filterbar">
      <div class="segmented segmented--sm" id="scopeBar">
        ${seg('all', '全部', total)}
        ${seg('global', '全局', gCount)}
        ${seg('project', '项目', pCount)}
        ${seg('groups', '分组', groupCount)}
      </div>

      <button class="chip chip--icon" data-favonly aria-pressed="${state.onlyFav}" data-tip="只看收藏">
        <span style="color:${state.onlyFav ? 'inherit' : '#E0A030'}">★</span>
        <span class="muted" style="font-weight:400">${favCount}</span>
      </button>

      <button class="chip" data-filtermenu aria-pressed="${act.length > 0}">
        ${icon('list', 'icon--sm')}筛选${act.length ? `<span class="muted" style="font-weight:400">${act.length}</span>` : ''}
        ${icon('chevronDown', 'icon--sm')}
      </button>

      ${act.map((a) => `
        <button class="chip chip--removable" data-unfilter="${a.key}">
          ${esc(a.label)}${icon('x', 'icon--sm')}
        </button>`).join('')}

      <span class="filterbar__spacer"></span>
      <button class="chip" data-organize-collections>${icon('sparkles')}整理技能集</button>
      <button class="chip" data-newgroup style="border-style:dashed">${icon('plus')}新建分组</button>
    </div>`;
}

/** 筛选菜单：把原先摊在一条长龙里的产品 / 分组 / 未分组都收进来 */
function openFilterMenu(anchor) {
  const items = [
    {
      label: state.scope === 'ungrouped' ? '取消「未分组」' : '只看未分组',
      icon: 'tag',
      onClick: () => {
        state.scope = state.scope === 'ungrouped' ? 'all' : 'ungrouped';
        state.groupId = null;
        state.projectId = null;
        refresh('filter');
      }
    },
    { label: state.onlyFav ? '取消只看收藏' : '只看收藏', icon: 'star', onClick: () => { state.onlyFav = !state.onlyFav; refresh('filter'); } },
    {
      label: state.showNested ? '收起嵌套 skill' : '显示嵌套 skill',
      icon: 'layers',
      onClick: () => { state.showNested = !state.showNested; refresh('filter'); }
    },
    { sep: true },
    { label: '全部产品', icon: 'grid', onClick: () => { state.productId = null; state.projectId = null; refresh('filter'); } }
  ];

  for (const p of products()) {
    items.push({
      label: p.name,
      icon: 'cpu',
      onClick: () => { state.productId = p.id; state.projectId = null; state.showHidden = false; refresh('filter'); }
    });
  }

  const gs = groups();
  if (gs.length) {
    items.push({ sep: true });
    for (const g of gs) {
      items.push({
        label: `分组 · ${g.name}`,
        icon: 'folder',
        onClick: () => { state.groupId = g.id; state.scope = 'all'; state.projectId = null; refresh('filter'); }
      });
    }
  }

  items.push({ sep: true });
  items.push({
    label: '清除全部筛选',
    icon: 'refresh',
    onClick: () => {
      state.scope = 'all';
      state.groupId = null;
      state.productId = null;
      state.projectId = null;
      state.collectionId = null;
      state.parentId = null;
      state.showNested = false;
      state.onlyFav = false;
      state.query = '';
      const si = document.getElementById('searchInput');
      if (si) si.value = '';
      refresh('filter');
    }
  });

  menu(anchor, items);
}

function selectBar() {
  const n = state.selection.size;
  if (!n) return '';
  return `
    <div class="selectbar" id="selectbar">
      <span class="selectbar__count">已选 ${n} 项</span>
      <button class="btn btn--tonal btn--sm" data-sb="scratch">${icon('plus')}加入临时组合</button>
      <button class="btn btn--tonal btn--sm" data-sb="combo">${icon('layers')}存为组合</button>
      <button class="btn btn--tonal btn--sm" data-sb="fav">★收藏</button>
      <button class="btn btn--outlined btn--sm" data-sb="group">${icon('folder')}分组</button>
      <button class="btn btn--text btn--sm" data-sb="copy">${icon('copy')}复制路径</button>
      <button class="iconbtn iconbtn--sm" data-sb="clear" data-tip="取消选择">${icon('x')}</button>
    </div>`;
}

function emptyFor(list) {
  if (state.query) {
    return emptyState({ iconName: 'search', title: '没有匹配的 skill', text: '换个关键词试试，或者清除筛选条件。' });
  }
  if (state.onlyFav) {
    return emptyState({ iconName: 'star', title: '还没有收藏', text: '把常用的 skill 点星收藏，之后在这里就能一眼找到。' });
  }
  if (state.groupId) {
    return emptyState({
      iconName: 'folder',
      title: '这个分组还是空的',
      text: '在「全部 Skill」里多选几个卡片，用底部操作栏把它们加进这个分组。',
      action: `<button class="btn btn--outlined" data-clearfilter>${icon('grid')}看全部 skill</button>`
    });
  }
  if (state.scope === 'project') {
    const hasProjects = products().some((p) => (p.projects || []).length);
    return emptyState({
      iconName: 'folder',
      title: '当前没有可显示的项目 skill',
      text: hasProjects
        ? '项目已经登记，但这个项目文件夹里还没有 SKILL.md。去「产品」页给项目新建一个 skill，或者重新扫描一次。'
        : '项目 skill 是某个项目文件夹里自带的 skill，和全局 skill 分开计数。去「产品」页给产品登记项目目录，平台会把里面的 skill 收进来。',
      action: `<button class="btn btn--filled" data-goto="products">${icon('folderPlus')}去产品页登记项目</button>`
    });
  }
  if (state.productId) {
    const p = activeProduct();
    return emptyState({
      iconName: 'cpu',
      title: `「${p ? p.name : '该产品'}」下没有可显示的 skill`,
      text: '可能都被隐藏了，或者这个产品还没扫描到 skill。',
      action: `<button class="btn btn--filled" data-goto="products">${icon('cpu')}去产品页看看</button>`
    });
  }
  return emptyState({
    iconName: 'grid',
    title: '还没有收录任何 skill',
    text: '给出一个智能体产品的启动路径，平台会自动搜索它下面的全局与项目 skill。',
    action: `<button class="btn btn--filled" data-goto="products">${icon('plus')}添加智能体产品</button>`
  });
}

/** 某个 skill 下面挂了多少个嵌套项 */
function childCountOf(id) {
  return uniqueSkills(scoped().filter((s) => s.parentId === id && !detachedSet().has(s.id))).length;
}

/** 当前范围内出现的技能集（父目录不是 skill，但平铺了一堆 skill） */
function collectionsInScope(base = null) {
  const map = new Map();
  for (const s of (base || scoped())) {
    if (!s.collectionId) continue;
    if (state.productId && s.productId !== state.productId) continue;
    const it = map.get(s.collectionId) || {
      id: s.collectionId,
      name: s.collectionName,
      dir: s.collectionDir,
      count: 0,
      projectId: s.projectId
    };
    it.count++;
    map.set(s.collectionId, it);
  }
  return [...map.values()];
}

/** 技能集卡片：把一堆平铺的 skill 收成一张，点开再展开 */
function collectionCard(col) {
  const active = state.collectionId === col.id;
  return `
  <article class="card card--interactive card--collection ${active ? 'card--selected' : ''}" data-collection="${col.id}">
    <div class="card__head">
      <div class="card__avatar card__avatar--folder">${icon('folder', 'icon--lg')}</div>
      <div style="min-width:0;flex:1">
        <h3 class="card__title">${esc(col.name)}</h3>
        <div class="card__meta">
          <span>技能集</span><span>·</span>
          <span>${col.count} 个 skill</span>
        </div>
      </div>
    </div>
    ${descriptionFace(col.id, `${col.count} 个技能`)}
    <div class="card__foot">
      <span class="card__path mono" title="${esc(col.dir || '')}">${esc(shortPath(col.dir || '', 42))}</span>
      <button class="iconbtn iconbtn--sm" data-act="coldesc" data-tip="自定义说明">${icon('edit')}</button>
      <button class="iconbtn iconbtn--sm" data-act="colcopy" data-tip="复制路径">${icon('copy')}</button>
      <button class="iconbtn iconbtn--sm" data-act="colread" data-tip="展开">${icon('chevronRight')}</button>
    </div>
  </article>`;
}

/**
 * 一个项目 = 一张卡。
 * 默认折叠：卡片上只有名字、计数、路径，不在「项目」总览里铺 skill 列表；
 * 点卡才进入该项目。0 个 skill 的项目同样是一张卡（角上给「新建」）。
 */
function projectCard(pr, items) {
  const n = items.length;
  return `
    <article class="projcard" data-projcard="${esc(pr.id)}" tabindex="0" title="${esc(pr.path)}">
      <div class="projcard__icon">${icon('folder')}</div>
      <div class="projcard__body">
        <h3 class="projcard__name">${esc(pr.name)}</h3>
        <div class="projcard__meta">
          <span class="badge ${n ? 'badge--project' : ''}">${n} 个 skill</span>
          ${pr.auto ? '<span class="badge badge--auto" data-tip="从 agent 工具里自动发现">自动</span>' : ''}
        </div>
        <div class="projcard__path mono">${esc(shortPath(pr.path, 52))}</div>
      </div>
      <div class="projcard__side">
        ${n ? '' : `<button class="iconbtn iconbtn--sm" data-projnew="${esc(pr.id)}" data-tip="在这里新建 skill">${icon('plus')}</button>`}
        ${icon('chevronRight', 'icon--sm')}
      </div>
    </article>`;
}

/** 项目视图：一个项目一张卡，0 个也列 */
function projectGroups(list) {
  const ps = state.productId ? products().filter((p) => p.id === state.productId) : products();
  const cards = [];
  const emptyCards = [];
  for (const p of ps) {
    for (const pr of (p.projects || [])) {
      const items = uniqueSkills(list.filter((s) => s.projectId === pr.id && s.productId === p.id));
      (items.length ? cards : emptyCards).push(projectCard(pr, items));
    }
  }
  // 兜底：项目已不在登记表里，但索引里还有它的 skill
  const known = new Set(allProjects().map((x) => x.id));
  const orphan = list.filter((s) => s.projectId && !known.has(s.projectId));
  if (orphan.length) {
    cards.push(`
      <article class="projcard projcard--orphan">
        <div class="projcard__icon">${icon('folder')}</div>
        <div class="projcard__body">
          <h3 class="projcard__name">未归属项目</h3>
          <div class="projcard__meta"><span class="badge">${orphan.length} 个 skill</span></div>
          <div class="projcard__path mono">项目已从登记表移除，索引里仍有它的 skill</div>
        </div>
      </article>`);
  }
  if (!cards.length && !emptyCards.length) return emptyFor(list);
  return `${cards.length ? `<div class="grid grid--proj">${cards.join('')}</div>` : ''}${emptyCards.length ? `<details class="empty-projects"><summary>无 skill 的项目 · ${emptyCards.length} 个</summary><div class="grid grid--proj">${emptyCards.join('')}</div></details>` : ''}`;
}

/** 分组视图：一个分组一张卡（默认折叠，点开才看组内 skill） */
function groupCards() {
  const base = uniqueSkills(scoped().filter((s) => !isNestedHidden(s)));
  const out = groups().map((g) => {
    const n = base.filter((s) => groupsOf(s.id).some((x) => x.id === g.id)).length;
    return `
      <article class="card card--interactive card--group" data-groupcard="${esc(g.id)}" tabindex="0">
        <div class="card__head">
          <div class="card__avatar" style="background:${toneVar(g.color)}">${icon('folder')}</div>
          <div style="min-width:0;flex:1">
            <h3 class="card__title">${esc(g.name)}</h3>
            <div class="card__meta"><span class="badge badge--project">${n} 个 skill</span></div>
          </div>
          ${icon('chevronRight', 'icon--sm')}
        </div>
        <p class="card__desc">分组只存引用，不移动文件。点开查看组内 skill。</p>
      </article>`;
  });

  const un = base.filter((s) => groupsOf(s.id).length === 0).length;
  if (un) {
    out.push(`
      <article class="card card--interactive card--group" data-groupcard="__none" tabindex="0">
        <div class="card__head">
          <div class="card__avatar" style="background:var(--md-surface-container-highest)">${icon('tag')}</div>
          <div style="min-width:0;flex:1">
            <h3 class="card__title">未分组</h3>
            <div class="card__meta"><span class="badge">${un} 个 skill</span></div>
          </div>
          ${icon('chevronRight', 'icon--sm')}
        </div>
        <p class="card__desc">还没有归入任何分组的 skill。</p>
      </article>`);
  }
  if (!out.length) return emptyFor(base);
  return out.join('');
}

function projectVersionCards(list) {
  if (!state.projectId || state.query || state.agentResultIds) return list.map((s) => card(s));
  const groups = new Map();
  for (const sk of list) {
    const key = String(sk.name || '').trim().toLocaleLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sk);
  }
  return [...groups.values()].map((items) => items.length === 1 ? card(items[0]) :
    `<details class="skill-versions"><summary><strong>${esc(items[0].name)}</strong><span>${items.length} 个同名 skill · 展开查看路径</span></summary><div class="grid">${items.map((s) => card(s)).join('')}</div></details>`);
}

export function renderSkills(host) {
  const list = visibleSkills();
  const hiddenCount = state.productId ? (activeProduct()?.hidden || []).length : 0;
  const nestedCount = state.showNested ? 0 : uniqueSkills(scoped().filter((s) => s.nested && !detachedSet().has(s.id))).length;
  const curProduct = activeProduct();
  // 项目视图：没指定具体项目时按项目分组展示（0 个也列出来）
  const grouped = !state.agentResultIds && state.scope === 'project' && !state.projectId && !state.query;
  // 分组视图：一个分组一张卡（同样默认折叠）
  const groupView = !state.agentResultIds && state.scope === 'groups' && !state.groupId && !state.query;
  // 技能集卡片：没在下钻某个集合、也不在分组总览时，把整片平铺的 skill 收成一张
  // 注意：技能集要跟着当前筛选走 —— 只看某个项目时，不能把别的项目的技能集也画出来
  const colBase = uniqueSkills(scoped().filter((s) => {
    if (!state.showHidden && hiddenSet().has(s.id)) return false;
    if (state.projectId && s.projectId !== state.projectId) return false;
    if (state.groupId && !groupsOf(s.id).some((g) => g.id === state.groupId)) return false;
    if (state.onlyFav && !isFavorite(s.id)) return false;
    if (state.query) {
      const q = state.query.trim().toLowerCase();
      const hit = s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        s.dir.toLowerCase().includes(q) ||
        (s.tags || []).some((t) => String(t).toLowerCase().includes(q));
      if (!hit) return false;
    }
    return true;
  }));
  // 搜索时不再画技能集卡片：用户要的是「那一个子 skill」，不是它的父目录
  const colCards = (state.agentResultIds || state.collectionId || groupView || state.query) ? [] : collectionsInScope(colBase).map(collectionCard);
  const shownTotal = uniqueSkills(scoped().filter((s) => !isNestedHidden(s))).length;
  const projCount = (state.productId ? products().filter((p) => p.id === state.productId) : products())
    .reduce((n, p) => n + (p.projects || []).length, 0);

  host.innerHTML = `
    <div class="page-head">
      <p>${curProduct ? `${esc(curProduct.name)} · ` : ''}${
        state.agentResultIds ? `助手候选 · 当前显示 ${list.length} 个（按推荐顺序）` : grouped
          ? `${projCount} 个项目`
          : groupView
          ? `${groups().length} 个分组`
          : `${list.length} 个技能${nestedCount ? ` · ${nestedCount} 个嵌套` : ''}`
      }
        ${hiddenCount && !state.showHidden ? ` · 已隐藏 ${hiddenCount} 个 <a href="#" data-toggleshow style="cursor:pointer">显示</a>` : ''}
        ${hiddenCount && state.showHidden ? ` · <a href="#" data-toggleshow style="cursor:pointer">收起隐藏项</a>` : ''}
      </p>
      <div class="row">
        <button class="btn btn--text btn--sm" id="sortBtn" ${state.agentResultIds ? 'disabled title="助手候选按推荐顺序展示"' : ''}>${icon('list')}${
          state.sort === 'name' ? '按名称' : state.sort === 'size' ? '按体积' : state.sort === 'rating' ? '按评分' : '按最近'}</button>
        <button class="btn btn--outlined btn--sm" id="selectAll">${icon('check')}全选当前</button>
      </div>
    </div>
    ${state.agentResultIds ? `<div class="agent-results"><strong>助手候选 · ${list.length}</strong><button class="btn btn--tonal btn--sm" id="exitAgentResults">返回全部 Skill</button></div>` : filterBar()}
    ${grouped
      ? `<div id="grid">${projectGroups(visibleSkills({ deduplicate: false }))}</div>`
      : groupView
      ? `<div class="grid" id="grid">${groupCards()}</div>`
      : `<div class="grid" id="grid">${[...colCards, ...projectVersionCards(list)].join('')}</div>${
          (list.length || colCards.length) ? '' : emptyFor(list)}`}
    ${selectBar()}
  `;

  const grid = host.querySelector('#grid');
  host.querySelector('#exitAgentResults')?.addEventListener('click', () => {
    state.agentResultIds = null; state.selection.clear(); renderSkills(host);
  });

  /* ---------------- 卡片交互 ---------------- */
  grid.addEventListener('click', async (e) => {
    /* 分组总览卡：点开 = 下钻该分组 */
    const gEl = e.target.closest('[data-groupcard]');
    if (gEl) {
      e.stopPropagation();
      const k = gEl.dataset.groupcard;
      state.scope = k === '__none' ? 'ungrouped' : 'all';
      state.groupId = k === '__none' ? null : k;
      state.projectId = null;
      state.collectionId = null;
      state.parentId = null;
      return refresh('filter');
    }

    /* 项目卡：点开 = 进入该项目（默认折叠，不在总览里铺 skill） */
    const pNew = e.target.closest('[data-projnew]');
    if (pNew) {
      e.stopPropagation();
      const pr = allProjects().find((x) => x.id === pNew.dataset.projnew);
      if (pr) import('./products.js').then((m) => m.openCreateSkill(pr.productId, pr));
      return;
    }
    const pEl = e.target.closest('[data-projcard]');
    if (pEl) {
      e.stopPropagation();
      state.scope = 'project';
      state.projectId = pEl.dataset.projcard;
      state.groupId = null;
      state.collectionId = null;
      state.parentId = null;
      return refresh('filter');
    }

    /* 技能集卡片：整卡点开 = 下钻；复制按钮只复制路径 */
    const colEl = e.target.closest('[data-collection]');
    if (colEl) {
      e.stopPropagation();
      if (e.target.closest('[data-description-edit]')) {
        const c = collectionsInScope().find(x => x.id === colEl.dataset.collection);
        if (c) editDescription(c.id, c.name);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'coldesc') {
        const c = collectionsInScope().find((x) => x.id === colEl.dataset.collection);
        if (c) editDescription(c.id, c.name);
        return;
      }
      if (act && act.dataset.act === 'colcopy') {
        const c = collectionsInScope().find((x) => x.id === colEl.dataset.collection);
        if (c && c.dir) {
          await window.atelier.call('clipboard:write', { text: c.dir });
          toast('已复制集合路径', 'success');
        }
        return;
      }
      state.collectionId = colEl.dataset.collection;
      state.parentId = null;
      return refresh('filter');
    }

    /* 父卡片上的「含 N 个嵌套」→ 下钻到它的子项 */
    const nestBtn = e.target.closest('[data-nest]');
    if (nestBtn) {
      e.stopPropagation();
      state.parentId = nestBtn.dataset.nest;
      state.collectionId = null;
      return refresh('filter');
    }

    const cardEl = e.target.closest('.card');
    if (!cardEl) return;
    const id = cardEl.dataset.id;
    const skill = list.find((s) => s.id === id);
    if (!skill) return;

    if (e.target.closest('[data-description-edit]')) { e.stopPropagation(); return editDescription(id, skill.name); }

    if (e.target.closest('[data-fav]')) {
      e.stopPropagation();
      await api.toggleFavorite(id);
      return refresh('data');
    }

    if (e.target.closest('.card__rate')) {
      e.stopPropagation();
      return openRating(skill);
    }

    if (e.target.closest('[data-check]') || e.ctrlKey || e.metaKey) {
      toggleSelect(id);
      return;
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      const a = act.dataset.act;
      if (a === 'read') return openReader(id);
      if (a === 'scratch') return addScratch([id]);
      if (a === 'more') return openCardMenu(act, skill);
      if (a === 'copy') {
        await window.atelier.call('clipboard:write', { text: skill.dir });
        return toast('已复制 skill 路径', 'success', { duration: 1600 });
      }
      return;
    }

    // 点卡片本体 = 选中/取消选中；打开阅读只走右下角那个「阅读」按钮
    toggleSelect(id);
  });

  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const g = e.target.closest('[data-groupcard]');
    if (g) { g.click(); return; }
    const p = e.target.closest('[data-projcard]');
    if (p) { p.click(); return; }
    const c = e.target.closest('.card');
    if (c && c.dataset.id) openReader(c.dataset.id);
  });

  /* ---------------- 筛选 ---------------- */
  host.querySelectorAll('[data-scope]').forEach((b) => {
    b.addEventListener('click', () => {
      state.scope = b.dataset.scope;
      state.groupId = null;
      state.projectId = null;
      state.collectionId = null;
      state.parentId = null;
      refresh('filter');
    });
  });

  host.querySelector('[data-favonly]')?.addEventListener('click', () => {
    state.onlyFav = !state.onlyFav;
    refresh('filter');
  });

  host.querySelector('[data-filtermenu]')?.addEventListener('click', (e) => openFilterMenu(e.currentTarget));

  host.querySelectorAll('[data-unfilter]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.unfilter;
      if (k === 'fav') state.onlyFav = false;
      if (k === 'product') { state.productId = null; state.projectId = null; }
      if (k === 'group') state.groupId = null;
      if (k === 'ungrouped' && state.scope === 'ungrouped') state.scope = 'all';
      if (k === 'project') state.projectId = null;
      if (k === 'collection') state.collectionId = null;
      if (k === 'parent') state.parentId = null;
      if (k === 'nested') state.showNested = false;
      refresh('filter');
    });
  });

  host.querySelector('[data-toggleshow]')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.showHidden = !state.showHidden;
    refresh('filter');
  });

  host.querySelector('[data-newgroup]')?.addEventListener('click', () => openGroupEditor());
  host.querySelector('[data-organize-collections]')?.addEventListener('click', () => copyOrganizePrompt('collections'));

  /* ---------------- 排序 / 全选 ---------------- */
  host.querySelector('#sortBtn').addEventListener('click', (e) => {
    menu(e.currentTarget, [
      { label: '按最近修改', icon: 'clock', onClick: () => { state.sort = 'recent'; refresh('filter'); } },
      { label: '按名称', icon: 'text', onClick: () => { state.sort = 'name'; refresh('filter'); } },
      { label: '按体积', icon: 'database', onClick: () => { state.sort = 'size'; refresh('filter'); } },
      { label: '按我的评分', icon: 'star', onClick: () => { state.sort = 'rating'; refresh('filter'); } }
    ]);
  });

  host.querySelector('#selectAll').addEventListener('click', () => {
    const allSelected = list.every((s) => state.selection.has(s.id));
    if (allSelected) list.forEach((s) => state.selection.delete(s.id));
    else list.forEach((s) => state.selection.add(s.id));
    refresh('selection');
  });

  /* ---------------- 选择操作栏 ---------------- */
  const sb = host.querySelector('#selectbar');
  if (sb) {
    sb.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sb]');
      if (!b) return;
      const ids = [...state.selection];
      const act = b.dataset.sb;
      if (act === 'clear') { state.selection.clear(); return refresh('selection'); }
      if (act === 'copy') {
        await api.copyCombo(ids);
        toast(`已复制 ${ids.length} 条路径到剪贴板`, 'success');
        return;
      }
      if (act === 'fav') {
        const missing = ids.filter((id) => !isFavorite(id));
        for (const id of missing) await api.toggleFavorite(id);
        state.selection.clear();
        await refresh('data');
        toast(missing.length ? `已收藏 ${missing.length} 个` : '选中的都已收藏', 'success');
        return;
      }
      if (act === 'scratch') return addScratch(ids);
      if (act === 'combo') {
        const name = await promptText({
          title: '存为组合',
          subtitle: `把当前选中的 ${ids.length} 个 skill 保存成一个可复用的组合。`,
          label: '组合名称',
          placeholder: '例如：前端重构工具箱',
          confirmText: '保存'
        });
        if (!name) return;
        await api.createCombo(name, ids);
        state.selection.clear();
        await refresh('data');
        toast('组合已保存', 'success', { actionLabel: '查看', onAction: () => window.__goto('combos') });
        return;
      }
      if (act === 'group') {
        const g = await openAssignGroups(ids);
        if (g) { state.selection.clear(); refresh('data'); }
      }
    });
  }

  host.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => window.__goto(b.dataset.goto));
  });

  host.querySelector('[data-clearfilter]')?.addEventListener('click', () => {
    state.scope = 'all';
    state.groupId = null;
    state.onlyFav = false;
    state.query = '';
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    refresh('filter');
  });
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  refresh('selection');
}

async function addScratch(ids) {
  await api.addScratch(ids);
  await refresh('data');
  toast(`已加入临时组合（${ids.length} 个）`, 'success', {
    actionLabel: '去查看',
    onAction: () => window.__goto('combos')
  });
}

/* ---------------------------- 评价 ---------------------------- */

export function openRating(skill) {
  const cur = ratingOf(skill.id) || { stars: 0, note: '' };
  let starsVal = cur.stars;

  const d = dialog({
    title: '我的评价',
    subtitle: skill.name,
    body: `
      <div class="field">
        <span class="field__label">评分</span>
        <div class="rating-input" id="rateInput">
          ${[1, 2, 3, 4, 5].map((i) => `<button class="star-btn" data-star="${i}">★</button>`).join('')}
        </div>
      </div>
      <label class="field">
        <span class="field__label">备注</span>
        <textarea class="textarea" id="rateNote" style="min-height:72px"
          placeholder="比如：改过两次、慎用、适合做收尾…">${esc(cur.note || '')}</textarea>
      </label>`,
    actions: [
      { label: '清除评价', onClick: async () => { await api.setRating(skill.id, 0, ''); await refresh('data'); toast('已清除评价'); } },
      { label: '取消' },
      {
        label: '保存',
        kind: 'filled',
        onClick: async (ref) => {
          const note = ref.body.querySelector('#rateNote').value.trim();
          await api.setRating(skill.id, starsVal, note);
          await refresh('data');
          toast('评价已保存', 'success');
        }
      }
    ],
    onMount(ref) {
      const paint = () => {
        ref.body.querySelectorAll('[data-star]').forEach((b) => {
          b.classList.toggle('is-on', Number(b.dataset.star) <= starsVal);
        });
      };
      ref.body.querySelectorAll('[data-star]').forEach((b) => {
        b.addEventListener('click', () => { starsVal = Number(b.dataset.star); paint(); });
        b.addEventListener('mouseenter', () => {
          const v = Number(b.dataset.star);
          ref.body.querySelectorAll('[data-star]').forEach((x) => {
            x.classList.toggle('is-on', Number(x.dataset.star) <= v);
          });
        });
      });
      ref.body.querySelector('#rateInput').addEventListener('mouseleave', paint);
      paint();
    }
  });
  return d;
}

/* ---------------------------- 卡片菜单 ---------------------------- */

function openCardMenu(anchor, skill) {
  const items = [
    { label: '阅读', icon: 'book', onClick: () => openReader(skill.id) },
    { label: isFavorite(skill.id) ? '取消收藏' : '收藏', icon: 'star', onClick: async () => { await api.toggleFavorite(skill.id); refresh('data'); } },
    { label: '评价…', icon: 'edit', onClick: () => openRating(skill) },
    { label: '自定义说明…', icon: 'edit', onClick: () => editDescription(skill.id, skill.name) },
    { label: '加入临时组合', icon: 'plus', onClick: () => addScratch([skill.id]) },
    { label: '复制路径', icon: 'copy', onClick: async () => { await api.copyCombo([skill.id]); toast('路径已复制', 'success'); } },
    { label: '分组…', icon: 'folder', onClick: () => openAssignGroups([skill.id]).then(() => refresh('data')) },
    { sep: true },
    { label: 'AI 改写…', icon: 'sparkles', onClick: () => openAiRewrite(skill.id) },
    { label: '在资源管理器中显示', icon: 'external', onClick: () => api.reveal(skill.path) }
  ];

  if (state.productId) {
    const isHidden = hiddenSet().has(skill.id);
    items.splice(6, 0, {
      label: isHidden ? '在此产品中取消隐藏' : '在此产品中隐藏',
      icon: 'eye',
      onClick: async () => {
        await api.hideSkill(state.productId, skill.id, !isHidden);
        await refresh('data');
        toast(isHidden ? '已取消隐藏' : '已在当前产品中隐藏', 'success');
      }
    });
  }

  if (skill.nested) {
    const isOut = detachedSet().has(skill.id);
    items.push({ sep: true });
    items.push({
      label: isOut ? '收回父级' : '移出嵌套',
      icon: isOut ? 'layers' : 'arrowRight',
      onClick: async () => {
        await api.detachSkill(skill.id, !isOut);
        await refresh('data');
        toast(isOut ? '已收回父级' : '已移出嵌套，之后会单独显示', 'success');
      }
    });
  }

  if (skill.scope === 'project') {
    items.push({ sep: true });
    items.push({
      label: '删除这个项目 skill',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirm({
          title: `删除「${skill.name}」？`,
          text: `整个目录会被移入系统回收站（不是永久删除），可以从回收站还原。\n\n${skill.dir}`,
          confirmText: '移入回收站',
          danger: true
        });
        if (!ok) return;
        try {
          await api.deleteSkill(skill.id);
          await refresh('data');
          toast('已移入回收站', 'success');
        } catch (e) { toast(e.message, 'error'); }
      }
    });
  }

  menu(anchor, items, { alignRight: true });
}
