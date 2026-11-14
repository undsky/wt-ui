import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

function isOnPath(bin, platform = process.platform) {
  const pathDirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts =
    platform === 'win32' && !/\.[a-z0-9]+$/i.test(bin)
      ? ['', '.exe', '.cmd', '.bat']
      : [''];
  return pathDirs.some((dir) => exts.some((ext) => existsSync(join(dir, `${bin}${ext}`))));
}

const MACOS_GUI_APP_BUNDLES = {
  cursor: 'Cursor.app',
  code: 'Visual Studio Code.app',
  windsurf: 'Windsurf.app',
  qoder: 'Qoder.app',
  trae: 'Trae.app',
  'trae-cn': 'Trae CN.app',
  buddy: 'CodeBuddy.app',
  'buddy-cn': 'CodeBuddy CN.app',
  'antigravity-ide': 'Antigravity.app',
  kiro: 'Kiro.app',
  zed: 'Zed.app',
};

function hasMacApp(appBundleName) {
  return (
    existsSync(join('/Applications', appBundleName)) ||
    existsSync(join(homedir(), 'Applications', appBundleName))
  );
}

function findWindowsGitBash() {
  if (isOnPath('git-bash.exe', 'win32')) return 'git-bash.exe';
  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'git-bash.exe'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'git-bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'git-bash.exe'),
    'C:\\Program Files\\Git\\git-bash.exe',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Run a short-lived launcher command (such as `osascript` or `open -a` on macOS)
 * and resolve `{ ok: true }` only if it exits 0 (or stays running past timeout).
 */
function runLauncherCommand(command, args, options = {}, timeoutMs = 4000) {
  return new Promise((resolvePromise) => {
    let child;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolvePromise(res);
    };
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        ...options,
      });
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err) });
      return;
    }
    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    const timer = setTimeout(() => {
      try {
        child.unref();
      } catch {
        // ignore
      }
      finish({ ok: true });
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `${command}: ${err?.message || String(err)}` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: stderr.trim() || `${command} exited with code ${code}` });
      }
    });
  });
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
 * Return available terminal options for the current platform.
 */
export function getSupportedTerminals(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      { id: 'iterm2', name: 'iTerm2' },
      { id: 'terminal', name: 'Terminal' },
      { id: 'warp', name: 'Warp' },
      { id: 'ghostty', name: 'Ghostty' },
      { id: 'kitty', name: 'kitty' },
      { id: 'alacritty', name: 'Alacritty' },
      { id: 'wezterm', name: 'WezTerm' },
    ];
  }
  if (platform === 'win32') {
    return [
      { id: 'wt', name: 'Windows Terminal' },
      { id: 'powershell', name: 'Windows PowerShell' },
      { id: 'pwsh', name: 'PowerShell 7 (pwsh)' },
      { id: 'cmd', name: 'Command Prompt (cmd.exe)' },
      { id: 'git-bash', name: 'Git Bash' },
    ];
  }
  return [
    { id: 'auto', name: 'Auto (自动检测)' },
    { id: 'gnome-terminal', name: 'GNOME Terminal' },
    { id: 'konsole', name: 'Konsole' },
    { id: 'xfce4-terminal', name: 'XFCE Terminal' },
    { id: 'mate-terminal', name: 'MATE Terminal' },
    { id: 'tilix', name: 'Tilix' },
    { id: 'kitty', name: 'kitty' },
    { id: 'alacritty', name: 'Alacritty' },
    { id: 'wezterm', name: 'WezTerm' },
    { id: 'foot', name: 'foot' },
    { id: 'x-terminal-emulator', name: 'x-terminal-emulator' },
    { id: 'xterm', name: 'XTerm' },
  ];
}

/**
 * Pick an available terminal emulator on Linux, or null when none is installed.
 */
export function findLinuxTerminal(preferredTerminal = '') {
  if (preferredTerminal && preferredTerminal !== 'auto') {
    const chosen = LINUX_TERMINALS.find((t) => t.bin === preferredTerminal && isOnPath(t.bin, 'linux'));
    if (chosen) return chosen;
  }
  return LINUX_TERMINALS.find((t) => isOnPath(t.bin, 'linux')) || null;
}

/**
 * Build the argv (without terminal wrapper) for the command to run in the new terminal.
 */
function buildLaunchArgv({ wtBin, repoPath, branch, tool, extraArgs }) {
  if (wtBin && repoPath && branch) {
    return [
      wtBin,
      '-C',
      repoPath,
      'switch',
      branch,
      '--no-cd',
      '-y',
      '-x',
      tool.command,
      ...(extraArgs.length ? ['--', ...extraArgs] : []),
    ];
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
export async function spawnInNewTerminal({
  wtBin,
  repoPath,
  branch,
  tool,
  prompt,
  worktreePath,
  preferredTerminal = '',
}) {
  const extraArgs = [...(tool.args || [])];
  if (prompt && tool.supportsPrompt) {
    extraArgs.push(prompt);
  }
  const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : repoPath;
  const argv = tool.id === 'terminal' ? null : buildLaunchArgv({ wtBin, repoPath, branch, tool, extraArgs });
  const pref = String(preferredTerminal || '').trim().toLowerCase();

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
    if (pref === 'wt') {
      const wtRes = await spawnDetached(
        'wt.exe',
        [...(cwd ? ['-d', cwd] : []), 'cmd.exe', '/k', scriptPath],
        { cwd: cwd || undefined, windowsHide: false }
      );
      if (wtRes.ok) return wtRes;
    } else if (pref === 'powershell' || pref === 'pwsh') {
      const psBin = pref === 'pwsh' && isOnPath('pwsh.exe', 'win32') ? 'pwsh.exe' : 'powershell.exe';
      const psQuote = (s) => `'${String(s ?? '').replace(/'/g, "''")}'`;
      const psLines = [
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        cwd ? `Set-Location -LiteralPath ${psQuote(cwd)}` : '',
        argv ? `& ${argv.map(psQuote).join(' ')}` : '',
        'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
      ].filter(Boolean);
      const ps1Path = join(launchScriptDir(), `launch-${randomUUID().slice(0, 8)}.ps1`);
      // UTF-8 with BOM ensures Windows PowerShell 5.1 reads CJK paths accurately
      writeFileSync(ps1Path, `\uFEFF${psLines.join('\r\n')}\r\n`, 'utf8');
      const cmdLine = `/d /s /c "start "${title}" ${psBin} -NoExit -ExecutionPolicy Bypass -File "${ps1Path}""`;
      const psRes = await spawnDetached('cmd.exe', [cmdLine], {
        cwd: cwd || undefined,
        windowsVerbatimArguments: true,
        windowsHide: false,
      });
      if (psRes.ok) return psRes;
    } else if (pref === 'git-bash') {
      const gitBashBin = findWindowsGitBash();
      if (gitBashBin) {
        const shPath = join(launchScriptDir(), `launch-${randomUUID().slice(0, 8)}.sh`);
        const shLines = [
          '#!/usr/bin/env bash',
          'rm -f "$0"',
          cwd ? `cd ${quotePosixArg(cwd)}` : '',
          argv ? argv.map(quotePosixArg).join(' ') : '',
          'exec "${SHELL:-/bin/bash}" -l',
        ].filter(Boolean);
        writeFileSync(shPath, `${shLines.join('\n')}\n`, 'utf8');
        const gbRes = await spawnDetached(
          gitBashBin,
          [...(cwd ? [`--cd=${cwd}`] : []), '-c', `bash ${quotePosixArg(shPath.replace(/\\/g, '/'))}`],
          { cwd: cwd || undefined, windowsHide: false }
        );
        if (gbRes.ok) return gbRes;
      }
    }

    // Default / fallback on Windows: cmd.exe
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
    const cleanLine = shellLine.replace(/[\u0000-\u001f\u007f]/g, ' ');
    const asString = `"${cleanLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const userShell = process.env.SHELL || '/bin/zsh';

    if ((pref === 'iterm2' || pref === 'iterm') && hasMacApp('iTerm.app')) {
      const itermRes = await runLauncherCommand('osascript', [
        '-e',
        'tell application id "com.googlecode.iterm2"',
        '-e',
        'activate',
        '-e',
        'set newWin to (create window with default profile)',
        '-e',
        'tell current session of newWin',
        '-e',
        `write text ${asString}`,
        '-e',
        'end tell',
        '-e',
        'end tell',
      ]);
      if (itermRes.ok) return itermRes;
    } else if (pref === 'warp' && hasMacApp('Warp.app')) {
      const scriptPath = join(launchScriptDir(), `launch-${randomUUID().slice(0, 8)}.command`);
      const scriptLines = [
        '#!/bin/sh',
        'rm -f "$0"',
        cwd ? `cd ${quotePosixArg(cwd)}` : '',
        argv ? argv.map(quotePosixArg).join(' ') : '',
        `exec ${quotePosixArg(userShell)} -l`,
      ].filter(Boolean);
      writeFileSync(scriptPath, `${scriptLines.join('\n')}\n`, 'utf8');
      chmodSync(scriptPath, 0o755);
      const warpRes = await runLauncherCommand('open', ['-a', 'Warp', scriptPath]);
      if (warpRes.ok) return warpRes;
    } else if (pref === 'ghostty' && hasMacApp('Ghostty.app')) {
      const ghosttyRes = await runLauncherCommand('open', [
        '-na',
        'Ghostty.app',
        '--args',
        ...(cwd ? [`--working-directory=${cwd}`] : []),
        '-e',
        userShell,
        '-lic',
        `${cleanLine || ':'}; exec ${quotePosixArg(userShell)} -l`,
      ]);
      if (ghosttyRes.ok) return ghosttyRes;
    } else if (pref === 'kitty' && hasMacApp('kitty.app')) {
      const kittyRes = await runLauncherCommand('open', [
        '-na',
        'kitty.app',
        '--args',
        ...(cwd ? ['--directory', cwd] : []),
        userShell,
        '-lic',
        `${cleanLine || ':'}; exec ${quotePosixArg(userShell)} -l`,
      ]);
      if (kittyRes.ok) return kittyRes;
    } else if (pref === 'alacritty' && hasMacApp('Alacritty.app')) {
      const alacrittyRes = await runLauncherCommand('open', [
        '-na',
        'Alacritty.app',
        '--args',
        ...(cwd ? ['--working-directory', cwd] : []),
        '-e',
        userShell,
        '-lic',
        `${cleanLine || ':'}; exec ${quotePosixArg(userShell)} -l`,
      ]);
      if (alacrittyRes.ok) return alacrittyRes;
    } else if (pref === 'wezterm' && hasMacApp('WezTerm.app')) {
      const wezRes = await runLauncherCommand('open', [
        '-na',
        'WezTerm.app',
        '--args',
        'start',
        ...(cwd ? ['--cwd', cwd] : []),
        '--',
        userShell,
        '-lic',
        `${cleanLine || ':'}; exec ${quotePosixArg(userShell)} -l`,
      ]);
      if (wezRes.ok) return wezRes;
    }

    // Default / fallback on macOS: Terminal.app
    return runLauncherCommand('osascript', [
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

  // Linux (including WSL support)
  const userShell = process.env.SHELL || '/bin/sh';
  const hasLinuxGui = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (hasLinuxGui) {
    const term = findLinuxTerminal(pref);
    if (term) {
      // Keep the window open with an interactive shell after the tool exits.
      const wrapped = ['sh', '-c', `${shellLine || ':'}; exec ${quotePosixArg(userShell)}`];
      return spawnDetached(term.bin, term.build(wrapped), { cwd: cwd || undefined });
    }
  }

  // WSL fallback: if running inside Windows Subsystem for Linux and wt.exe or cmd.exe is reachable
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    const wrappedCmd = `${shellLine || ':'}; exec ${quotePosixArg(userShell)}`;
    if (isOnPath('wt.exe', 'linux')) {
      return spawnDetached('wt.exe', ['wsl.exe', '--cd', cwd || '~', '--', 'sh', '-lic', wrappedCmd], {
        cwd: cwd || undefined,
      });
    }
    if (isOnPath('cmd.exe', 'linux')) {
      return spawnDetached('cmd.exe', ['/c', 'start', 'wsl.exe', '--cd', cwd || '~', '--', 'sh', '-lic', wrappedCmd], {
        cwd: cwd || undefined,
      });
    }
  }

  if (!hasLinuxGui) {
    return { ok: false, error: '未检测到图形桌面 (DISPLAY / WAYLAND_DISPLAY)，无法打开新终端窗口' };
  }
  return {
    ok: false,
    error:
      '未找到可用的终端模拟器 (gnome-terminal / konsole / xfce4-terminal / mate-terminal / tilix / kitty / alacritty / wezterm / foot / xterm)',
  };
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
  preferredTerminal = '',
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
    const macAppBundle = MACOS_GUI_APP_BUNDLES[tool.command];
    if (process.platform === 'win32' && tool.command !== 'explorer.exe') {
      baseArgs.push('-x', 'cmd.exe', '--', '/C', tool.command, ...toolArgs);
    } else if (
      process.platform === 'darwin' &&
      !isOnPath(tool.command, 'darwin') &&
      macAppBundle &&
      hasMacApp(macAppBundle)
    ) {
      baseArgs.push('-x', 'open', '--', '-a', macAppBundle, ...(toolArgs.length > 0 ? toolArgs : ['.']));
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
      preferredTerminal,
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

