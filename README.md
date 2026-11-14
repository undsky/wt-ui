# wt-ui

多智能体协作、AI智能合并工具。

## 快速开始

```bash
# 全局链接命令（在项目目录执行）
npm link

# 启动可视化平台并自动打开浏览器
wt-ui start

# 也可在启动时直接加载指定项目或 .code-workspace 文件
wt-ui start E:\path\to\project
wt-ui start E:\path\to\workspace.code-workspace

# 检查 Worktrunk 与 Git 环境
wt-ui doctor
```

## 核心功能

- **项目与工作区管理**：支持添加单个 Git 项目文件夹，或导入 VS Code / Cursor 的 `.code-workspace` 文件（自动解析相对路径并识别其中的 Git 仓库）。
- **工具分类与自由配置**：
  - **命令行工具 (CLI)**：`Claude Code`、`Codex CLI`、`OpenCode`、`Gemini CLI`、`CodeBuddy CLI`、`Qwen Code`、`Kimi CLI`、`Trae CLI`，在独立终端窗口中进入工作树并启动（对应 `wt switch -c <branch> -x claude`）。
  - **图形界面工具 (GUI)**：`Cursor`、`VS Code`、`Windsurf`、`Qoder`、`Trae`、`CodeBuddy`、`Antigravity IDE`、`Kiro`，使用 `--no-cd` 打开工作树（对应 `wt switch --no-cd -x cursor -- .`）。
  - 支持在设置中配置界面语言、明暗主题、首选终端、开机自启、AI 接口及自定义 CLI/GUI 工具，并为各个工作树记忆上次使用的工具。
- **工作树状态总览**：基于 `wt list --format=json --branches` 实时展示分支状态、未提交变更、与默认分支的提交/代码行差异、合并状态、冲突检测与可视化/AI 冲突解决。
- **一键合并与清理**：调用 `wt merge <target> --branch <branch> --format=json -y` 完成 Squash、Rebase、快进合并与工作树清理，并支持可选参数（`--no-squash`、`--no-commit`、`--no-rebase`、`--no-ff`、`--no-remove`、`--no-hooks`）及合并后自动推送。

## 环境要求

- Node.js >= 20
- Worktrunk (`wt`)
- Git >= 2.43.0（Worktrunk 最低要求）
