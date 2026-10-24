/* views/settings.js — 设置：接口 / 阅读 / 语音 / 数据与授权 */

import { icon } from '../icons.js';
import { state, refresh } from '../state.js';
import { api } from '../api.js';
import { esc, fmtBytes, fmtDate, shortPath } from '../util.js';
import { toast, confirm, busyButton, dialog } from '../ui.js';
import { openHelp, openDetect } from '../onboarding.js';
import { openUpdateDialog } from '../update.js';
import { appearanceOptions, themeOptions, bindAppearance } from '../appearance.js';

const S = () => state.config.settings;

function card(title, desc, body, iconName) {
  return `
    <section class="card" style="margin-bottom:16px">
      <div class="card__head">
        <div class="card__avatar" style="background:var(--md-surface-container-highest);color:var(--md-on-surface-variant)">
          ${icon(iconName, 'icon--sm')}
        </div>
        <div style="min-width:0;flex:1">
          <h3 class="card__title" title="${esc(desc)}">${esc(title)}</h3>
        </div>
      </div>
      ${body}
    </section>`;
}

function rowField(label, control, hint) {
  return `
    <div class="field" style="margin-bottom:12px">
      <span class="field__label">${esc(label)}</span>
      ${control}
      ${hint ? `<span class="field__label" style="font-weight:400">${esc(hint)}</span>` : ''}
    </div>`;
}

export function renderSettings(host) {
  const s = S();
  const meta = state.config.meta;
  const audit = state.config.audit || [];

  host.innerHTML = `
    <div class="page-head">
      <p>偏好设置</p>
    </div>
    <div style="max-width:860px">

      ${card('外观', '', appearanceOptions(s.appearance) + themeOptions(s.theme), 'sun')}

      ${card('AI 接口', '兼容 OpenAI 协议的任意服务（DeepSeek / Moonshot / 本地 Ollama）', `
        ${rowField('Base URL', `<input class="input input--mono" id="apiBase" value="${esc(s.api.baseUrl)}" placeholder="https://api.deepseek.com" />`)}
        ${rowField('API Key', `<input class="input input--mono" id="apiKey" type="password" value="${esc(s.api.key)}" placeholder="sk-…" />`,
          'Key 以明文保存在本机 config.json 中，仅用于直连你填写的接口。')}
        ${rowField('模型', `<input class="input input--mono" id="apiModel" value="${esc(s.api.model)}" placeholder="deepseek-chat" />`)}
        <div class="row">
          <button class="btn btn--tonal btn--sm" id="testAI">${icon('zap')}测试连接</button>
          <span class="muted" style="font:var(--type-body-s)" id="testResult"></span>
        </div>`, 'key')}

      ${card('翻译', '双语对照的默认行为', `
        <div class="row row--wrap" style="gap:20px">
          <label class="field" style="flex:1;min-width:200px">
            <span class="field__label">目标语言</span>
            <select class="input" id="trTarget">
              <option value="zh-CN" ${s.translate.target === 'zh-CN' ? 'selected' : ''}>简体中文</option>
              <option value="zh-TW" ${s.translate.target === 'zh-TW' ? 'selected' : ''}>繁體中文</option>
              <option value="ja" ${s.translate.target === 'ja' ? 'selected' : ''}>日本語</option>
              <option value="en" ${s.translate.target === 'en' ? 'selected' : ''}>English</option>
            </select>
          </label>
          <label class="field" style="flex:1;min-width:200px">
            <span class="field__label">打开阅读器时的默认模式</span>
            <select class="input" id="trMode">
              <option value="off" ${s.reader.mode === 'off' ? 'selected' : ''}>仅原文</option>
              <option value="interlinear" ${s.reader.mode === 'interlinear' ? 'selected' : ''}>行间对照</option>
              <option value="side" ${s.reader.mode === 'side' ? 'selected' : ''}>并排对照</option>
            </select>
          </label>
        </div>
        <label class="row" style="margin-top:12px"><input type="checkbox" id="selectionLive" ${s.translate.selectionLive ? 'checked' : ''}>选词实时翻译（实验）</label>
        <p class="muted" style="font:var(--type-body-s)">开启后，选中原文短语会调用已配置的 API。</p>`, 'translate')}

      ${card('阅读器', '排版密度', `
        <div class="field" style="margin-bottom:14px">
          <span class="field__label">正文字号 · <b id="fsVal">${s.reader.fontSize}</b> px</span>
          <input type="range" min="13" max="22" step="1" value="${s.reader.fontSize}" id="fsRange"
            style="width:100%;accent-color:var(--md-primary)" />
        </div>
        <div class="field">
          <span class="field__label">正文行宽 · <b id="mwVal">${s.reader.measure}</b> px</span>
          <input type="range" min="560" max="980" step="20" value="${s.reader.measure}" id="mwRange"
            style="width:100%;accent-color:var(--md-primary)" />
        </div>`, 'text')}

      ${card('语音朗读', '使用系统语音合成，不联网', `
        ${rowField('语速 · <b id="rateVal">' + s.tts.rate.toFixed(2) + '</b>', `
          <input type="range" min="0.5" max="1.6" step="0.05" value="${s.tts.rate}" id="rateRange"
            style="width:100%;accent-color:var(--md-primary)" />`)}
        ${rowField('语音', `<select class="input" id="voiceSel"><option value="">系统默认</option></select>`,
          '朗读时会按文本语言自动切换中英文语音。')}`, 'volume')}

      ${card('暂存与归位', '导入的 skill 先落这里，攒够数量再归位到分类目录', `
        <div class="list-item" style="padding-left:0">
          <span class="muted">${icon('zap', 'icon--sm')}</span>
          <div class="list-item__body">
            <div class="list-item__title mono truncate" id="stagingPath" title="">未设置</div>
            <div class="list-item__sub">暂存目录（建议 AAA-new）</div>
          </div>
          <button class="btn btn--text btn--sm" id="pickStaging">选择</button>
        </div>
        ${rowField('归位阈值', `<input class="input" id="stgThreshold" type="number" min="1" max="30" value="6" />`,
          '暂存区达到这个数量时，界面会提示可以整理归位。')}`, 'zap')}

      ${card('数据与隔离', '配置与持久译文分开保存，源 skill 目录只读', `
        <div class="list-item" style="padding-left:0">
          <span class="muted">${icon('drive', 'icon--sm')}</span>
          <div class="list-item__body">
            <div class="list-item__title mono truncate" title="${esc(meta.dataDir)}">${esc(shortPath(meta.dataDir, 70))}</div>
            <div class="list-item__sub">配置 · 标记 · 备份 · 审计</div>
          </div>
          <button class="btn btn--text btn--sm" id="openData">打开</button>
        </div>
        <div class="list-item" style="padding-left:0">
          <span class="muted">${icon('translate', 'icon--sm')}</span>
          <div class="list-item__body">
            <div class="list-item__title mono truncate" title="${esc(meta.translationsDir || '')}">${esc(shortPath(meta.translationsDir || '', 70))}</div>
            <div class="list-item__sub">根目录持久译文 · 清理临时缓存时保留智能体译文</div>
          </div>
          <button class="btn btn--text btn--sm" id="openTranslations">打开</button>
        </div>
        <div class="row row--wrap" style="margin-top:8px">
          <button class="btn btn--outlined btn--sm" id="viewBackups">${icon('clock')}查看备份</button>
          <button class="btn btn--outlined btn--sm" id="clearCache">${icon('trash')}清空译文缓存</button>
        </div>`, 'shield')}

      ${card('分享与迁移', '把整理成果带走：产品 / 项目 / 分组 / 组合 / 收藏', `
        <p class="muted" style="margin:0 0 10px;font:var(--type-body-s);line-height:1.7">
          导出一份 JSON 分享包，换台电脑导入即可复用你的分类与组合；导入只合并、不删除本地已有内容。
        </p>
        <div class="row row--wrap">
          <button class="btn btn--outlined btn--sm" id="exportShare">${icon('drive')}导出分享包</button>
          <button class="btn btn--outlined btn--sm" id="importShare">${icon('folder')}导入分享包</button>
        </div>`, 'drive')}

      ${card('关于与更新', '版本、项目地址、更新检查', `
        <div class="list-item" style="padding-left:0">
          <span class="muted">${icon('info', 'icon--sm')}</span>
          <div class="list-item__body">
            <div class="list-item__title">Skill Atelier v${esc(meta.version)}</div>
            <div class="list-item__sub">绿色版 · 本地运行 · 数据不上传</div>
          </div>
          <button class="btn btn--text btn--sm" id="checkUpdate">检查更新</button>
        </div>
        <div class="list-item" style="padding-left:0">
          <span class="muted">${icon('external', 'icon--sm')}</span>
          <div class="list-item__body">
            <div class="list-item__title">项目地址</div>
            <div class="list-item__sub mono truncate" title="https://github.com/${esc(meta.repo || '')}">github.com/${esc(meta.repo || '')}</div>
          </div>
          <button class="btn btn--text btn--sm" id="openRepo">打开</button>
        </div>
        <div class="row row--wrap" style="margin-top:8px">
          <button class="btn btn--outlined btn--sm" id="replayTour">${icon('book')}使用说明</button>
          <button class="btn btn--outlined btn--sm" id="redetect">${icon('search')}重新检测本机工具</button>
        </div>`, 'info')}

      ${card('授权与审计', 'AI 改写必须逐次批准，每次写入都先备份', `
        <p class="muted" style="margin:0 0 10px;font:var(--type-body-s);line-height:1.7">
          原始 skill 永远不会被静默修改：AI 只能生成提案，平台把改动算成逐行差异交给你审阅，
          点「批准」之后才会备份并写入。写入前的原文会保留在备份目录里。
        </p>
        <div style="max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:1px">
          ${audit.length ? audit.slice(0, 30).map((a) => `
            <div class="list-item" style="padding:8px 10px">
              <span style="color:var(--md-primary)">${icon('edit', 'icon--sm')}</span>
              <div class="list-item__body">
                <div class="list-item__title mono truncate" style="font-size:12px" title="${esc(a.file)}">${esc(shortPath(a.file, 64))}</div>
                <div class="list-item__sub">${fmtDate(a.at)} · ${esc(a.model || '未知模型')}${a.note ? ' · ' + esc(a.note) : ''}</div>
              </div>
            </div>`).join('')
            : '<p class="muted" style="margin:6px 0;font:var(--type-body-s)">还没有任何写入记录。</p>'}
        </div>`, 'lock')}
    </div>
  `;

  /* ---------------- 外观 ---------------- */
  bindAppearance(host);

  /* ---------------- API ---------------- */
  const timers = new Map();
  const bind = (id, path, transform = (v) => v) => {
    const el = host.querySelector(id);
    if (!el) return;
    el.addEventListener('input', () => {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(async () => {
        timers.delete(id);
        await api.patchConfig({ settings: path(transform(el.value)) });
        state.config = await api.getConfig();
      }, 400));
    });
  };
  bind('#apiBase', (v) => ({ api: { baseUrl: v.trim() } }));
  bind('#apiKey', (v) => ({ api: { key: v.trim() } }));
  bind('#apiModel', (v) => ({ api: { model: v.trim() } }));

  /** 点击那一刻的表单快照 —— 测试必须用当前输入框的值，不是 400ms 前的旧值 */
  const apiSnapshot = () => ({
    baseUrl: host.querySelector('#apiBase').value.trim(),
    key: host.querySelector('#apiKey').value.trim(),
    model: host.querySelector('#apiModel').value.trim()
  });

  /** 把还在防抖里的输入立刻落盘，消除「测试用新值、保存用旧值」的时序窗口 */
  const flushApi = async () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    await api.patchConfig({ settings: { api: apiSnapshot() } });
    state.config = await api.getConfig();
  };

  let testSeq = 0;
  host.querySelector('#testAI').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = host.querySelector('#testResult');
    const mine = ++testSeq;
    const snapshot = apiSnapshot();
    busyButton(btn, true);
    out.textContent = '正在连接…';
    try {
      await flushApi();
      const r = await api.testAI(snapshot);
      // 只有最后一次点击的结果能落到界面上，慢回的旧请求直接丢弃
      if (mine !== testSeq) return;
      out.innerHTML = `<span style="color:var(--md-success)">连接成功 · ${esc(r.model)} · ${r.ms}ms</span>`;
    } catch (err) {
      if (mine !== testSeq) return;
      out.innerHTML = `<span style="color:var(--md-error)">${esc(err.message)}</span>`;
    } finally {
      if (mine === testSeq) busyButton(btn, false);
    }
  });

  /* ---------------- 翻译 / 阅读器 ---------------- */
  host.querySelector('#selectionLive').addEventListener('change', async (e) => {
    await api.patchConfig({ settings: { translate: { selectionLive: e.target.checked } } });
    await refresh('data');
  });
  host.querySelector('#trTarget').addEventListener('change', async (e) => {
    await api.patchConfig({ settings: { translate: { target: e.target.value } } });
    await refresh('data');
  });
  host.querySelector('#trMode').addEventListener('change', async (e) => {
    await api.patchConfig({ settings: { reader: { mode: e.target.value } } });
    await refresh('data');
  });

  const fsRange = host.querySelector('#fsRange');
  fsRange.addEventListener('input', () => {
    host.querySelector('#fsVal').textContent = fsRange.value;
  });
  fsRange.addEventListener('change', async () => {
    await api.patchConfig({ settings: { reader: { fontSize: Number(fsRange.value) } } });
    await refresh('data');
  });

  const mwRange = host.querySelector('#mwRange');
  mwRange.addEventListener('input', () => {
    host.querySelector('#mwVal').textContent = mwRange.value;
  });
  mwRange.addEventListener('change', async () => {
    await api.patchConfig({ settings: { reader: { measure: Number(mwRange.value) } } });
    await refresh('data');
  });

  /* ---------------- 语音 ---------------- */
  const rate = host.querySelector('#rateRange');
  rate.addEventListener('input', () => {
    host.querySelector('#rateVal').textContent = Number(rate.value).toFixed(2);
  });
  rate.addEventListener('change', async () => {
    await api.patchConfig({ settings: { tts: { rate: Number(rate.value) } } });
    await refresh('data');
  });

  const vsel = host.querySelector('#voiceSel');
  const fillVoices = () => {
    const vs = (window.speechSynthesis ? speechSynthesis.getVoices() : [])
      .filter((v) => /^(en|zh)/i.test(v.lang));
    vsel.innerHTML = '<option value="">系统默认</option>' + vs.map((v) =>
      `<option value="${esc(v.name)}" ${s.tts.voice === v.name ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  };
  fillVoices();
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = fillVoices;
  vsel.addEventListener('change', async () => {
    await api.patchConfig({ settings: { tts: { voice: vsel.value } } });
    await refresh('data');
  });

  /* ---------------- 暂存区 ---------------- */
  const stg = state.config.staging || {};
  const stgEl = host.querySelector('#stagingPath');
  if (stgEl) {
    stgEl.textContent = stg.root ? shortPath(stg.root, 64) : '未设置';
    stgEl.title = stg.root || '';
  }
  const th = host.querySelector('#stgThreshold');
  if (th) {
    th.value = stg.threshold || 6;
    th.addEventListener('change', async () => {
      await api.patchConfig({ staging: { threshold: Math.max(1, Math.min(30, Number(th.value) || 6)) } });
      await refresh('data');
    });
  }
  host.querySelector('#pickStaging')?.addEventListener('click', async () => {
    const r = await api.pickPath('dir');
    if (!r.path) return;
    await api.setStagingRoot(r.path);
    await refresh('data');
    toast('暂存目录已更新', 'success');
  });

  /* ---------------- 数据 ---------------- */
  host.querySelector('#openData').addEventListener('click', () => api.openPath(meta.dataDir));
  host.querySelector('#openTranslations').addEventListener('click', () => api.openPath(meta.translationsDir));

  host.querySelector('#clearCache').addEventListener('click', async () => {
    const ok = await confirm({
      title: '清空译文缓存？',
      text: '清理临时接口缓存，保留软件根目录中已保存的智能体译文。未保存的内容下次可能需要调用接口翻译。',
      confirmText: '清空',
      danger: true
    });
    if (!ok) return;
    const r = await api.clearCache();
    toast(`已清理 ${r.removed} 份译文缓存`, 'success');
  });

  /* ---------------- 分享 / 更新 / 引导 ---------------- */
  host.querySelector('#exportShare').addEventListener('click', async () => {
    try {
      const r = await api.exportShare();
      if (r.canceled) return;
      toast(`已导出：${r.products} 个产品 · ${r.groups} 个分组 · ${r.combos} 个组合`, 'success', { duration: 2600 });
    } catch (e) { toast(e.message, 'error'); }
  });

  host.querySelector('#importShare').addEventListener('click', async () => {
    try {
      const r = await api.importShare();
      if (r.canceled) return;
      await refresh('data');
      toast(`导入完成：新增 ${r.products} 个产品 · ${r.groups} 个分组 · ${r.combos} 个组合`, 'success', { duration: 2800 });
    } catch (e) { toast(e.message, 'error'); }
  });

  host.querySelector('#openRepo').addEventListener('click', () => {
    api.openUpdate(`https://github.com/${meta.repo || 'kelai061/skill-manage'}`)
      .catch((err) => toast(err.message, 'error'));
  });

  host.querySelector('#checkUpdate').addEventListener('click', async (e) => {
    const btnEl = e.currentTarget;
    busyButton(btnEl, true);
    try {
      const r = await api.checkUpdate();
      openUpdateDialog(r);
    } catch (err) {
      toast(err.message, 'error', { duration: 3200 });
    } finally {
      busyButton(btnEl, false);
    }
  });

  host.querySelector('#replayTour').addEventListener('click', () => openHelp());
  host.querySelector('#redetect').addEventListener('click', () => openDetect());

  host.querySelector('#viewBackups').addEventListener('click', async () => {
    const list = await api.backups();
    dialog({
      title: '写入备份',
      subtitle: `共 ${list.length} 份 · 每次批准写入前自动生成`,
      wide: true,
      body: list.length
        ? `<div style="display:flex;flex-direction:column;gap:1px;max-height:52vh;overflow:auto">
            ${list.map((b) => `
              <div class="list-item">
                <span style="color:var(--md-on-surface-variant)">${icon('file', 'icon--sm')}</span>
                <div class="list-item__body">
                  <div class="list-item__title mono truncate" style="font-size:12px">${esc(b.name)}</div>
                  <div class="list-item__sub">${fmtDate(b.mtime)} · ${fmtBytes(b.size)}</div>
                </div>
                <button class="btn btn--text btn--sm" data-reveal="${esc(b.path)}">定位</button>
              </div>`).join('')}
          </div>`
        : '<p class="muted">还没有备份。</p>',
      actions: [{ label: '关闭' }],
      onMount(ref) {
        ref.body.addEventListener('click', (e) => {
          const b = e.target.closest('[data-reveal]');
          if (b) api.reveal(b.dataset.reveal);
        });
      }
    });
  });
}
