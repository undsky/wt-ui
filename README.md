<h1 align="center">Git Worktree Visual Platform</h1>

<div align="center">
  <img src="https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794812339725-70e78178-de74-4aeb-a471-1c18aa103d9c.png" alt="wtUI" width="120" />
  <p>Parallel development with multiple AI tools, one-click merge, and AI-powered conflict resolution.</p>
  <p>English | <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="#quick-start">Quick Start</a> ·
    <a href="#screenshots">Screenshots</a> ·
    <a href="#cli-commands">CLI Commands</a> ·
    <a href="#key-features">Key Features</a> ·
    <a href="#-community">Community</a> ·
    <a href="#-license">License</a>
  </p>
</div>

## Quick Start

```bash
# Install globally
npm i @undsky/wtui -g

# Start the visual platform and open it in your browser
wtui start
```

## Screenshots

![Main Interface (Light Theme / Chinese)](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806498647-69869e15-2d1b-4893-9e65-b2b43ea1391c.png)

![Merge Conflict Resolution (Visual & AI-Assisted)](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806504662-e805bcf4-2d8b-4397-bdaa-c6080980b6fe.jpg)

![Main Interface (Dark Theme / English)](https://fastly.jsdelivr.net/gh/undsky/doudou-cdn-stg@main/2026/11/16/1794806507456-fee7fb12-8d61-43ba-8dcd-294117ea4eed.png)

## CLI Commands

```text
Usage:
  wtui start [path] [options]   Start the visual web platform and open the browser
  wtui doctor [--wt-bin <path>] Check Worktrunk (wt) and Git environment
  wtui --help                   Show help information
  wtui --version                Show version number

Options (start):
  -p, --port <port>              Specify port (default: 4173)
  -H, --host <host>              Listen address (default: 127.0.0.1)
      --wt-bin <path>            Specify Worktrunk wt executable path
      --no-open                  Do not open browser automatically after startup
      --no-auto-install          Do not auto-install wt if not detected
```

## Key Features

- **Project & Workspace Management**: Add individual Git project folders or `.code-workspace` workspaces.
- **Parallel Development with Multiple AI Tools**:
  - **Worktree Isolation & Status Overview**: Create worktrees and launch tools in one click, with real-time branch status, diff tracking, conflict risk detection, and per-branch pull/push.
  - **Works with Any CLI / GUI Tool**: Built-in support for popular AI coding CLIs and graphical IDEs, launchable in standalone terminals or editors with custom extensions.
- **One-Click Merge & AI Conflict Resolution**:
  - **One-Click Merge & Cleanup**: Supports Squash, Rebase, Fast-Forward merges, and automatic cleanup & push with configurable merge options.
  - **Visual Conflict Resolution**: Automatically opens a conflict panel on merge conflicts, supporting hunk-by-hunk comparison, direct source editing, staging, and aborting.
  - **AI One-Click Merge & Commit**: Configure an OpenAI or Anthropic-compatible API to automatically analyze and resolve conflicts and complete the merge commit.

## 💬 Community

|                WeChat Official Account                |                   QQ Group                    |
| :---------------------------------------------------: | :-------------------------------------------: |
| ![WeChat Official Account](https://cdn.undsky.com/img/gh.jpg) | ![QQ Group](https://cdn.undsky.com/img/qqqun.jpg) |

---

## 📄 License

This project is licensed under [CC BY-NC 4.0](LICENSE).

- Free to use for personal, educational, research, and non-commercial purposes.
- Attribution is required when publicly distributing derivative works.
- Commercial use requires separate authorization; please contact the author.
