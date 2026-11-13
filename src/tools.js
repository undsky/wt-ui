import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
 * Quote an argument for Windows cmd.exe.
 * @param {string} arg
 */
function quoteCmdArg(arg) {
  if (!arg) return '""';
  if (/[\s"&|<>^()%]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * Quote an argument safely for POSIX shells (macOS / Linux).
 */
function quotePosixArg(arg) {
  const s = String(arg ?? '');
  if (s.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pick an available terminal emulator on Linux.
 */
function findLinuxTerminal() {
  const candidates = [
    { bin: 'x-terminal-emulator', argsPrefix: ['-e'] },
    { bin: 'gnome-terminal', argsPrefix: ['--'] },
    { bin: 'konsole', argsPrefix: ['-e'] },
    { bin: 'xfce4-terminal', argsPrefix: ['-e'] },
    { bin: 'kitty', argsPrefix: [] },
    { bin: 'alacritty', argsPrefix: ['-e'] },
    { bin: 'xterm', argsPrefix: ['-e'] },
  ];
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
  for (const cand of candidates) {
    if (pathDirs.some((dir) => existsSync(`${dir}/${cand.bin}`))) {
      return cand;
    }
  }
  return candidates[0];
}

/**
 * Spawn an interactive CLI tool inside a new terminal window at `worktreePath`.
 * If `wtBin` and `repoPath` and `branch` are provided, runs `wt -C <repoPath> switch <branch> -x <cmd>`
 * so Worktrunk hooks and environment are preserved.
 */
export function spawnInNewTerminal({ wtBin, repoPath, branch, tool, prompt, worktreePath }) {
  const extraArgs = [...(tool.args || [])];
  if (prompt && tool.supportsPrompt) {
    extraArgs.push(prompt);
  }

  if (process.platform === 'win32') {
    let innerCommand;
    if (tool.id === 'terminal') {
      innerCommand = `cd /d ${quoteCmdArg(worktreePath)}`;
    } else if (wtBin && repoPath && branch) {
      const wtArgs = ['-C', repoPath, 'switch', branch, '-y', '-x', tool.command];
      if (extraArgs.length > 0) {
        wtArgs.push('--', ...extraArgs);
      }
      innerCommand = [quoteCmdArg(wtBin), ...wtArgs.map(quoteCmdArg)].join(' ');
    } else {
      innerCommand = [quoteCmdArg(tool.command), ...extraArgs.map(quoteCmdArg)].join(' ');
    }

    const title = `wt-ui: ${branch || tool.name}`;
    const child = spawn('cmd.exe', ['/c', 'start', title, 'cmd.exe', '/k', innerCommand], {
      cwd: worktreePath && existsSync(worktreePath) ? worktreePath : repoPath,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const shellLine =
      tool.id === 'terminal'
        ? `cd ${quotePosixArg(worktreePath)}`
        : wtBin && repoPath && branch
          ? [wtBin, '-C', repoPath, 'switch', branch, '-y', '-x', tool.command, ...(extraArgs.length ? ['--', ...extraArgs] : [])]
              .map(quotePosixArg)
              .join(' ')
          : [tool.command, ...extraArgs].map(quotePosixArg).join(' ');
    const script = `tell application "Terminal" to do script ${JSON.stringify(shellLine)}`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  // Linux
  const term = findLinuxTerminal();
  const cwd = worktreePath && existsSync(worktreePath) ? worktreePath : repoPath;
  let cmdArgs;
  if (tool.id === 'terminal') {
    cmdArgs = [process.env.SHELL || 'bash'];
  } else if (wtBin && repoPath && branch) {
    cmdArgs = [wtBin, '-C', repoPath, 'switch', branch, '-y', '-x', tool.command, ...(extraArgs.length ? ['--', ...extraArgs] : [])];
  } else {
    cmdArgs = [tool.command, ...extraArgs];
  }
  const child = spawn(term.bin, [...term.argsPrefix, ...cmdArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

/**
 * Execute `wt switch` (creating or switching to a worktree) and optionally launch a CLI or GUI tool.
 */
export async function switchAndOpenWorktree({
  wtBin,
  repoPath,
  branch,
  create = false,
  base = '',
  tool,
  prompt = '',
}) {
  const displayCommand = buildDisplaySwitchCommand({ branch, create, base, tool, prompt });

  // Always run `wt switch` with --no-cd -y --format=json first so we get immediate,
  // structured validation & worktree path even for CLI tools.
  const baseArgs = ['switch'];
  if (create) baseArgs.push('-c');
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
  if (tool && tool.kind === 'cli' && tool.command) {
    spawnInNewTerminal({
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
    stderr: result.stderr,
    data: json,
    worktreePath,
  };
}

/**
 * Open the browser to a local URL across Windows, macOS, and Linux.
 * @param {string} url
 */
export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch {
    // Non-fatal if browser cannot be opened automatically
  }
}

