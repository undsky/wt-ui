import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { formatCommand, parseWtJson, runWt } from './wt-resolver.js';

export const BUILTIN_TOOLS = [
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'cli',
    command: 'claude',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 Claude Code CLI',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    kind: 'cli',
    command: 'codex',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 OpenAI Codex CLI',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'cli',
    command: 'opencode',
    args: [],
    supportsPrompt: false,
    description: '在工作树中启动 OpenCode CLI',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    kind: 'cli',
    command: 'gemini',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 Gemini CLI',
  },
  {
    id: 'codebuddy-cli',
    name: 'CodeBuddy CLI',
    kind: 'cli',
    command: 'codebuddy',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 CodeBuddy Code CLI',
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    kind: 'cli',
    command: 'qwen',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 Qwen Code CLI',
  },
  {
    id: 'kimi-cli',
    name: 'Kimi CLI',
    kind: 'cli',
    command: 'kimi',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 Kimi CLI',
  },
  {
    id: 'trae-cli',
    name: 'Trae CLI',
    kind: 'cli',
    command: 'traecli',
    args: [],
    supportsPrompt: true,
    description: '在工作树中启动 Trae CLI',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'gui',
    command: 'cursor',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Cursor 打开工作树',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    kind: 'gui',
    command: 'code',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 VS Code 打开工作树',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'gui',
    command: 'windsurf',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Windsurf 打开工作树',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    kind: 'gui',
    command: 'qoder',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Qoder 打开工作树',
  },
  {
    id: 'trae',
    name: 'Trae',
    kind: 'gui',
    command: 'trae',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Trae 国际版打开工作树',
  },
  {
    id: 'trae-zh',
    name: 'Trae zh',
    kind: 'gui',
    command: 'trae-cn',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Trae 国内版打开工作树',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    kind: 'gui',
    command: 'buddy',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 CodeBuddy IDE 国际版打开工作树',
  },
  {
    id: 'codebuddy-zh',
    name: 'CodeBuddy zh',
    kind: 'gui',
    command: 'buddy-cn',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 CodeBuddy IDE 国内版打开工作树',
  },
  {
    id: 'antigravity',
    name: 'Antigravity IDE',
    kind: 'gui',
    command: 'antigravity-ide',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Antigravity IDE 打开工作树',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    kind: 'gui',
    command: 'kiro',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Kiro IDE 打开工作树',
  },
  {
    id: 'zed',
    name: 'Zed',
    kind: 'gui',
    command: 'zed',
    args: ['.'],
    supportsPrompt: false,
    description: '使用 Zed 编辑器打开工作树',
  },
];

export function getAllTools(customTools = []) {
  const overrideMap = new Map(customTools.map((t) => [t.id, t]));
  const mergedBuiltins = BUILTIN_TOOLS.map((b) => overrideMap.get(b.id) || b);
  const builtinIds = new Set(BUILTIN_TOOLS.map((b) => b.id));
  const extras = customTools.filter((t) => !builtinIds.has(t.id));
  return [...mergedBuiltins, ...extras];
}

export function findToolById(toolId, customTools = []) {
  return getAllTools(customTools).find((t) => t.id === toolId) || null;
}

/**
 * Build human-readable `wt switch ...` command preview matching Worktrunk docs.
 */
export function buildDisplaySwitchCommand({ branch, create, base, tool, prompt }) {
  const args = ['switch'];
  if (create) args.push('-c');
  args.push(branch);
  if (base) {
    args.push('--base', base);
  }
  if (tool && tool.kind === 'gui' && tool.command) {
    args.push('--no-cd', '-x', tool.command);
    const toolArgs = [...(tool.args || [])];
    if (toolArgs.length > 0) {
      args.push('--', ...toolArgs);
    }
  } else if (tool && tool.kind === 'cli' && tool.command) {
    args.push('-x', tool.command);
    const extra = [...(tool.args || [])];
    if (prompt && tool.supportsPrompt) {
      extra.push(prompt);
    }
    if (extra.length > 0) {
      args.push('--', ...extra);
    }
  }
  return formatCommand('wt', args);
}

/**
 * Quote an argument for a line inside a Windows batch (.cmd) file.
 * Metacharacters are neutralised by double quotes; `%` is doubled because batch
 * files expand `%VAR%` even inside quotes. Newlines are not allowed in one command.
 * @param {string} arg
 */
export function quoteCmdArg(arg) {
  let s = String(arg ?? '').replace(/[\r\n]+/g, ' ');
  s = s.replace(/%/g, '%%');
  if (!s) return '""';
  if (/[\s"&|<>^(),;=!%]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Quote an argument safely for POSIX shells (macOS / Linux).
 */
export function quotePosixArg(arg) {
  const s = String(arg ?? '');
  if (s.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Spawn a detached process without ever crashing the server: a missing binary
 * emits an async 'error' event which would otherwise be unhandled.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export function spawnDetached(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', ...options });
    } catch (err) {
      resolvePromise({ ok: false, error: err?.message || String(err) });
      return;
    }
    child.once('error', (err) => {
      resolvePromise({ ok: false, error: `${command}: ${err?.message || String(err)}` });
    });
    child.once('spawn', () => {
      child.unref();
      resolvePromise({ ok: true });
    });
  });
}

function isOnPath(bin) {
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  return pathDirs.some((dir) => existsSync(join(dir, bin)));
}

/**
 * Linux terminal emulators and how each expects an argv vector to be passed.
 */
const LINUX_TERMINALS = [
  { bin: 'gnome-terminal', build: (argv) => ['--', ...argv] },
  { bin: 'konsole', build: (argv) => ['-e', ...argv] },
  { bin: 'xfce4-terminal', build: (argv) => ['-x', ...argv] },
  { bin: 'mate-terminal', build: (argv) => ['-x', ...argv] },
  { bin: 'tilix', build: (argv) => ['-e', argv.map(quotePosixArg).join(' ')] },
  { bin: 'kitty', build: (argv) => [...argv] },
  { bin: 'alacritty', build: (argv) => ['-e', ...argv] },
  { bin: 'wezterm', build: (argv) => ['start', '--', ...argv] },
  { bin: 'foot', build: (argv) => [...argv] },
  { bin: 'x-terminal-emulator', build: (argv) => ['-e', ...argv] },
  { bin: 'xterm', build: (argv) => ['-e', ...argv] },
];

/**
 * Pick an available terminal emulator on Linux, or null when none is installed.
 */
export function findLinuxTerminal() {
  return LINUX_TERMINALS.find((t) => isOnPath(t.bin)) || null;
}

/**
 * Build the argv (without terminal wrapper) for the command to run in the new terminal.
 */
function buildLaunchArgv({ wtBin, repoPath, branch, tool, extraArgs }) {
  if (wtBin && repoPath && branch) {
    return [wtBin, '-C', repoPath, 'switch', branch, '-y', '-x', tool.command, ...(extraArgs.length ? ['--', ...extraArgs] : [])];
  }
  return [tool.command, ...extraArgs];
}

function launchScriptDir() {
  const dir = join(tmpdir(), 'wt-ui-launch');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Spawn an interactive CLI tool inside a new terminal window at `worktreePath`.
 * If `wtBin` and `repoPath` and `branch` are provided, runs `wt -C <repoPath> switch <branch> -x <cmd>`
 * so Worktrunk hooks and environment are preserved.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function spawnInNewTerminal({ wtBin, repoPath, branch, tool, prompt, worktreePath }) {
  const extraArgs = [...(tool.args || [])];
  if (prompt && tool.supportsPrompt) {
    extraArgs.push(prompt);
  }
  const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : repoPath;
  const argv = tool.id === 'terminal' ? null : buildLaunchArgv({ wtBin, repoPath, branch, tool, extraArgs });

  if (process.platform === 'win32') {
    // Write a temporary .cmd script instead of nesting quotes through two cmd.exe
    // parsers; this stays correct for paths with spaces, CJK characters and
    // prompts containing & | % ^ " etc.
    const lines = ['@echo off', 'chcp 65001 >nul'];
    if (cwd) lines.push(`cd /d ${quoteCmdArg(cwd)}`);
    if (argv) lines.push(argv.map(quoteCmdArg).join(' '));
    lines.push('(goto) 2>nul & del "%~f0"');
    const scriptPath = join(launchScriptDir(), `launch-${randomUUID().slice(0, 8)}.cmd`);
    writeFileSync(scriptPath, `${lines.join('\r\n')}\r\n`, 'utf8');

    const title = `wt-ui ${branch || tool.name}`.replace(/["%^&|<>]/g, '');
    // /s strips only the outermost quotes, leaving the inner command line verbatim.
    const cmdLine = `/d /s /c "start "${title}" cmd.exe /k "${scriptPath}""`;
    return spawnDetached('cmd.exe', [cmdLine], {
      cwd: cwd || undefined,
      windowsVerbatimArguments: true,
      windowsHide: false,
    });
  }

  const shellLine = [
    cwd ? `cd ${quotePosixArg(cwd)}` : null,
    argv ? argv.map(quotePosixArg).join(' ') : null,
  ]
    .filter(Boolean)
    .join(' && ');

  if (process.platform === 'darwin') {
    // AppleScript string literal: escape backslashes and quotes; drop control chars.
    const asString = `"${shellLine.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return spawnDetached('osascript', [
      '-e',
      'tell application "Terminal"',
      '-e',
      'activate',
      '-e',
      `do script ${asString}`,
      '-e',
      'end tell',
    ]);
  }

  // Linux
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { ok: false, error: '未检测到图形桌面 (DISPLAY / WAYLAND_DISPLAY)，无法打开新终端窗口' };
  }
  const term = findLinuxTerminal();
  if (!term) {
    return { ok: false, error: '未找到可用的终端模拟器 (gnome-terminal / konsole / xfce4-terminal / kitty / alacritty / xterm ...)' };
  }
  // Keep the window open with an interactive shell after the tool exits.
  const userShell = process.env.SHELL || '/bin/sh';
  const wrapped = ['sh', '-c', `${shellLine || ':'}; exec ${quotePosixArg(userShell)}`];
  return spawnDetached(term.bin, term.build(wrapped), { cwd: cwd || undefined });
}

/**
 * Execute `wt switch` (creating or switching to a worktree) and optionally launch a CLI or GUI tool.
 */
export async function switchAndOpenWorktree({
  wtBin,
  repoPath,
  branch,
  create = false,
  clobber = false,
  base = '',
  tool,
  prompt = '',
}) {
  const displayCommand = buildDisplaySwitchCommand({ branch, create, base, tool, prompt });

  // Always run `wt switch` with --no-cd -y --format=json first so we get immediate,
  // structured validation & worktree path even for CLI tools.
  const baseArgs = ['switch'];
  if (create) baseArgs.push('-c');
  if (clobber) baseArgs.push('--clobber');
  baseArgs.push(branch);
  if (base) baseArgs.push('--base', base);
  baseArgs.push('--no-cd', '-y', '--format=json');

  // For GUI tools, we can pass `-x` directly to `wt switch` on the same invocation.
  const isGui = tool && tool.kind === 'gui' && tool.command;
  if (isGui) {
    const toolArgs = [...(tool.args || [])];
    if (process.platform === 'win32' && tool.command !== 'explorer.exe') {
      baseArgs.push('-x', 'cmd.exe', '--', '/C', tool.command, ...toolArgs);
    } else {
      baseArgs.push('-x', tool.command);
      if (toolArgs.length > 0) {
        baseArgs.push('--', ...toolArgs);
      }
    }
  }

  const result = await runWt(wtBin, repoPath, baseArgs);
  const json = parseWtJson(result.stdout);

  if (!result.ok && !json) {
    return {
      ok: false,
      command: displayCommand,
      executedCommand: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      data: null,
    };
  }

  const worktreePath = json?.path || json?.worktree?.path || repoPath;

  // For CLI tools, spawn a new interactive terminal window in the worktree.
  let launch = null;
  if (tool && tool.kind === 'cli' && tool.command) {
    launch = await spawnInNewTerminal({
      wtBin,
      repoPath,
      branch,
      tool,
      prompt,
      worktreePath,
    });
  }

  return {
    ok: result.ok,
    command: displayCommand,
    executedCommand: result.command,
    stdout: result.stdout,
    stderr: launch && !launch.ok ? [result.stderr, `⚠ 无法打开终端: ${launch.error}`].filter(Boolean).join('\n') : result.stderr,
    data: json,
    worktreePath,
    launch,
  };
}

/**
 * Open the browser to a local URL across Windows, macOS, and Linux.
 * Never throws; resolves to `{ ok, error? }`.
 * @param {string} url
 */
export async function openBrowser(url) {
  if (process.platform === 'win32') {
    // `start` treats the first quoted argument as the window title, hence the empty "".
    return spawnDetached('cmd.exe', ['/d', '/c', 'start', '""', url.replace(/&/g, '^&')], {
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }
  if (process.platform === 'darwin') {
    return spawnDetached('open', [url]);
  }
  for (const opener of ['xdg-open', 'gio', 'sensible-browser', 'wslview']) {
    if (!isOnPath(opener)) continue;
    const args = opener === 'gio' ? ['open', url] : [url];
    const res = await spawnDetached(opener, args);
    if (res.ok) return res;
  }
  return { ok: false, error: '未找到可用的浏览器打开命令 (xdg-open / gio / wslview)' };
}

