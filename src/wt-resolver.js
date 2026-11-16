import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { getManagedWtBinPath } from './wt-installer.js';

const execFileAsync = promisify(execFile);

const WINDOWS_TERMINAL_PATTERN = /[/\\]WindowsApps[/\\]wt\.exe$/i;
const MIN_GIT_VERSION = [2, 43, 0];

function execWtRaw(binPath, args, execOptions) {
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(binPath)) {
    return execFileAsync('cmd.exe', ['/d', '/c', binPath, ...args], execOptions);
  }
  return execFileAsync(binPath, args, execOptions);
}

/**
 * Parse a semantic-ish version tuple like "2.37.0" from a string.
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseVersionTuple(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two [major, minor, patch] tuples. Returns -1, 0, or 1.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Check if a candidate binary is Worktrunk's `wt` (and not Windows Terminal).
 * @param {string} binPath
 * @returns {Promise<{ ok: boolean, version: string | null }>}
 */
async function probeWtBinary(binPath) {
  if (!binPath) return { ok: false, version: null };
  if (
    process.platform === 'win32' &&
    (WINDOWS_TERMINAL_PATTERN.test(binPath) || /^wt(?:\.exe)?$/i.test(binPath))
  ) {
    return { ok: false, version: null };
  }
  try {
    const { stdout, stderr } = await execWtRaw(binPath, ['--version'], {
      timeout: 4000,
      windowsHide: true,
    });
    const combined = `${stdout || ''}\n${stderr || ''}`.trim();
    if (/worktrunk|\bwt\s+v?\d+\.\d+/i.test(combined)) {
      const firstLine = combined.split(/\r?\n/)[0].trim();
      return { ok: true, version: firstLine };
    }
    return { ok: false, version: null };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * Collect candidate `wt` binary paths on the current platform.
 * @param {string | undefined} explicitBin
 * @returns {Promise<string[]>}
 */
async function collectWtCandidates(explicitBin) {
  const candidates = [];
  const add = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  if (explicitBin) add(explicitBin);
  if (process.env.WT_BIN) add(process.env.WT_BIN);
  const managedBin = getManagedWtBinPath();
  if (existsSync(managedBin)) add(managedBin);

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const names = ['wt', 'git-wt'];
  const locatedGroups = await Promise.all(
    names.map(async (name) => {
      const argVariants = process.platform === 'win32' ? [[name]] : [['-a', name], [name]];
      for (const locatorArgs of argVariants) {
        try {
          const { stdout } = await execFileAsync(locator, locatorArgs, {
            timeout: 3000,
            windowsHide: true,
          });
          return stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        } catch {
          // Try fallback args or ignore when binary is not on PATH
        }
      }
      return [];
    })
  );
  for (const group of locatedGroups) {
    for (const item of group) add(item);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const wingetRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    const wingetLink = join(localAppData, 'Microsoft', 'WinGet', 'Links', 'wt.exe');
    if (existsSync(wingetLink)) add(wingetLink);
    if (existsSync(wingetRoot)) {
      try {
        for (const entry of readdirSync(wingetRoot)) {
          if (!entry.toLowerCase().startsWith('max-sixty.worktrunk')) continue;
          const pkgDir = join(wingetRoot, entry);
          const directExe = join(pkgDir, 'wt.exe');
          if (existsSync(directExe)) add(directExe);
          // WinGet archives sometimes nest wt.exe one subdirectory deeper
          try {
            for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
              if (!sub.isDirectory()) continue;
              const nestedExe = join(pkgDir, sub.name, 'wt.exe');
              if (existsSync(nestedExe)) add(nestedExe);
            }
          } catch {
            // Ignore unreadable subdirectory
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
    const scoopExe = join(process.env.SCOOP || join(homedir(), 'scoop'), 'shims', 'wt.exe');
    if (existsSync(scoopExe)) add(scoopExe);
    const cargoExe = join(homedir(), '.cargo', 'bin', 'wt.exe');
    if (existsSync(cargoExe)) add(cargoExe);
  } else {
    add(join(homedir(), '.cargo', 'bin', 'wt'));
    add(join(homedir(), '.local', 'bin', 'wt'));
    add('/opt/homebrew/bin/wt');
    add('/usr/local/bin/wt');
    add('/home/linuxbrew/.linuxbrew/bin/wt');
  }

  return candidates;
}

/**
 * Return platform-specific Worktrunk & Git installation instructions.
 */
export function getInstallGuide(platform = process.platform) {
  const wtOptions = [];
  if (platform === 'win32') {
    wtOptions.push({
      label: 'WinGet (Windows 推荐)',
      command: 'winget install max-sixty.worktrunk',
      note: '安装后可使用 wt 或 git-wt，如遇 Windows Terminal 冲突可运行 git-wt config shell install',
    });
  } else if (platform === 'darwin') {
    wtOptions.push({
      label: 'Homebrew (macOS 推荐)',
      command: 'brew install worktrunk && wt config shell install',
      note: '安装并配置 shell 集成',
    });
  } else {
    wtOptions.push({
      label: 'Homebrew (Linux)',
      command: 'brew install worktrunk && wt config shell install',
      note: '或 Arch Linux: sudo pacman -S worktrunk',
    });
  }

  wtOptions.push({
    label: 'Cargo (通用)',
    command: 'cargo install worktrunk && wt config shell install',
    note: '需要已安装 Rust / Cargo 工具链',
  });

  const gitUpgradeCommand =
    platform === 'win32'
      ? 'winget upgrade Git.Git'
      : platform === 'darwin'
        ? 'brew upgrade git'
        : '请通过系统包管理器升级 Git 至 2.43.0 或更高版本';

  return {
    platform,
    docsUrl: 'https://worktrunk.dev/',
    wtOptions,
    gitUpgradeCommand,
  };
}

const ENV_CACHE_TTL_MS = 60_000;
const envCache = new Map();
const APPROVALS_CACHE_TTL_MS = 5_000;
const approvalsCache = new Map();

/**
 * Drop cached environment results (e.g. after installing Worktrunk).
 */
export function invalidateEnvironmentCache() {
  envCache.clear();
  approvalsCache.clear();
}

/**
 * Resolve Worktrunk binary and check environment health (git version, wt version).
 * Results are cached because every API call needs them and probing spawns
 * several processes (slow on Windows).
 * @param {{ wtBin?: string, fresh?: boolean }} [options]
 */
export async function checkEnvironment(options = {}) {
  const key = options.wtBin || '';
  const cached = envCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < ENV_CACHE_TTL_MS) {
    if (!cached.wtBin || !isAbsolute(cached.wtBin) || existsSync(cached.wtBin)) {
      return cached.promise;
    }
    envCache.delete(key);
  }
  const promise = checkEnvironmentUncached(options);
  const entry = { at: Date.now(), promise, wtBin: null };
  envCache.set(key, entry);
  promise.then(
    (env) => {
      // Do not keep negative results around: the user may be installing wt right now.
      if (!env.ok) {
        envCache.delete(key);
      } else {
        entry.wtBin = env.wtBin || null;
      }
    },
    () => envCache.delete(key)
  );
  return promise;
}

async function resolveWtFromCandidates(explicitBin) {
  const candidates = await collectWtCandidates(explicitBin);
  for (const candidate of candidates) {
    const probe = await probeWtBinary(candidate);
    if (probe.ok) {
      return { resolvedWt: candidate, wtVersion: probe.version, candidates };
    }
  }
  return { resolvedWt: null, wtVersion: null, candidates };
}

async function probeGitVersion() {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: 3000,
      windowsHide: true,
    });
    const gitVersionRaw = stdout.trim();
    const gitVersionTuple = parseVersionTuple(gitVersionRaw);
    const gitSupported = gitVersionTuple ? compareVersions(gitVersionTuple, MIN_GIT_VERSION) >= 0 : false;
    return { gitVersionRaw, gitSupported, gitError: null };
  } catch (err) {
    return { gitVersionRaw: null, gitSupported: false, gitError: err.message };
  }
}

async function checkEnvironmentUncached(options = {}) {
  const [{ resolvedWt, wtVersion, candidates }, { gitVersionRaw, gitSupported, gitError }] = await Promise.all([
    resolveWtFromCandidates(options.wtBin),
    probeGitVersion(),
  ]);

  const issues = [];
  if (!resolvedWt) {
    issues.push(
      '未检测到 Worktrunk (`wt`)，请先安装 Worktrunk（或通过 `--wt-bin` / `WT_BIN` 指定路径）。'
    );
  }
  if (gitError) {
    issues.push(`未检测到 Git: ${gitError}`);
  } else if (!gitSupported) {
    issues.push(
      `当前 ${gitVersionRaw || 'Git'} 低于 Worktrunk 最低要求 (Git 2.43.0+)。`
    );
  }

  return {
    ok: Boolean(resolvedWt && gitSupported),
    wtBin: resolvedWt,
    wtVersion,
    candidates,
    gitVersion: gitVersionRaw,
    gitSupported,
    issues,
    installGuide: getInstallGuide(),
  };
}

/**
 * Execute a Worktrunk (`wt`) command in a given repository directory.
 * @param {string} wtBin
 * @param {string} repoPath
 * @param {string[]} args
 * @param {{ timeout?: number, env?: Record<string, string | undefined> }} [options]
 */
export async function runWt(wtBin, repoPath, args, options = {}) {
  const fullArgs = repoPath ? ['-C', repoPath, ...args] : [...args];
  try {
    const { stdout, stderr } = await execWtRaw(wtBin, fullArgs, {
      timeout: options.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      // Disable ANSI color escapes even when parent env sets CLICOLOR_FORCE
      env: { ...process.env, ...(options.env || {}), NO_COLOR: '1' },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      command: formatCommand(wtBin, fullArgs),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      command: formatCommand(wtBin, fullArgs),
    };
  }
}

/**
 * Inspect Worktrunk project hook command approval state without mutating `approvals.toml`.
 * @param {string} wtBin
 * @param {string} repoPath
 */
export async function checkProjectApprovals(wtBin, repoPath) {
  const cacheKey = `${wtBin || ''}::${repoPath || ''}`;
  const cached = approvalsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < APPROVALS_CACHE_TTL_MS) {
    return cached.value;
  }

  const res = await runWt(wtBin, repoPath, ['config', 'approvals', 'list', '--format=json'], {
    timeout: 10_000,
  });
  const json = parseWtJson(res.stdout);
  if (!res.ok || !json || typeof json.state !== 'string') {
    const fallback = {
      supported: false,
      state: 'unknown',
      commands: [],
      unapproved: [],
    };
    approvalsCache.set(cacheKey, { at: Date.now(), value: fallback });
    return fallback;
  }
  const commands = Array.isArray(json.commands) ? json.commands : [];
  const unapproved = commands.filter((cmd) => cmd && cmd.approved === false);
  const result = {
    supported: true,
    state: json.state,
    commands,
    unapproved,
  };
  if (unapproved.length === 0) {
    approvalsCache.set(cacheKey, { at: Date.now(), value: result });
  } else {
    approvalsCache.delete(cacheKey);
  }
  return result;
}

/**
 * Check whether an automated `wt` operation requires explicit user approval for project hooks.
 * @param {{
 *   wtBin: string,
 *   repoPath: string,
 *   approveHooks?: boolean,
 *   skipHooks?: boolean,
 *   phases?: string[],
 * }} options
 */
export async function resolveApprovalGate({ wtBin, repoPath, approveHooks = false, skipHooks = false, phases = [] }) {
  if (skipHooks || approveHooks) {
    return { allowed: true, passYes: true, unapprovedCommands: [] };
  }

  const approvals = await checkProjectApprovals(wtBin, repoPath);
  if (!approvals.supported || approvals.state !== 'approval_required') {
    return { allowed: true, passYes: true, unapprovedCommands: [] };
  }

  const relevant =
    phases.length > 0
      ? approvals.unapproved.filter((cmd) => !cmd.phase || phases.includes(cmd.phase))
      : approvals.unapproved;

  if (relevant.length === 0) {
    return { allowed: true, passYes: true, unapprovedCommands: [] };
  }

  return {
    allowed: false,
    passYes: false,
    unapprovedCommands: relevant,
  };
}

/**
 * Parse JSON from `wt ... --format=json` stdout.
 * @param {string} stdout
 */
export function parseWtJson(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Build deterministic `wt merge` CLI arguments so UI checkboxes override any user `[merge]` config.
 * @param {Record<string, any>} opts
 * @param {{ includeYes?: boolean }} [flags]
 */
export function buildWtMergeArgs(opts = {}, { includeYes = true } = {}) {
  const args = ['merge'];
  if (opts.target) args.push(String(opts.target).trim());
  args.push('--branch', String(opts.branch).trim());
  args.push('--config-set', `merge.squash=${opts.noSquash ? 'false' : 'true'}`);
  args.push('--config-set', `merge.commit=${opts.noCommit ? 'false' : 'true'}`);
  args.push('--config-set', `merge.rebase=${opts.noRebase ? 'false' : 'true'}`);
  args.push('--config-set', `merge.remove=${opts.noRemove ? 'false' : 'true'}`);
  args.push('--config-set', `merge.ff=${opts.noFf ? 'false' : 'true'}`);
  args.push('--config-set', `merge.verify=${opts.noHooks ? 'false' : 'true'}`);
  if (opts.noSquash) args.push('--no-squash');
  if (opts.noCommit) args.push('--no-commit');
  if (opts.noRebase) args.push('--no-rebase');
  if (opts.noRemove) args.push('--no-remove');
  if (opts.noFf) args.push('--no-ff');
  if (opts.noHooks) args.push('--no-hooks');
  args.push('--format=json');
  if (includeYes) args.push('-y');
  return args;
}

/**
 * Format a command and arguments for human display.
 * @param {string} bin
 * @param {string[]} args
 */
export function formatCommand(bin, args) {
  const quote = (v) => (/[\s"'`]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v);
  const shortBin = /(?:^|[/\\])wt(?:\.exe)?$/i.test(bin) ? 'wt' : quote(bin);
  return [shortBin, ...args.map(quote)].join(' ');
}

