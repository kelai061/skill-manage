# Skill Atelier

> Skill 管理平台

[![版本](https://img.shields.io/github/v/release/kelai061/skill-manage?label=版本)](https://github.com/kelai061/skill-manage/releases)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)


给智能体产品一个启动路径，它自动把这个产品下所有 skill 找出来全部放在一个窗口里；源文件全程只读。

![全部 Skill](docs/skills.png)

---

## 下载

到 [Releases](https://github.com/kelai061/skill-manage/releases) 下载：
装完首次启动会扫描本机已装的智能体工具

> **数据在哪里**
> - 便携版：exe 同目录的 `SkillAtelier-data\`，整个文件夹拷走即可换机器
> - 安装版：`%LOCALAPPDATA%\SkillAtelier\data\`
---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **嵌套技能集** | 套娃的 skill 收成一张汇总卡，点开下钻，也可手动移出到顶层 |
| **组合** | 多选存为组合，一键复制路径清单；临时组合随手攒，满意了再存正式 |
| **双语对照** | 逐段翻译，并排 / 行间两种模式，滚动与选中双向同步 |
| **词级对齐** | 选中一个单词，对侧精确高亮对应译词，给出「源词 → 译词」 |
| **标记与朗读** | 四色高亮 + 备注；系统语音朗读选中片段或全文 |

---
<table>
<tr>
<td width="50%"><img src="docs/reader-side.png" alt="并排双语对照"></td>
<td width="50%"><img src="docs/combos.png" alt="组合"></td>
</tr>
<tr>
<td><em>并排对照：滚动、选中、词级高亮三向同步</em></td>
<td><em>组合：把一组 skill 的路径一次交给智能体</em></td>
</tr>
</table>

---


## 设计原则
- Electron + 原生 ES Module + CSS，零前端框架、零打包器
---

## 技术栈

- **Electron 44** —
- **原生 ES Module + CSS** — 
- **自定义 `app://` 协议** — 
- **Material Design 3** — 
- **zlib（内置）** — 
- **Web Speech API** — 

---

## 源码运行

```bash
git clone https://github.com/kelai061/skill-manage.git
cd skill-manage
npm install
npm run dev          # 开发模式（带 DevTools）
npm start            # 正常启动
npm test             # 临时样本 + 本机模拟 AI 接口，不读取个人配置
npm run pack         # 目录便携版 → release/build/portable/SkillAtelier/
npm run pack:release # ZIP → release/current/
npm run dist         # 安装版和单文件便携版 → release/current/
```



## 目录结构

```
main/       主进程：扫描、索引、AI、打包、更新
renderer/   渲染层：视图、组件、样式（无框架）
shared/     主进程与渲染层共用的纯函数（切句、对齐）
scripts/    启动、打包、图标、自动化验收
build/      图标等构建资源
site/       产品介绍页（静态 HTML）
```



## License

MIT © kelai061
