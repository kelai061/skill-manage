# Skill Atelier

本地 Skill 管理器：发现、分组、组合、阅读与双语对照。

[下载 v1.1.0](https://github.com/kelai061/skill-manage/releases/tag/v1.1.0) · [使用说明](renderer/help.md) · [更新记录](CHANGELOG.md)

![全部 Skill](docs/skills.png)

## 使用

下载 Windows 安装版或便携版，添加智能体产品的启动路径，即可发现 Skill。支持嵌套技能集、收藏、分组和路径组合；阅读器提供双语对照、词级高亮、批注和朗读。

Skill 助手需配置支持工具调用的 OpenAI 兼容接口，详见 [助手说明](SKILL-AGENT.md)。扫描、阅读和翻译不修改源文件；AI 改写需审批。

配置：安装版位于 %LOCALAPPDATA%/SkillAtelier/data；便携版位于程序旁的 SkillAtelier-data。持久译文与翻译任务保存在程序根目录。

## 开发

Electron + 原生 JavaScript/CSS。


发行文件生成在 release/current，历史版本保存在 release/archive。

MIT © kelai061
