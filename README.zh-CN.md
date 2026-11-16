# Git Worktree 可视化操作平台

<div align="center">
  <img src="./public/logo.png" alt="wtUI" width="120" />
  <p>多 AI 工具并行开发，一键合并与 AI 冲突解决。</p>
  <p><a href="README.md">English</a> | 简体中文</p>
  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#界面预览">界面预览</a> ·
    <a href="#核心功能">核心功能</a> ·
    <a href="#-交流与支持">交流与支持</a> ·
    <a href="#-许可证">许可证</a>
  </p>
</div>

## 快速开始

```bash
# 全局安装
npm i @undsky/wtui -g

# 启动可视化平台并自动打开浏览器
wtui start
```

## 界面预览

![主界面（亮色主题 / 中文）](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806498647-69869e15-2d1b-4893-9e65-b2b43ea1391c.png)

![解决合并冲突（可视化与 AI 辅助）](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806504662-e805bcf4-2d8b-4397-bdaa-c6080980b6fe.jpg)

![主界面（暗色主题 / English）](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806507456-fee7fb12-8d61-43ba-8dcd-294117ea4eed.png)

## 核心功能

- **项目与工作区管理**：支持添加单个 Git 项目文件夹，或工作区（`.code-workspace`）。
- **多 AI 工具并行开发**：
  - **工作树隔离与状态总览**：一键创建工作树并启动工具，实时展示分支状态、变更差异与冲突风险，支持单分支拉取与推送。
  - **支持任意命令行/图形界面工具**：内置主流 AI 编码 CLI 与图形化 IDE，支持独立终端或编辑器启动，并可自定义扩展。
- **一键合并与 AI 冲突解决**：
  - **一键合并与清理**：支持 Squash、Rebase、快进合并与自动清理推送，可按需配置合并选项。
  - **可视化冲突解决**：冲突时自动弹出面板，支持分块对比采纳、源码直编暂存及放弃操作。
  - **AI 一键合并并提交**：配置 OpenAI / Anthropic 兼容接口后，自动分析解决冲突并完成合并提交。

## 💬 交流与支持

|                    公众号                    |                     QQ群                      |
| :------------------------------------------: | :-------------------------------------------: |
| ![公众号](https://cdn.undsky.com/img/gh.jpg) | ![QQ群](https://cdn.undsky.com/img/qqqun.jpg) |

---

## 📄 许可证

本项目采用 [CC BY-NC 4.0](LICENSE) 许可证。

- 个人使用、学习、研究与非商业项目可以直接使用。
- 公开发布衍生作品时，请注明来源。
- 商业用途需要单独授权，请联系作者。
