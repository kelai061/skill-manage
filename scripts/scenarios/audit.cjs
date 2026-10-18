'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..', '..');

module.exports = async ({ win, app, delay, shot }) => {
  const results = [];
  const check = (name, ok, detail = null) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const state = (await js("window.atelier.call('config:get', {})")).data;
  const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = state.skills.map((s) => [s.path, hash(s.path)]);
  await js(`(async()=>{window.__auditUi = await import('app://local/js/ui.js'); return 1;})()`);
  const confirm = await js(`(async () => {
    let value = 'pending';
    window.__auditUi.confirm({ title: 'Cancel fixture', text: 'Close me' }).then((v) => { value = v; });
    document.querySelector('.scrim [data-close]').click();
    await new Promise((r) => setTimeout(r, 80));
    return value;
  })()`);
  check('关闭确认框会返回取消，不留下悬挂操作', confirm === false);
  const prompt = await js(`(async () => {
    let value = 'pending';
    window.__auditUi.promptText({ title: 'Prompt fixture' }).then((v) => { value = v; });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 80));
    return value;
  })()`);
  check('Esc 关闭输入框会返回取消', prompt === null);
  const nested = await js(`(() => {
    const a = window.__auditUi.dialog({title:'Outer'});
    const b = window.__auditUi.dialog({title:'Inner'});
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    const count = document.querySelectorAll('.scrim').length;
    a.close(); b.close(); a.close();
    return count;
  })()`);
  check('Esc 只关闭最上层弹窗，重复关闭安全', nested === 1);
  const duplicate = await js(`(async () => {
    let count=0;
    const d=window.__auditUi.dialog({ title:'Single submit',actions:[{label:'Submit',onClick:async()=>{count++;await new Promise(r=>setTimeout(r,100));}}] });
    const b=d.root.querySelector('.dialog__foot button'); b.click(); b.click();
    await new Promise(r=>setTimeout(r,160)); return count;
  })()`);
  check('耗时操作防止重复提交', duplicate === 1);
  const detect = await js(`(async () => {
    const api=(await import('app://local/js/api.js')).api;
    const old=api.detectTools;api.detectTools=async()=>({items:[]});
    let finished=false;
    const p=(await import('app://local/js/onboarding.js')).openDetect().then(()=>{finished=true});
    await new Promise(r=>setTimeout(r,120));
    const waits=!finished && document.querySelectorAll('.scrim').length===1;
    document.querySelector('.scrim [data-close]').click();await p;api.detectTools=old;
    return { waits, finished };
  })()`);
  check('检测引导等待用户关闭后才进入下一步', detect.waits && detect.finished);
  const assets = await js(`(async () => {
    const urls=['app://local/shared/..%2fmain%2fstore.js','app://local/..%2fpackage.json'];
    return await Promise.all(urls.map(async u=>(await fetch(u)).status));
  })()`);
  check('渲染层无法经编码路径读取主进程或包配置', assets.every((s) => s === 404), assets);
  const index = state.meta.indexFile;
  check('测试清单只落独立 profile', path.relative(app.getPath('userData'), index) === 'skills.index.md');
  const project = await js(`(async()=>{
    window.__goto('skills');await new Promise(r=>setTimeout(r,150));
    document.querySelector('[data-scope="project"]').click();await new Promise(r=>setTimeout(r,150));
    const cards=[...document.querySelectorAll('[data-projcard]')];
    const empty=cards.find(c=>c.textContent.includes('Empty project'));
    return { count:cards.length,zero:!!empty&&/0 个 skill/.test(empty.textContent) };
  })()`);
  check('项目总览保留零 skill 项目', project.count === 2 && project.zero, project);
  const sharePath = path.join(app.getPath('userData'), 'share-test.json');
  const share = await js(`window.atelier.call('share:export', {path:${JSON.stringify(sharePath)}})`);
  const exported = JSON.parse(fs.readFileSync(sharePath, 'utf8'));
  check('分享导出不含接口配置或密钥', share.ok && !JSON.stringify(exported).includes('fixture-only') && !exported.settings);
  const files = state.skills.find((s) => s.name === 'follow-builders');
  const previews = [];
  for (const name of ['sample.py', 'sample.txt', 'sample.png']) {
    const r = await js(`window.atelier.call('file:read',{p:${JSON.stringify(path.join(files.dir, name))}})`);
    previews.push(r.ok);
  }
  check('代码、文本、图片附属文件可读取', previews.every(Boolean));
  const outside = await js(`window.atelier.call('file:read',{p:${JSON.stringify(path.join(app.getPath('userData'), 'config.json'))}})`);
  check('已索引 skill 之外的文件读取被拒绝', !outside.ok);
  const words = await js(`(async()=>{
    window.__goto('skills'); await new Promise(r=>setTimeout(r,150));
    document.querySelector('[data-scope="all"]').click();await new Promise(r=>setTimeout(r,150));
    const cards=[...document.querySelectorAll('.card[data-id]')];
    cards.find(c=>c.querySelector('.card__title')?.textContent==='follow-builders').querySelector('[data-act="read"]').click();
    const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return true;await new Promise(r=>setTimeout(r,100));}return false;};
    await until(()=>document.querySelector('[data-mode="side"]'));
    document.querySelector('[data-mode="side"]').click();
    const ready=await until(()=>document.querySelector('#proseDst') && Object.values(window.__atelierDebug?.getAlign()||{}).some(a=>a.some(p=>p[0]==='Builders')));
    if(!ready)return {ready:false};
    const select=async(pane,term)=>{
      const walker=document.createTreeWalker(document.querySelector(pane),NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())){const start=node.nodeValue.indexOf(term);if(start<0)continue;
        node.parentElement.scrollIntoView({block:'center'});const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+term.length);
        getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));
        await new Promise(r=>setTimeout(r,400));return [...(CSS.highlights.get('sync')||[])].map(r=>r.toString()).join('');
      }return '';
    };
    const forward=await select('#proseSrc','Builders');
    const backward=await select('#proseDst','构建者');
    return {ready,forward,backward};
  })()`);
  check('真实对齐接口结果支持原文单词精确定位译词', words.ready && words.forward === '构建者', words);
  check('选中译词可精确回指原文单词', words.ready && words.backward === 'Builders');
  const detected = await js("window.atelier.call('app:detectTools',{})");
  check('本机工具检测正常返回', detected.ok && Array.isArray(detected.data.items), detected.ok ? detected.data.items.map((x) => ({ name: x.name, skills: x.skills })) : null);
  const allUnchanged = before.every(([file, original]) => fs.existsSync(file) && hash(file) === original);
  check('浏览、检测、预览与分享后所有原始 skill 均未改动', allUnchanged);
  await js("window.__goto('settings'); 1;");
  await delay(300);
  await shot('audit-settings');
  const passed = results.filter((x) => x.ok).length;
  const report = { at: new Date().toISOString(), version: app.getVersion(), total: results.length, passed, failed: results.length - passed, results };
  fs.writeFileSync(path.join(ROOT, 'docs', 'test-report-audit.json'), JSON.stringify(report, null, 2));
  return { ok: report.failed === 0, summary: { passed, failed: report.failed } };
};
