import { api } from './api.js';
import { state, reload } from './state.js';
import { dialog, toast } from './ui.js';

export const APPEARANCES = [
  { id: 'porcelain', name: '浅瓷', color: '#f5f5f7', accent: '#4668a8' },
  { id: 'graphite', name: '石墨', color: '#22262f', accent: '#c7cdd9' },
  { id: 'glacier', name: '冰川', color: '#dbeef8', accent: '#177eaa' },
  { id: 'forest', name: '松绿', color: '#dfece4', accent: '#387359' },
  { id: 'sand', name: '暖砂', color: '#efe5d6', accent: '#94663b' },
  { id: 'glass', name: '玻璃', color: '#d9d7fa', accent: '#6367b6' }
];
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export function applyAppearance(theme, appearance, animate = false) {
  const root = document.documentElement;
  const preset = APPEARANCES.find(p => p.id === appearance) || APPEARANCES[0];
  const mode = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme === 'dark' ? 'dark' : 'light';
  const update = () => {
    root.dataset.appearance = preset.id; root.dataset.theme = mode;
    const css = getComputedStyle(root);
    api.applyTheme(css.getPropertyValue('--md-surface').trim(), css.getPropertyValue('--md-on-surface').trim()).catch(() => {});
  };
  // Apply preferences immediately. Snapshot transitions can defer the update
  // indefinitely when an Electron window is occluded or rapidly switched.
  update();
  if (animate) enterMotion(document.getElementById('canvas'));
  return mode;
}
export function appearanceOptions(selected = 'porcelain') {
  return `<div class="appearance-grid">${APPEARANCES.map(p => `<button type="button" class="appearance-option" data-appearance-opt="${p.id}" aria-pressed="${selected === p.id}" style="--preview:${p.color};--accent:${p.accent}">
    <span class="appearance-option__preview" data-look="${p.id}" aria-hidden="true"><i></i><b></b><em></em></span><span>${p.name}</span></button>`).join('')}</div>`;
}
export function themeOptions(selected = 'light') {
  return `<div class="segmented">${[['light','浅色'],['dark','深色'],['system','自动']].map(([id,name]) => `<button type="button" class="segmented__item" data-theme-opt="${id}" aria-pressed="${selected === id}">${name}</button>`).join('')}</div>`;
}
export function bindAppearance(host) {
  for (const button of host.querySelectorAll('[data-appearance-opt], [data-theme-opt]')) button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const patch = button.dataset.appearanceOpt ? { appearance: button.dataset.appearanceOpt, theme: button.dataset.appearanceOpt === 'graphite' ? 'dark' : 'light' } : { theme: button.dataset.themeOpt };
      await api.patchConfig({ settings: patch }); await reload();
      applyAppearance(state.config.settings.theme, state.config.settings.appearance, true);
      document.querySelectorAll('[data-appearance-opt]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.appearanceOpt === state.config.settings.appearance)));
      document.querySelectorAll('[data-theme-opt]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeOpt === state.config.settings.theme)));
    } catch (e) { toast(e.message, 'error'); }
    finally { button.disabled = false; }
  });
}
export function openAppearance() {
  if (document.querySelector('#appearancePicker')) return;
  const s = state.config.settings;
  const d = dialog({ title: '外观', body: `<div id="appearancePicker">${appearanceOptions(s.appearance)}${themeOptions(s.theme)}</div>` });
  bindAppearance(d.body);
}
export function enterMotion(element, axis = 'y') {
  if (reducedMotion() || !element?.animate) return;
  element.getAnimations().forEach(a => a.cancel());
  element.animate([{ opacity: .35, transform: axis === 'x' ? 'translateX(18px)' : 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: axis === 'x' ? 300 : 230, easing: 'cubic-bezier(.16,1,.3,1)' });
}
