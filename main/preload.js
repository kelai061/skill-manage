'use strict';
/**
 * preload.js — 唯一的能力出口
 *
 * 渲染进程拿不到 require / fs / fetch(任意域)，只能调用下面白名单里的通道。
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'config:get', 'config:patch',
  'product:probe', 'product:add', 'product:remove', 'product:rescan',
  'product:addProjectRoot', 'product:removeProjectRoot', 'product:pickPath',
  'product:hideSkill', 'product:autoProjects',
  'project:discover', 'project:add', 'project:remove', 'project:rescan',
  'skill:list', 'skill:read', 'skill:files', 'skill:reveal', 'skill:setGroups',
  'skill:create', 'skill:delete', 'skill:detach', 'file:read',
  'favorite:toggle', 'rating:set',
  'staging:get', 'staging:setRoot', 'import:url', 'organize:propose', 'organize:apply',
  'group:create', 'group:update', 'group:delete',
  'combo:create', 'combo:update', 'combo:delete', 'combo:copy', 'combo:text',
  'scratch:get', 'scratch:set', 'scratch:add', 'scratch:remove', 'scratch:clear', 'scratch:promote',
  'ai:test', 'ai:translate', 'ai:align', 'ai:propose', 'ai:approve', 'ai:reject', 'ai:audit',
  'anno:get', 'anno:set',
  'clipboard:write', 'shell:openPath', 'backup:list', 'cache:clear',
  'app:detectTools', 'app:copyBrief', 'share:export', 'share:import', 'share:comboText',
  'update:check', 'update:open',
  'theme:apply'
]);

contextBridge.exposeInMainWorld('atelier', {
  call(channel, payload) {
    if (!CHANNELS.has(channel)) {
      return Promise.reject(new Error('未授权的通道：' + channel));
    }
    return ipcRenderer.invoke(channel, payload || {});
  },
  platform: process.platform,
  // 自动化验收时跳过首次启动引导，避免弹窗挡住点击
  automated: process.argv.includes('--atelier-automated')
});
