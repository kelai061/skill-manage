/* ai-dialog.js — AI 改写提案 → 逐行差异审阅 → 授权写入 */

import { icon } from './icons.js';
import { state, skillById } from './state.js';
import { api } from './api.js';
import { esc, fmtBytes } from './util.js';
import { toast, dialog, confirm } from './ui.js';

const PRESETS = [
  '精简冗余表述，保留全部技术细节与结构',
  '把描述补全为清晰的触发条件 + 边界说明',
  '统一术语与语气，改成更直接的技术文档口吻',
  '把长段落拆成可扫读的列表，不丢信息'
];

export function openAiRewrite(skillId, onDone) {
  const skill = skillById(skillId);
  if (!skill) return toast('skill 不存在', 'error');
  if (skill.readOnly) return toast('程序内置技能只读，可阅读和翻译。', '');

  let proposal = null;
  let phase = 'input';

  const body = `
    <div id="phaseInput">
      <label class="field">
        <span class="field__label">改写要求</span>
        <textarea class="textarea" id="instr" style="min-height:110px"
          placeholder="例如：把「何时使用」一节改写成判定清单，保留所有路径与命令不动。"></textarea>
      </label>
      <div class="chip-row" style="margin-top:10px">
        ${PRESETS.map((p) => `<button class="chip" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}
      </div>
      <div class="row" style="margin-top:16px;gap:10px;align-items:flex-start;
        background:var(--md-surface-container);border-radius:var(--shape-md);padding:12px 14px">
        <span style="color:var(--md-primary)">${icon('lock', 'icon--sm')}</span>
        <p style="margin:0;font:var(--type-body-s);color:var(--md-on-surface-variant);line-height:1.7">
          AI 只负责生成提案。平台会把它与原文件算成逐行差异交给你审阅，
          只有你点「批准并写入」才会备份原件并落盘。文件在提案生成后被外部改动，写入会被自动中止。
        </p>
      </div>
    </div>
    <div id="phaseDiff" class="hidden">
      <div class="row" style="margin-bottom:10px;gap:8px">
        <span class="badge badge--success">+${'0'} 行</span>
        <span class="badge" style="background:var(--md-error-container);color:var(--md-on-error-container)">-0 行</span>
        <span class="spacer"></span>
        <span class="muted" id="diffStat" style="font:var(--type-body-s)"></span>
      </div>
      <div class="diff" id="diffBox"></div>
    </div>
    <div id="phaseBusy" class="hidden" style="padding:32px 0;text-align:center">
      <div class="row" style="justify-content:center;gap:10px;color:var(--md-on-surface-variant)">
        <span class="spinner"></span><span id="busyText">正在生成提案…</span>
      </div>
    </div>
  `;

  const d = dialog({
    title: 'AI 改写 · ' + skill.name,
    subtitle: '先出提案，再逐行审阅，最后授权写入',
    wide: true,
    body,
    actions: [
      { label: '关闭' },
      {
        label: '生成提案',
        icon: 'sparkles',
        kind: 'outlined',
        keepOpen: true,
        onClick: async (ref) => {
          const instr = ref.body.querySelector('#instr').value.trim();
          if (!instr) { toast('请先写下改写要求', 'error'); return; }
          await runPropose(ref, instr);
        }
      },
      {
        label: '批准并写入',
        icon: 'check',
        kind: 'filled',
        keepOpen: true,
        disabled: true,
        onClick: async (ref) => {
          if (!proposal) return;
          const ok = await confirm({
            title: '确认写入这个 skill？',
            text: '写入前会自动备份当前 SKILL.md，可在「设置 → 查看备份」找回。',
            confirmText: '批准并写入'
          });
          if (!ok) return;
          try {
            const r = await api.approve(proposal.proposalId);
            toast('已写入，原件已备份', 'success', { actionLabel: '定位备份', onAction: () => api.reveal(r.backup) });
            ref.close();
            if (onDone) onDone();
          } catch (e) {
            toast(e.message, 'error');
          }
        }
      }
    ]
  });

  const btnApply = d.root.querySelector('.dialog__foot .btn--filled');
  const btnGen = d.root.querySelector('.dialog__foot .btn--outlined');

  d.body.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      d.body.querySelector('#instr').value = b.dataset.preset;
    });
  });

  async function runPropose(ref, instr) {
    if (!state.config.settings.api.key) {
      toast('还没配置 API Key，去「设置 → AI 接口」填一下', 'error', {
        actionLabel: '去设置',
        onAction: () => { ref.close(); window.__goto('settings'); }
      });
      return;
    }
    phase = 'busy';
    ref.body.querySelector('#phaseInput').classList.add('hidden');
    ref.body.querySelector('#phaseDiff').classList.add('hidden');
    ref.body.querySelector('#phaseBusy').classList.remove('hidden');
    btnGen.disabled = true;
    btnApply.disabled = true;

    try {
      const r = await api.propose(skill.id, instr);
      proposal = r;
      phase = 'diff';

      ref.body.querySelector('#phaseBusy').classList.add('hidden');
      ref.body.querySelector('#phaseDiff').classList.remove('hidden');

      const badges = ref.body.querySelectorAll('#phaseDiff .badge');
      badges[0].textContent = `+${r.added} 行`;
      badges[1].textContent = `-${r.removed} 行`;
      ref.body.querySelector('#diffStat').textContent =
        `${r.model} · ${fmtBytes(r.bytesBefore)} → ${fmtBytes(r.bytesAfter)}`;

      ref.body.querySelector('#diffBox').innerHTML = r.diff.map((row) => {
        if (row.t === 'skip') return `<div class="diff__row diff__row--skip">⋯ 省略 ${row.count} 行未变更 ⋯</div>`;
        const sign = row.t === 'add' ? '+' : row.t === 'del' ? '-' : ' ';
        const cls = row.t === 'add' ? 'diff__row--add' : row.t === 'del' ? 'diff__row--del' : '';
        return `<div class="diff__row ${cls}"><span class="diff__sign">${sign}</span><span>${esc(row.text) || ' '}</span></div>`;
      }).join('');

      btnApply.disabled = false;
      btnGen.innerHTML = '重新生成';
      btnGen.disabled = false;
      toast('提案已生成，请审阅差异', '', { duration: 2200 });
    } catch (e) {
      phase = 'input';
      ref.body.querySelector('#phaseBusy').classList.add('hidden');
      ref.body.querySelector('#phaseInput').classList.remove('hidden');
      btnGen.disabled = false;
      toast(e.message, 'error', { duration: 7000 });
    }
  }

  // 关闭时丢弃未批准的提案
  const origClose = d.close;
  d.close = () => {
    if (proposal && phase === 'diff') {
      api.reject(proposal.proposalId).catch(() => {});
    }
    origClose();
  };
}
