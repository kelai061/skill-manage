import { api } from './api.js';
import { refresh, state } from './state.js';
import { openReader } from './views/reader.js';
import { toast } from './ui.js';
import { enterMotion } from './appearance.js';

const labels = { present_skills: '展示推荐 Skill', library_overview: '查看技能库概况', search_skills: '检索 Skill 摘要', skill_summaries: '读取候选简介',
  download_skills: '下载到暂存区', group_skills: '批量更新分组', categorize_skills: '归档暂存 Skill' };

export function initSkillAgent() {
  const panel = document.getElementById('skillAgent');
  const toggle = document.getElementById('agentToggle');
  const log = panel.querySelector('#agentMessages');
  const form = panel.querySelector('form');
  const input = panel.querySelector('textarea');
  const send = panel.querySelector('#agentSend');
  const stop = panel.querySelector('#agentStop');
  const clear = panel.querySelector('#agentClear');
  const progress = panel.querySelector('#agentProgress');
  const results = panel.querySelector('#agentResults');
  let resultMessage = null;
  let resultPage = 0;
  let resultQuery = '';
  const dismissed = new WeakSet();
  const pageSize = 3;
  let busy = false;
  let messages = [];
  let opened = false;
  async function locate(refs, focusId) {
    const result = await api.agentLocate(refs.map(r => r.id));
    await refresh();
    Object.assign(state, { agentResultIds: result.items.map(r => r.id), query: '', scope: 'all',
      productId: null, projectId: null, groupId: null, collectionId: null, parentId: null, onlyFav: false });
    document.getElementById('searchInput').value = '';
    window.__goto('skills', { keepAgentResults: true });
    const card = [...document.querySelectorAll('#grid [data-id]')].find(el => el.dataset.id === (focusId || result.items[0]?.id));
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card?.classList.add('agent-located');
    card?.focus({ preventScroll: true });
    if (window.innerWidth <= 1180) open(false);
  }

  function setBusy(value) {
    busy = value;
    send.disabled = value;
    clear.disabled = value;
    stop.hidden = !value;
    input.disabled = value;
    log.setAttribute('aria-busy', String(value));
    if (!value) progress.textContent = '';
  }
  function button(text, action, className = 'btn btn--tonal btn--sm') {
    const b = document.createElement('button'); b.type = 'button'; b.className = className;
    b.textContent = text;
    b.addEventListener('click', () => Promise.resolve().then(action).catch(e => toast(e.message, 'error')));
    return b;
  }
  function showResults(message) {
    if (resultMessage !== message) { resultMessage = message; resultPage = 0; resultQuery = ''; }
    renderResults();
  }
  function renderResults() {
    results.replaceChildren();
    const refs = resultMessage?.refs || [];
    results.hidden = !refs.length;
    if (!refs.length) return;
    const filtered = refs.filter(r => [r.name, r.description, r.reason].some(v => String(v || '').toLowerCase().includes(resultQuery.toLowerCase())));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    resultPage = Math.min(resultPage, pages - 1);
    const header = document.createElement('div'); header.className = 'agent__results-head';
    const title = document.createElement('strong'); title.textContent = `候选 Skill · ${refs.length}`;
    const dismiss = button('×', () => { dismissed.add(resultMessage); render(); }, 'agent__dismiss-results');
    dismiss.setAttribute('aria-label', '收起候选 Skill');
    const nav = document.createElement('div'); nav.className = 'agent__pagination';
    const prev = button('‹', () => {
      resultPage--; renderResults();
      results.querySelector(resultPage ? '[aria-label="上一页候选"]' : '[aria-label="下一页候选"]')?.focus();
    }, 'agent__page');
    prev.disabled = resultPage === 0; prev.setAttribute('aria-label', '上一页候选');
    const count = document.createElement('span'); count.textContent = `${resultPage + 1} / ${pages}`; count.setAttribute('aria-live', 'polite');
    const next = button('›', () => {
      resultPage++; renderResults();
      results.querySelector(resultPage < pages - 1 ? '[aria-label="下一页候选"]' : '[aria-label="上一页候选"]')?.focus();
    }, 'agent__page');
    next.disabled = resultPage === pages - 1; next.setAttribute('aria-label', '下一页候选');
    nav.append(prev, count, next, dismiss); header.append(title, nav); results.append(header);
    if (refs.length > pageSize) {
      const filter = document.createElement('input'); filter.type = 'search'; filter.className = 'agent__filter';
      filter.placeholder = '筛选这些候选…'; filter.setAttribute('aria-label', '筛选候选 Skill'); filter.value = resultQuery;
      filter.addEventListener('input', () => {
        const start = filter.selectionStart; resultQuery = filter.value; resultPage = 0; renderResults();
        const current = results.querySelector('input'); current.focus();
        if (Number.isInteger(start)) current.setSelectionRange(start, start);
      });
      results.append(filter);
    }
    const list = document.createElement('div'); list.className = 'agent__result-list';
    if (!filtered.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配候选，试试其他词。'; list.append(empty); }
    for (const [index, ref] of filtered.slice(resultPage * pageSize, (resultPage + 1) * pageSize).entries()) {
      const card = document.createElement('div'); card.className = 'agent__ref'; card.dataset.id = ref.id;
      const rank = document.createElement('span'); rank.className = 'agent__rank'; rank.textContent = resultPage * pageSize + index + 1;
      const info = document.createElement('div'); info.className = 'agent__ref-info';
      const name = document.createElement('strong'); name.textContent = ref.name; name.title = `${ref.name}\n${ref.dir}`;
      const desc = document.createElement('p'); desc.textContent = ref.reason || ref.description || '简介不足，建议阅读确认'; desc.title = [ref.reason, ref.description, ref.dir].filter(Boolean).join('\n');
      info.append(name, desc);
      const actions = document.createElement('div'); actions.className = 'agent__ref-actions';
      const locateButton = button('定位', () => locate([ref], ref.id), 'agent__locate'); locateButton.setAttribute('aria-label', `定位 ${ref.name}`);
      const readButton = button('阅读', async () => { await api.agentLocate([ref.id]); await refresh(); await openReader(ref.id); }, 'agent__read');
      readButton.setAttribute('aria-label', `阅读 ${ref.name}`);
      actions.append(locateButton, readButton); card.append(rank, info, actions); list.append(card);
    }
    results.append(list, button('在左侧查看全部候选 ↗', () => locate(refs), 'agent__show-results'));
  }
  function render() {
    log.replaceChildren();
    if (!messages.length) {
      const intro = document.createElement('div'); intro.className = 'agent__intro';
      const mark = document.createElement('div'); mark.className = 'agent__hero-mark'; mark.textContent = '✦';
      const eyebrow = document.createElement('small'); eyebrow.textContent = '从任务出发，找到合适的 Skill';
      const title = document.createElement('h3'); title.textContent = '这次，想做点什么？';
      const text = document.createElement('p'); text.textContent = '查找 · 下载 · 分组';
      intro.append(mark, eyebrow, title, text);
      for (const prompt of ['找适合设计智能体的 skill', '给暂存区的 skill 提出分类建议', '看看我已有的分组']) {
        intro.append(button(prompt, () => { input.value = prompt; input.focus(); }, 'agent__suggestion'));
      }
      log.append(intro);
    }
    for (const message of messages) {
      const item = document.createElement('article'); item.className = 'agent__message agent__message--' + message.role;
      const who = document.createElement('div'); who.className = 'agent__who'; who.textContent = message.role === 'user' ? '你' : 'Skill 助手';
      const body = document.createElement('div'); body.className = 'agent__text';
      if (message.role !== 'user' && message.text.length > 240) {
        const more = document.createElement('details'); more.className = 'agent__long-reply';
        const preview = document.createElement('summary'); preview.textContent = message.text.slice(0, 120) + '… 展开全文';
        const full = document.createElement('div'); full.textContent = message.text; more.append(preview, full); body.append(more);
      } else body.textContent = message.text;
      item.append(who, body);
      if (message.trace?.length) {
        const details = document.createElement('details'); details.className = 'agent__trace';
        const summary = document.createElement('summary'); summary.textContent = `${message.trace.length} 次工具调用 · 查看执行记录`;
        details.append(summary);
        for (const step of message.trace) {
          const line = document.createElement('div'); line.textContent = `${step.state === 'error' ? '失败' : '完成'} · ${labels[step.tool] || step.tool} · ${step.summary || ''}`;
          details.append(line);
        }
        item.append(details);
      }
      if (message.refs?.length && (message !== messages.at(-1) || dismissed.has(message))) {
        item.append(button(`查看本轮 ${message.refs.length} 个候选 ↓`, () => { dismissed.delete(message); showResults(message); }, 'agent__history-results'));
      }
      log.append(item);
    }
    const latest = messages.at(-1);
    showResults(latest?.role === 'assistant' && latest.refs?.length && !dismissed.has(latest) ? latest : null);
    log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
  }
  // Keep the latest answer visible when the dock or window changes height.
  new ResizeObserver(() => {
    if (opened && resultMessage === messages.at(-1)) log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
  }).observe(log);
  function open(value) {
    opened = value;
    panel.hidden = !value;
    document.querySelector('.app').classList.toggle('agent-open', value);
    toggle.setAttribute('aria-expanded', String(value));
    if (value) { enterMotion(panel, 'x'); input.focus(); }
  }
  toggle.addEventListener('click', () => open(!opened));
  panel.querySelector('#agentClose').addEventListener('click', () => { open(false); toggle.focus(); });
  panel.querySelector('#agentSettings').addEventListener('click', () => window.__goto('settings'));
  panel.querySelector('#agentStaging').addEventListener('click', () => window.__goto('staging'));
  clear.addEventListener('click', async () => {
    try { await api.agentClear(); messages = []; render(); input.focus(); }
    catch (e) { toast(e.message, 'error'); }
  });
  stop.addEventListener('click', async () => {
    try { await api.agentCancel(); progress.textContent = '正在停止；已完成的操作会保留…'; }
    catch (e) { toast(e.message, 'error'); }
  });
  window.atelier.onAgentProgress?.(step => {
    progress.textContent = `${labels[step.tool] || step.tool} · ${step.state === 'running' ? '处理中…' : step.summary || '完成'}`;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (busy || !text) return;
    messages.push({ role: 'user', text });
    input.value = ''; setBusy(true); render(); progress.textContent = '正在理解需求…';
    try { messages.push(await api.agentSend(text, {
      view: state.view, productId: state.productId, projectId: state.projectId, groupId: state.groupId,
      selectedSkillIds: [...state.selection].slice(0, 100)
    })); }
    catch (e) {
      // A preflight failure is not committed to backend history; keep the input retryable.
      messages.pop(); input.value = text;
      toast(e.message, 'error');
    } finally {
      setBusy(false); render();
      try { await refresh(); } catch (e) { toast(e.message, 'error'); }
      if (opened) input.focus();
    }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); form.requestSubmit();
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'j') { e.preventDefault(); open(!opened); }
    if (e.key === 'Escape' && opened && !document.querySelector('#readerRoot, .scrim, .menu')) { open(false); toggle.focus(); e.preventDefault(); }
  });
  // Recover messages and an in-flight task after a renderer reload.
  async function recover() {
    try {
      const status = await api.agentStatus(); messages = status.messages; setBusy(status.busy); render();
      if (status.busy) { progress.textContent = '助手正在继续上一项任务…'; setTimeout(recover, 1500); }
    } catch (e) { toast(e.message, 'error'); }
  }
  recover();
}
