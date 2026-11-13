import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { getManagedWtBinPath } from './wt-installer.js';

const execFileAsync = promisify(execFile);

const WINDOWS_TERMINAL_PATTERN = /\\WindowsApps\\wt\.exe$/i;
const MIN_GIT_VERSION = [2, 43, 0];

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
  if (process.platform === 'win32' && WINDOWS_TERMINAL_PATTERN.test(binPath)) {
    return { ok: false, version: null };
  }
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ['--version'], {
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
  for (const name of names) {
    const argVariants = process.platform === 'win32' ? [[name]] : [['-a', name], [name]];
    for (const locatorArgs of argVariants) {
      try {
        const { stdout } = await execFileAsync(locator, locatorArgs, {
          timeout: 3000,
          windowsHide: true,
        });
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) add(trimmed);
        }
        break;
      } catch {
        // Try fallback args or ignore when binary is not on PATH
      }
    }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const wingetRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    const wingetLink = join(localAppData, 'Microsoft', 'WinGet', 'Links', 'wt.exe');
    if (existsSync(wingetLink)) add(wingetLink);
    if (existsSync(wingetRoot)) {
      try {
        for (const entry of readdirSync(wingetRoot)) {
          if (entry.toLowerCase().startsWith('max-sixty.worktrunk')) {
            const exePath = join(wingetRoot, entry, 'wt.exe');
            if (existsSync(exePath)) add(exePath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    }
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

const ENV_CACHE_TTL_MS = 10_000;
const envCache = new Map();

/**
 * Drop cached environment results (e.g. after installing Worktrunk).
 */
export function invalidateEnvironmentCache() {
  envCache.clear();
}

/**
 * Resolve Worktrunk binary and check environment health (git version, wt version).
 * Results are cached briefly because every API call needs them and probing spawns
 * several processes (slow on Windows).
 * @param {{ wtBin?: string, fresh?: boolean }} [options]
 */
export async function checkEnvironment(options = {}) {
  const key = options.wtBin || '';
  const cached = envCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < ENV_CACHE_TTL_MS) {
    return cached.promise;
  }
  const promise = checkEnvironmentUncached(options);
  envCache.set(key, { at: Date.now(), promise });
  promise.then(
    (env) => {
      // Do not keep negative results around: the user may be installing wt right now.
      if (!env.ok) envCache.delete(key);
    },
    () => envCache.delete(key)
  );
  return promise;
}

async function checkEnvironmentUncached(options = {}) {
  const candidates = await collectWtCandidates(options.wtBin);
  let resolvedWt = null;
  let wtVersion = null;

  for (const candidate of candidates) {
    const probe = await probeWtBinary(candidate);
    if (probe.ok) {
      resolvedWt = candidate;
      wtVersion = probe.version;
      break;
    }
  }

  let gitVersionRaw = null;
  let gitVersionTuple = null;
  let gitSupported = false;
  let gitError = null;

  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: 3000,
      windowsHide: true,
    });
    gitVersionRaw = stdout.trim();
    gitVersionTuple = parseVersionTuple(gitVersionRaw);
    gitSupported = gitVersionTuple ? compareVersions(gitVersionTuple, MIN_GIT_VERSION) >= 0 : false;
  } catch (err) {
    gitError = err.message;
  }

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
 * @param {{ timeout?: number }} [options]
 */
export async function runWt(wtBin, repoPath, args, options = {}) {
  const fullArgs = repoPath ? ['-C', repoPath, ...args] : [...args];
  try {
    const { stdout, stderr } = await execFileAsync(wtBin, fullArgs, {
      timeout: options.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
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
 * Format a command and arguments for human display.
 * @param {string} bin
 * @param {string[]} args
 */
export function formatCommand(bin, args) {
  const quote = (v) => (/[\s"'`]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v);
  const shortBin = bin.toLowerCase().endsWith('wt.exe') || bin.endsWith('/wt') || bin === 'wt' ? 'wt' : quote(bin);
  return [shortBin, ...args.map(quote)].join(' ');
}

