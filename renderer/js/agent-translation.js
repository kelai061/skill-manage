import { api } from './api.js';
import { toast } from './ui.js';

let copying = false;
export async function openBatchTranslation() {
  if (copying) return;
  copying = true;
  try {
    const task = await api.copyTranslation();
    const skipped = task.skipped ? ` · ${task.skipped} 项读取失败` : '';
    toast(task.count ? `指令已复制 · 交给智能体直接翻译并保存（${task.count} 段）${skipped}` : `没有待翻译内容${skipped}`, task.count ? 'success' : '', { duration: 4500 });
  } catch (e) { toast(e.message, 'error'); }
  finally { copying = false; }
}
