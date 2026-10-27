'use strict';
const assert = require('node:assert/strict');

module.exports = async ({ win, delay }) => {
  const js = code => win.webContents.executeJavaScript(code, true);
  await js(`(() => {
    document.body.innerHTML = '<article class="card" tabindex="0" style="position:fixed;left:100px;top:100px;width:300px;height:180px"><button id="fixtureButton" style="width:100px;height:32px">测试</button><div class="description-flip"><p class="description-flip__front">原说明</p><p class="description-flip__back">自定义说明</p></div></article>';
  })()`);
  const send = event => win.webContents.sendInputEvent(event);
  const point = await js(`(() => { const r = document.querySelector('#fixtureButton').getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
  send({type:'mouseMove', ...point}); await delay(350);
  assert.equal(await js(`getComputedStyle(document.querySelector('.description-flip__back')).opacity`), '1', 'hover should reveal custom description');
  send({type:'mouseDown', ...point, button:'left', clickCount:1});
  send({type:'mouseUp', ...point, button:'left', clickCount:1});
  send({type:'mouseMove', x:600, y:500}); await delay(350);
  assert.equal(await js(`document.activeElement.id`), 'fixtureButton', 'mouse click should focus the button');
  assert.equal(await js(`getComputedStyle(document.querySelector('.description-flip__back')).opacity`), '0', 'mouse leave should restore original even when a clicked button retains focus');
  await js(`document.activeElement.blur()`);
  send({type:'keyDown', keyCode:'Tab'}); send({type:'keyUp', keyCode:'Tab'}); await delay(350);
  assert.equal(await js(`document.activeElement.matches(':focus-visible')`), true, 'keyboard focus should remain visible');
  assert.equal(await js(`getComputedStyle(document.querySelector('.description-flip__back')).opacity`), '1', 'keyboard focus should reveal custom description');
  console.log('[PASS] Hover, mouse leave after click, and keyboard focus show the intended description face');
  return {ok:true};
};
