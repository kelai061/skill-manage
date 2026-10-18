# Skill Atelier

> 本地 Skill 管理平台 —— 路径即入口，卡片即索引，授权即写权。

[![版本](https://img.shields.io/github/v/release/kelai061/skill-manage?label=版本)](https://github.com/kelai061/skill-manage/releases)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Skill Atelier** 是一款面向智能体（Agent）开发者的本地 Skill 管理工具。给它一个智能体产品的启动路径，它自动把这个产品下所有 skill 找出来，让你浏览、分组、组合、精读、双语对照，并把路径交给智能体。

---

## 功能一览

| 功能 | 说明 |
|---|---|
| **自动探测** | 首次启动自动扫描本机已安装的 WorkBuddy、Antigravity、Claude Code、Cursor、Codex、Gemini CLI、Windsurf 等工具 |
| **卡片索引** | Skill 以卡片墙呈现，支持搜索、筛选、收藏、评分 |
| **双语对照** | 逐段翻译 + 词级对齐：选中一个单词，对侧精确高亮对应译词 |
| **组合输出** | 多选 skill 存为组合，一键复制路径清单，直接贴给智能体 |
| **附属预览** | 图片直接显示、代码带行号、Word 抽正文、二进制明确提示 |
| **分享迁移** | 导出/导入 JSON 分享包，分类与组合随身携带 |
| **更新检查** | 自动检测 GitHub Release 新版本，顶栏提示 |

---

## 下载与运行

### 绿色版（推荐）

1. 到 [Releases](https://github.com/kelai061/skill-manage/releases) 下载 `SkillAtelier-x.x.x.exe`（便携包，无需安装）
2. 解压到任意目录
3. 双击 `SkillAtelier.exe`

> 数据保存在 `%APPDATA%\Skill Atelier\`，与程序目录分离，升级时直接替换即可。

### 源码运行（开发者）

```bash
git clone https://github.com/kelai061/skill-manage.git
cd skill-manage
npm install
npm run dev
```

---

## 快速开始

1. **添加产品**：侧边栏 →「产品」→「添加产品」，填智能体工具的安装路径
2. **浏览 Skill**：回到「全部 Skill」，卡片墙即索引结果
3. **精读**：点卡片右下角「阅读」打开阅读器，可翻译、标记、朗读
4. **组合**：多选卡片 →「存为组合」→「组合」页一键复制路径

更多细节见应用内「设置 → 使用说明」。

---

## 技术栈

- **Electron 44** — 跨平台桌面壳
- **原生 ES Module** — 无打包工具，直接运行
- **自定义 `app://` 协议** — 安全隔离主进程与渲染进程
- **zlib（内置）** — 自解析 docx，零外部依赖
- **Web Speech API** — 本地朗读，不联网

---

## 只读承诺

- 扫描、阅读、翻译、标记**全程不写源目录**
- 唯一会写入的是你亲手批准的 `SKILL.md` 改写（写入前自动备份）
- 配置、译文缓存、标记全部落在 `%APPDATA%\Skill Atelier\`

---

## 发布到 GitHub

```bash
# 1. 改版本号
npm version patch   # 或 minor / major

# 2. 构建绿色版
npm run pack
# → release/SkillAtelier/SkillAtelier.exe

# 3. 打 Tag 并推送
git add .
git commit -m "release v$(node -p "require('./package.json').version")"
git tag v$(node -p "require('./package.json').version")
git push origin main --tags

# 4. 到 GitHub 创建 Release，上传 SkillAtelier.exe 作为附件
```

---

## License

MIT © kelai061
