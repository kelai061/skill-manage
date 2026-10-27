import { api } from './api.js';
import { state, refresh } from './state.js';
import { esc } from './util.js';
import { confirm, dialog, toast } from './ui.js';

export async function ensureDefaultDirectory() {
  if ((state.config.products || []).some(p => p.thirdParty && p.id === state.config.thirdPartyDefaultProductId)) return true;
  const proceed = await confirm({ title: '设置默认 Skill 目录', text: '导入单个 Skill 前，请选择一个存放目录。', confirmText: '选择目录' });
  if (!proceed) return false;
  const selected = await api.pickPath('dir');
  if (!selected.path) return false;
  const product = await api.addDirectory(selected.path);
  await api.defaultDirectory(product.id);
  await refresh('data');
  return true;
}

export async function importArchiveFile(file) {
  const info = await api.inspectArchive(file);
  const label = info.kind === 'product' ? `产品：${info.name}` : 'Skill 压缩包';
  dialog({ title: '导入压缩包', subtitle: `${label} · ${info.skillCount} 个 Skill`,
    body: `<p>${esc(info.kind === 'product' ? '选择保存位置后，将自动添加为产品。' : '将导入默认 Skill 目录。')}</p>`,
    actions: [{ label: '取消' }, { label: '导入', kind: 'filled', onClick: async () => {
      if (info.kind !== 'product' && !await ensureDefaultDirectory()) return false;
      const result = await api.importArchive(file);
      if (result.canceled) return false;
      await refresh('data');
      toast(`已导入 ${result.skillCount} 个 Skill`, 'success');
    } }]
  });
}

export function installArchiveDrop() {
  document.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async e => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    if (e.target.closest('#archiveDrop')) return;
    const files = e.dataTransfer.files;
    if (files.length !== 1) return toast('请拖入一个 ZIP 文件', 'error');
    try {
      const path = window.atelier.pathForFile(files[0]);
      if (!path) throw new Error('无法读取文件路径，请在设置中选择文件');
      await importArchiveFile(path);
    } catch (err) { toast(err.message, 'error'); }
  });
}
