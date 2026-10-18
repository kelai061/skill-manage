/* onboarding.js — 首次启动：自动探测本机工具 + 新手教程 */

import { state, products, refresh } from './state.js';
import { api } from './api.js';
import { icon } from './icons.js';
import { esc } from './util.js';
import { dialog, toast } from './ui.js';
import { renderProse } from './md.js';
import { segmentMarkdown } from '../../../shared/mdseg.mjs';

function onboarded() {
  return (state.config.settings && state.config.settings.onboarded) || {};
}

async function markOnboarded(patch) {
  try { await api.patchConfig({ settings: { onboarded: { ...onboarded(), ...patch } } }); } catch { /* ignore */ }
}

/* ------------------------------ 工具探测 ------------------------------ */

export async function openDetect({ firstRun = false } = {}) {
  let items = [];
  try {
    const r = await api.detectTools();
    items = r.items || [];
  } catch (e) {
    toast(e.message, 'error');
    return;
  }

  if (!items.length) {
    dialog({
      title: firstRun ? '没有发现智能体工具' : '没有发现新的智能体工具',
      subtitle: '你可以手动填一个启动路径',
      body: `<p class="muted" style="margin:0">我们找过 WorkBuddy、Antigravity、Claude Code、Cursor、Codex、Gemini CLI、Windsurf 的常见安装位置，都没有找到。</p>`,
      actions: [
        { label: '稍后', kind: 'text' },
        {
          label: '去产品页手动添加',
          kind: 'filled',
          onClick: () => { window.__goto('products'); }
        }
      ]
    });
    await markOnboarded({ detect: true });
    return;
  }

  const body = `
    <div class="detect">
      <p class="detect__hint">找到 ${items.length} 个工具。勾选后一键收录，它会自动扫描全局与项目 skill（只读）。</p>
      ${items.map((it) => `
        <label class="detect__row">
          <input type="checkbox" data-tool="${esc(it.id)}" checked />
          <span class="detect__icon">${icon('cpu', 'icon--sm')}</span>
          <span class="detect__body">
            <strong>${esc(it.name)}</strong>
            <span class="detect__meta">${it.skills} 个 skill${it.hasApp ? '' : ' · 仅数据目录'}</span>
            <span class="detect__path mono">${esc(it.launchPath)}</span>
          </span>
        </label>`).join('')}
    </div>`;

  dialog({
    title: firstRun ? '先认识一下你的工具' : '自动发现工具',
    subtitle: '只读探测，不会修改任何工具的文件',
    body,
    wide: true,
    actions: [
      {
        label: '稍后再说',
        kind: 'text',
        onClick: () => { markOnboarded({ detect: true }); }
      },
      {
        label: '收录选中的',
        kind: 'filled',
        ref: 'go',
        onClick: async (d) => {
          const ids = [...d.body.querySelectorAll('[data-tool]')]
            .filter((x) => x.checked)
            .map((x) => x.dataset.tool);
          if (!ids.length) { toast('至少选一个工具', ''); return false; }

          let ok = 0;
          for (const id of ids) {
            const it = items.find((x) => x.id === id);
            if (!it) continue;
            try {
              await api.addProduct({ launchPath: it.launchPath, name: it.name, roots: it.roots });
              ok++;
            } catch (e) {
              toast(`${it.name}：${e.message}`, 'error', { duration: 3200 });
            }
          }
          await markOnboarded({ detect: true });
          await refresh('data');
          toast(ok ? `已收录 ${ok} 个工具` : '没有收录任何工具', ok ? 'success' : '');
        }
      }
    ]
  });
}

/* ------------------------------ 使用说明（Markdown） ------------------------------ */

/**
 * 首次帮助不再做分步弹窗，直接展示一份 Markdown 说明。
 * 内容与仓库 README / 官网共用同一份语气：先讲怎么开始，再讲细节。
 */
export async function openHelp() {
  const d = dialog({
    title: '使用说明',
    subtitle: '一份文档讲完：第一次使用、界面、双语对照、组合、数据与更新',
    wide: true,
    body: '<div class="prose helpdoc" id="helpDoc"><p class="muted">正在载入…</p></div>',
    actions: [{ label: '知道了', kind: 'filled', onClick: () => markOnboarded({ help: true }) }]
  });

  const box = d.body.querySelector('#helpDoc');
  try {
    const res = await fetch('app://local/help.md');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    box.innerHTML = renderProse(segmentMarkdown(text), { lang: 'src' });
  } catch (e) {
    box.innerHTML = `<p class="muted">说明文档载入失败：${esc(e.message)}</p>`;
  }
}

/* ------------------------------ 启动入口 ------------------------------ */

export async function maybeOnboard() {
  if (window.atelier && window.atelier.automated) return;
  const ob = onboarded();

  if (!ob.detect && !products().length) {
    await openDetect({ firstRun: true });
  }
  if (!ob.help) {
    await openHelp();
  }
}
