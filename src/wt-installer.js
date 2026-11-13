import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getStoreDir } from './store.js';

const execFileAsync = promisify(execFile);

export const CHINA_GITHUB_MIRRORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh-proxy.org/',
  '', // direct GitHub fallback
];

export function getManagedWtDir() {
  return join(getStoreDir(), 'bin');
}

export function getManagedWtBinPath(platform = process.platform) {
  return join(getManagedWtDir(), platform === 'win32' ? 'wt.exe' : 'wt');
}

export function getReleaseAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') {
    // Upstream only ships x64 for Windows; Windows 11 on ARM runs it via emulation.
    return 'worktrunk-x86_64-pc-windows-msvc.zip';
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'worktrunk-aarch64-apple-darwin.tar.xz'
      : 'worktrunk-x86_64-apple-darwin.tar.xz';
  }
  // Linux builds are statically linked against musl (works on glibc distros and Alpine).
  return arch === 'arm64'
    ? 'worktrunk-aarch64-unknown-linux-musl.tar.xz'
    : 'worktrunk-x86_64-unknown-linux-musl.tar.xz';
}

/**
 * Parse a `*.sha256` / `sha256sum` style file and return the hex digest.
 * @param {string} text
 */
export function parseSha256File(text) {
  const match = String(text || '').match(/\b([a-fA-F0-9]{64})\b/);
  return match ? match[1].toLowerCase() : null;
}

function findBinaryRecursive(dir, targetName) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const found = findBinaryRecursive(full, targetName);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Download a URL into memory. Uses a connect timeout plus an idle (stall) timeout
 * instead of a hard total timeout, so slow-but-progressing mirrors still succeed.
 */
async function downloadWithTimeout(url, { minBytes = 1024, idleTimeoutMs = 30_000, maxTotalMs = 600_000 } = {}) {
  const controller = new AbortController();
  let idleTimer = setTimeout(() => controller.abort(new Error('连接超时')), idleTimeoutMs);
  const totalTimer = setTimeout(() => controller.abort(new Error('下载总时长超时')), maxTotalMs);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error('下载停滞超时')), idleTimeoutMs);
  };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'wt-ui-installer' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      total += chunk.length;
      resetIdle();
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
    if (buf.length < minBytes) {
      throw new Error('Downloaded file is unexpectedly small');
    }
    return buf;
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}

/**
 * Fetch the published sha256 digest for an asset, trying the same mirror first,
 * then the remaining mirrors.
 */
async function fetchExpectedSha256(githubUrl, preferredMirror) {
  const ordered = [preferredMirror, ...CHINA_GITHUB_MIRRORS.filter((m) => m !== preferredMirror)];
  for (const mirror of ordered) {
    const url = mirror ? `${mirror}${githubUrl}.sha256` : `${githubUrl}.sha256`;
    try {
      const buf = await downloadWithTimeout(url, { minBytes: 64, idleTimeoutMs: 15_000, maxTotalMs: 30_000 });
      const digest = parseSha256File(buf.toString('utf8'));
      if (digest) return digest;
    } catch {
      // try next mirror
    }
  }
  return null;
}

async function extractArchive(archivePath, extractDir) {
  if (archivePath.endsWith('.zip')) {
    const ps = (s) => s.replace(/'/g, "''");
    try {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ProgressPreference='SilentlyContinue'; Expand-Archive -LiteralPath '${ps(archivePath)}' -DestinationPath '${ps(extractDir)}' -Force`,
        ],
        { timeout: 60_000, windowsHide: true }
      );
      return;
    } catch (err) {
      // Fallback: bsdtar ships with Windows 10 1803+ and can read zip files.
      try {
        await execFileAsync('tar.exe', ['-xf', archivePath, '-C', extractDir], { timeout: 60_000, windowsHide: true });
        return;
      } catch {
        throw err;
      }
    }
  }
  try {
    await execFileAsync('tar', ['-xJf', archivePath, '-C', extractDir], { timeout: 60_000 });
  } catch (err) {
    throw new Error(`解压失败（请确认系统已安装 tar 与 xz）: ${err.message}`);
  }
}

async function installViaMirrorBinary(onLog) {
  const asset = getReleaseAssetName();
  const githubUrl = `https://github.com/max-sixty/worktrunk/releases/latest/download/${asset}`;
  const tempRoot = mkdtempSync(join(tmpdir(), 'wt-install-'));
  const archivePath = join(tempRoot, asset);
  const extractDir = join(tempRoot, 'extracted');
  mkdirSync(extractDir, { recursive: true });

  try {
    let downloaded = null;
    let usedMirror = null;

    for (const mirror of CHINA_GITHUB_MIRRORS) {
      const label = mirror || 'github.com';
      const url = mirror ? `${mirror}${githubUrl}` : githubUrl;
      onLog?.(`尝试从镜像下载 Worktrunk: ${mirror || 'github.com (直连)'}`);
      try {
        const buf = await downloadWithTimeout(url);
        const expected = await fetchExpectedSha256(githubUrl, mirror);
        const actual = createHash('sha256').update(buf).digest('hex');
        if (expected && expected !== actual) {
          onLog?.(`✗ 校验失败 (${label}): sha256 不匹配，已丢弃`);
          continue;
        }
        if (!expected) {
          onLog?.(`⚠ 无法获取 sha256 校验文件，跳过完整性校验 (${label})`);
        } else {
          onLog?.(`✓ sha256 校验通过`);
        }
        downloaded = buf;
        usedMirror = label;
        break;
      } catch (err) {
        onLog?.(`镜像不可用 (${label}): ${err.message}`);
      }
    }

    if (!downloaded) {
      return { ok: false, method: 'mirror-binary', error: '所有下载镜像均失败' };
    }

    writeFileSync(archivePath, downloaded);
    await extractArchive(archivePath, extractDir);

    const binName = process.platform === 'win32' ? 'wt.exe' : 'wt';
    const foundBin = findBinaryRecursive(extractDir, binName);
    if (!foundBin) {
      return { ok: false, method: 'mirror-binary', error: `压缩包中未找到 ${binName}` };
    }

    const destDir = getManagedWtDir();
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    const destPath = getManagedWtBinPath();
    copyFileSync(foundBin, destPath);
    if (process.platform !== 'win32') {
      chmodSync(destPath, 0o755);
    }

    onLog?.(`✓ 已通过 ${usedMirror} 下载并安装到 ${destPath}`);
    return { ok: true, method: 'mirror-binary', mirror: usedMirror, wtBin: destPath };
  } catch (err) {
    return { ok: false, method: 'mirror-binary', error: err.message };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function installViaCargoChinaMirror(onLog) {
  try {
    await execFileAsync('cargo', ['--version'], { timeout: 3000, windowsHide: true });
  } catch {
    return { ok: false, method: 'cargo-ustc', error: '未安装 cargo' };
  }

  onLog?.('尝试使用中科大 Cargo 国内源编译安装 worktrunk（可能需要数分钟）...');
  try {
    // crates-io's index cannot be overridden directly; source replacement is required.
    await execFileAsync('cargo', [...getCargoMirrorArgs(), 'install', 'worktrunk', '--locked'], {
      timeout: 1_200_000,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, method: 'cargo-ustc', mirror: 'mirrors.ustc.edu.cn' };
  } catch (err) {
    return { ok: false, method: 'cargo-ustc', error: err.message };
  }
}

/**
 * Cargo `--config` args that redirect crates.io to the USTC sparse mirror.
 */
export function getCargoMirrorArgs() {
  return [
    '--config',
    "source.crates-io.replace-with='ustc'",
    '--config',
    "source.ustc.registry='sparse+https://mirrors.ustc.edu.cn/crates.io-index/'",
  ];
}

async function installViaPackageManager(onLog) {
  if (process.platform === 'win32') {
    try {
      await execFileAsync('winget', ['--version'], { timeout: 5000, windowsHide: true });
    } catch {
      return { ok: false, method: 'winget', error: '未安装 winget' };
    }
    onLog?.('尝试使用 winget 安装 max-sixty.worktrunk（下载源为 GitHub，国内可能较慢）...');
    try {
      await execFileAsync(
        'winget',
        [
          'install',
          '--id',
          'max-sixty.worktrunk',
          '--exact',
          '--source',
          'winget',
          '--silent',
          '--accept-package-agreements',
          '--accept-source-agreements',
        ],
        { timeout: 300_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
      );
      return { ok: true, method: 'winget', mirror: 'winget' };
    } catch (err) {
      return { ok: false, method: 'winget', error: err.message };
    }
  }

  try {
    await execFileAsync('brew', ['--version'], { timeout: 5000 });
  } catch {
    return { ok: false, method: 'brew-ustc', error: '未安装 Homebrew' };
  }

  onLog?.('尝试使用中科大 Homebrew 国内源安装 worktrunk...');
  try {
    await execFileAsync('brew', ['install', 'worktrunk'], {
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_INSTALL_CLEANUP: '1',
        HOMEBREW_API_DOMAIN: 'https://mirrors.ustc.edu.cn/homebrew-bottles/api',
        HOMEBREW_BOTTLE_DOMAIN: 'https://mirrors.ustc.edu.cn/homebrew-bottles',
        HOMEBREW_BREW_GIT_REMOTE: 'https://mirrors.ustc.edu.cn/brew.git',
        HOMEBREW_CORE_GIT_REMOTE: 'https://mirrors.ustc.edu.cn/homebrew-core.git',
      },
    });
    return { ok: true, method: 'brew-ustc', mirror: 'mirrors.ustc.edu.cn' };
  } catch (err) {
    return { ok: false, method: 'brew-ustc', error: err.message };
  }
}

let inflightInstall = null;

/**
 * Automatically install Worktrunk using domestic (China) mirrors.
 * Concurrent callers share the same in-flight installation.
 * @param {{ onLog?: (msg: string) => void }} [options]
 */
export function autoInstallWorktrunk(options = {}) {
  if (inflightInstall) {
    options.onLog?.('已有安装任务正在进行，等待其完成...');
    return inflightInstall;
  }
  inflightInstall = runInstallStrategies(options).finally(() => {
    inflightInstall = null;
  });
  return inflightInstall;
}

async function runInstallStrategies(options) {
  const logs = [];
  const log = (msg) => {
    logs.push(msg);
    options.onLog?.(msg);
  };

  const strategies = [installViaMirrorBinary, installViaCargoChinaMirror, installViaPackageManager];
  for (const strategy of strategies) {
    let res;
    try {
      res = await strategy(log);
    } catch (err) {
      res = { ok: false, method: strategy.name, error: err?.message || String(err) };
    }
    if (res.ok) {
      return { ...res, logs };
    }
    log(`✗ ${res.method} 失败: ${res.error}`);
  }

  return {
    ok: false,
    error: '自动安装 Worktrunk 失败，请检查网络连接或手动安装',
    logs,
  };
}

