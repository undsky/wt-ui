import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_NPM_PACKAGE_NAME = '@undsky/wtui';

export const NPM_REGISTRIES = [
  { name: 'npmmirror', baseUrl: 'https://registry.npmmirror.com' },
  { name: 'npmjs', baseUrl: 'https://registry.npmjs.org' },
];

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a SemVer 2.0.0 string into comparable parts.
 * @param {string} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[], normalized: string } | null}
 */
export function parseSemver(text) {
  const raw = String(text || '').trim();
  const match = raw.match(SEMVER_RE);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] ? match[4].split('.').filter(Boolean) : [];
  const normalized = `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}`;
  return { major, minor, patch, prerelease, normalized };
}

function compareIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na > nb ? 1 : -1;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/**
 * Compare two SemVer strings. Returns 1 if a > b, -1 if a < b, 0 if equal, or null if invalid.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1 | null}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) {
      return pa[key] > pb[key] ? 1 : -1;
    }
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const maxLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i >= pa.prerelease.length) return -1;
    if (i >= pb.prerelease.length) return 1;
    const cmp = compareIdentifiers(pa.prerelease[i], pb.prerelease[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Fetch the latest version of a package from npm registries (mirror first, official fallback).
 */
export async function checkNpmUpdate({
  packageName = DEFAULT_NPM_PACKAGE_NAME,
  currentVersion = '0.0.0',
  registries = NPM_REGISTRIES,
  fetchImpl = fetch,
  timeoutMs = 6000,
} = {}) {
  const pkg = String(packageName || DEFAULT_NPM_PACKAGE_NAME).trim() || DEFAULT_NPM_PACKAGE_NAME;
  const currentParsed = parseSemver(currentVersion);
  const currentNormalized = currentParsed ? currentParsed.normalized : String(currentVersion || '0.0.0').trim();
  const encodedPkg = encodeURIComponent(pkg);
  const packageUrl = `https://www.npmjs.com/package/${pkg}`;
  const updateCommand = `npm install -g ${pkg}@latest`;
  const errors = [];

  for (const reg of registries) {
    const baseUrl = String(reg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) continue;
    const url = `${baseUrl}/-/package/${encodedPkg}/dist-tags`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'wtui-updater',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const rawLatest = typeof data?.latest === 'string' ? data.latest.trim() : '';
      const latestParsed = parseSemver(rawLatest);
      if (!latestParsed) {
        throw new Error('Invalid dist-tags.latest response');
      }
      const cmp = compareSemver(latestParsed.normalized, currentNormalized);
      return {
        ok: true,
        packageName: pkg,
        currentVersion: currentNormalized,
        latestVersion: latestParsed.normalized,
        hasUpdate: cmp === 1,
        registry: reg.name || baseUrl,
        packageUrl,
        updateCommand,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : (err?.message || String(err));
      errors.push(`${reg.name || baseUrl}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    packageName: pkg,
    currentVersion: currentNormalized,
    latestVersion: null,
    hasUpdate: false,
    packageUrl,
    updateCommand,
    error: errors.join('; ') || 'Unable to reach npm registry',
    checkedAt: new Date().toISOString(),
  };
}

function execNpmRaw(args, { execFileImpl = execFileAsync, timeoutMs = 180_000, platform = process.platform } = {}) {
  if (platform === 'win32') {
    return execFileImpl('cmd.exe', ['/d', '/c', 'npm.cmd', ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  return execFileImpl('npm', args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function resolveGlobalEntryPath(packageName, { execFileImpl, existsSyncImpl = existsSync, platform } = {}) {
  try {
    const { stdout } = await execNpmRaw(['root', '-g'], {
      execFileImpl,
      timeoutMs: 15_000,
      platform,
    });
    const globalRoot = String(stdout || '').trim();
    if (!globalRoot) return null;
    const candidate = join(globalRoot, ...packageName.split('/'), 'bin', 'wt-ui.js');
    return existsSyncImpl(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Install the latest (or specified) version of the package globally via npm.
 */
export async function installNpmUpdate({
  packageName = DEFAULT_NPM_PACKAGE_NAME,
  targetVersion = '',
  registries = NPM_REGISTRIES,
  execFileImpl = execFileAsync,
  existsSyncImpl = existsSync,
  timeoutMs = 180_000,
  platform = process.platform,
} = {}) {
  const pkg = String(packageName || DEFAULT_NPM_PACKAGE_NAME).trim() || DEFAULT_NPM_PACKAGE_NAME;
  const parsedTarget = targetVersion ? parseSemver(targetVersion) : null;
  const cleanTarget = parsedTarget ? parsedTarget.normalized : '';
  const spec = cleanTarget ? `${pkg}@${cleanTarget}` : `${pkg}@latest`;
  const errors = [];

  for (const reg of registries) {
    const baseUrl = String(reg.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) continue;
    try {
      await execNpmRaw(['install', '-g', spec, '--registry', baseUrl], {
        execFileImpl,
        timeoutMs,
        platform,
      });
      const installedEntryPath = await resolveGlobalEntryPath(pkg, {
        execFileImpl,
        existsSyncImpl,
        platform,
      });
      return {
        ok: true,
        packageName: pkg,
        installedVersion: cleanTarget || null,
        registry: reg.name || baseUrl,
        installedEntryPath,
      };
    } catch (err) {
      const detail = err?.stderr ? String(err.stderr).trim() : (err?.message || String(err));
      errors.push(`${reg.name || baseUrl}: ${detail}`);
    }
  }

  return {
    ok: false,
    packageName: pkg,
    installedVersion: null,
    error: errors.join('; ') || 'npm install failed',
  };
}
