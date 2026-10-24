'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({win,app,delay,shot}) => {
  const js = code => win.webContents.executeJavaScript(code, true);
  const results = [];
  const check = (name, condition, detail) => { results.push({name,passed:!!condition,detail}); assert(condition, name + ': ' + JSON.stringify(detail)); console.log('[PASS] ' + name); };
  async function until(code) { const end=Date.now()+10000; while(Date.now()<end) { if(await js(code)) return; await delay(60); } throw new Error('UI timeout: '+code); }
  await until('!!document.querySelector("#themeToggle")');
  await js("window.__goto('settings'); true");
  check('six distinct appearance choices', await js("document.querySelectorAll('[data-appearance-opt]').length === 6"));
  const samples=[];
  for (const id of ['porcelain','graphite','glacier','forest','sand','glass']) {
    await js(`document.querySelector('[data-appearance-opt="${id}"]').click(); true`);
    await until(`document.documentElement.dataset.appearance === '${id}' && !document.querySelector('[data-appearance-opt="${id}"]').disabled`);
    await delay(500);
    const values=await js(`(() => { const r=getComputedStyle(document.documentElement), c=getComputedStyle(document.querySelector('.card')); return {primary:r.getPropertyValue('--md-primary').trim(),surface:r.getPropertyValue('--md-surface').trim(),blur:c.backdropFilter,textFilter:c.filter,pressed:document.querySelector('[data-appearance-opt="${id}"]').getAttribute('aria-pressed')}; })()`);
    check(id+' material and selection', values.pressed==='true' && values.textFilter==='none' && (id==='glass' ? values.blur.includes('blur') : values.blur==='none'), values);
    samples.push(values.primary+'|'+values.surface);
    await shot('appearance-'+id);
  }
  check('all six palettes are different',new Set(samples).size===6);
  check('appearance persisted to config',(await js("window.atelier.call('config:get')")).data.settings.appearance==='glass');
  await js("document.querySelector('[data-theme-opt=dark]').click(); true");
  await until("document.documentElement.dataset.theme==='dark'");
  check('theme selection updates aria',await js("document.querySelector('[data-theme-opt=dark]').getAttribute('aria-pressed') === 'true'"));
  win.webContents.reload(); await until("document.documentElement.dataset.appearance==='glass' && document.documentElement.dataset.theme==='dark'");
  check('theme and appearance restored',true);
  await js("window.__appearanceErrors=[]; window.addEventListener('unhandledrejection',e=>window.__appearanceErrors.push(String(e.reason))); true");
  await js("document.querySelector('#themeToggle').click(); true");
  check('quick appearance picker opens',await js("document.querySelectorAll('#appearancePicker [data-appearance-opt]').length===6"));
  await js("document.querySelector('#appearancePicker [data-appearance-opt=forest]').click(); true");
  await until("document.documentElement.dataset.appearance==='forest'");
  check('quick picker applies live',await js("document.querySelector('#appearancePicker [data-appearance-opt=forest]').getAttribute('aria-pressed')==='true'"));
  await js("document.querySelector('#appearancePicker [data-appearance-opt=glass]').click(); true");
  await until("document.documentElement.dataset.appearance==='glass'");
  await js("document.querySelector('#appearancePicker [data-theme-opt=dark]').click(); true");
  await until("document.documentElement.dataset.theme==='dark'");
  await js("document.querySelector('.scrim [data-close]').click(); true");
  check('page change has an entrance animation',await js("window.__goto('groups'); document.querySelector('#canvas').getAnimations().length>0"));
  await until("getComputedStyle(document.querySelector('#canvas')).transform==='none'");
  check('page text rests at native scale',await js("getComputedStyle(document.querySelector('#canvas')).transform==='none'"));

  // Groups: card body + keyboard enter, with nested operations kept independent.
  await js(`(async () => {
    const {api}=await import('./js/api.js'); const {state,refresh}=await import('./js/state.js');
    const g=await api.createGroup('设计组','primary'); window.appearanceGroup=g.id;
    await api.setGroups(state.config.skills.find(s=>s.name==='follow-builders').id,[g.id]);
    await refresh(); window.__goto('groups');
  })()`);
  check('group card is keyboard reachable',await js("document.querySelector('[data-gid]').tabIndex===0"));
  check('redundant group explanation removed',await js("!document.querySelector('#canvas').textContent.includes('分组只记录') && !document.querySelector('#canvas').textContent.includes('查看成员')"));
  await js("document.querySelector('[data-gid] .card__title').click(); true");
  check('group body enters matching skills',await js("document.querySelectorAll('#grid [data-id]').length===1 && document.querySelector('#grid').textContent.includes('follow-builders')"));
  await js("window.__goto('groups'); document.querySelector('[data-gid]').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true})); true");
  check('space enters group',await js("document.querySelectorAll('#grid [data-id]').length===1"));
  await js("window.__goto('groups'); document.querySelector('[data-gid] [data-edit]').click(); true");
  check('edit button does not enter group',await js("!!document.querySelector('.scrim') && !!document.querySelector('[data-gid]')"));
  await js("document.querySelector('.scrim [data-close]').click(); document.querySelector('[data-gid] [data-more]').click(); true");
  check('more button does not enter group',await js("!!document.querySelector('.menu') && !!document.querySelector('[data-gid]')"));
  await js("(async () => { (await import('./js/ui.js')).closeMenu(); window.__goto('skills'); document.querySelector('#agentToggle').click(); })()");
  win.setSize(1000,660); await delay(400);
  const bounds=await js(`(() => {const bar=document.querySelector('.appbar').getBoundingClientRect(), actions=document.querySelector('.appbar__actions').getBoundingClientRect(), close=document.querySelector('#agentClose').getBoundingClientRect(), panel=document.querySelector('#skillAgent'); return {barRight:bar.right,width:innerWidth,actionsRight:actions.right,closeRight:close.right,scroll:panel.scrollWidth,client:panel.clientWidth,headerColor:getComputedStyle(document.querySelector('.appbar')).backgroundColor,surface:getComputedStyle(document.documentElement).getPropertyValue('--md-surface').trim()};})()`);
  check('full-width toolbar reserves native buttons',bounds.barRight===bounds.width && bounds.actionsRight<=bounds.width-140,bounds);
  check('assistant close fits; no horizontal scroll',bounds.closeRight<=bounds.width && bounds.scroll<=bounds.client+1,bounds);
  await shot('appearance-glass-compact');
  await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true");
  check('Escape closes assistant',await js("document.querySelector('#skillAgent').hidden"));

  await win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await js("window.__goto('groups'); true");
    check('reduced-motion has no canvas entrance',await js("document.querySelector('#canvas').getAnimations().length===0"));
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
    check('reduced-transparency removes glass blur',await js("getComputedStyle(document.querySelector('.card')).backdropFilter==='none'"));
  } finally { win.webContents.debugger.detach(); }
  check('rapid theme switches have no unhandled rejection',await js("window.__appearanceErrors.length===0"),await js("window.__appearanceErrors"));
  const report={date:'2026-10-24',suite:'appearance',packaged:app.isPackaged,executable:process.execPath,total:results.length,passed:results.filter(r=>r.passed).length,results};
  fs.writeFileSync(path.join(__dirname,'..','..','docs','test-report-appearance.json'),JSON.stringify(report,null,2));
  return {ok:true,summary:report.passed+'/'+report.total};
};
