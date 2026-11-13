import { execFile } from 'node:child_process';
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
  'https://mirror.ghproxy.com/',
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
    return arch === 'arm64'
      ? 'worktrunk-aarch64-pc-windows-msvc.zip'
      : 'worktrunk-x86_64-pc-windows-msvc.zip';
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'worktrunk-aarch64-apple-darwin.tar.xz'
      : 'worktrunk-x86_64-apple-darwin.tar.xz';
  }
  return arch === 'arm64'
    ? 'worktrunk-aarch64-unknown-linux-gnu.tar.xz'
    : 'worktrunk-x86_64-unknown-linux-gnu.tar.xz';
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

async function downloadWithTimeout(url, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'wt-ui-installer' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) {
      throw new Error('Downloaded file is unexpectedly small');
    }
    return buf;
  } finally {
    clearTimeout(timer);
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
      const url = mirror ? `${mirror}${githubUrl}` : githubUrl;
      onLog?.(`尝试从镜像下载 Worktrunk: ${mirror || 'github.com (直连)'}`);
      try {
        downloaded = await downloadWithTimeout(url);
        usedMirror = mirror || 'github.com';
        break;
      } catch (err) {
        onLog?.(`镜像不可用 (${mirror || 'github.com'}): ${err.message}`);
      }
    }

    if (!downloaded) {
      return { ok: false, method: 'mirror-binary', error: '所有下载镜像均失败' };
    }

    writeFileSync(archivePath, downloaded);

    if (asset.endsWith('.zip')) {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`],
        { timeout: 30_000, windowsHide: true }
      );
    } else {
      await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir], {
        timeout: 30_000,
        windowsHide: true,
      });
    }

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

  onLog?.('尝试使用中科大 Cargo 国内源安装 worktrunk...');
  try {
    await execFileAsync('cargo', ['install', 'worktrunk', '--locked'], {
      timeout: 300_000,
      windowsHide: true,
      env: {
        ...process.env,
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
        CARGO_REGISTRIES_CRATES_IO_INDEX: 'sparse+https://mirrors.ustc.edu.cn/crates.io-index/',
      },
    });
    return { ok: true, method: 'cargo-ustc', mirror: 'mirrors.ustc.edu.cn' };
  } catch (err) {
    return { ok: false, method: 'cargo-ustc', error: err.message };
  }
}

async function installViaPackageManager(onLog) {
  if (process.platform === 'win32') {
    onLog?.('尝试使用 winget 安装 max-sixty.worktrunk...');
    try {
      await execFileAsync(
        'winget',
        ['install', '--id', 'max-sixty.worktrunk', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
        { timeout: 180_000, windowsHide: true }
      );
      return { ok: true, method: 'winget', mirror: 'winget' };
    } catch (err) {
      return { ok: false, method: 'winget', error: err.message };
    }
  }

  try {
    await execFileAsync('brew', ['--version'], { timeout: 3000, windowsHide: true });
  } catch {
    return { ok: false, method: 'brew-ustc', error: '未安装 Homebrew' };
  }

  onLog?.('尝试使用中科大 Homebrew 国内源安装 worktrunk...');
  try {
    await execFileAsync('brew', ['install', 'worktrunk'], {
      timeout: 240_000,
      windowsHide: true,
      env: {
        ...process.env,
        HOMEBREW_API_DOMAIN: 'https://mirrors.ustc.edu.cn/homebrew-bottles/api',
        HOMEBREW_BOTTLE_DOMAIN: 'https://mirrors.ustc.edu.cn/homebrew-bottles',
        HOMEBREW_BREW_GIT_REMOTE: 'https://mirrors.ustc.edu.cn/brew.git',
      },
    });
    return { ok: true, method: 'brew-ustc', mirror: 'mirrors.ustc.edu.cn' };
  } catch (err) {
    return { ok: false, method: 'brew-ustc', error: err.message };
  }
}

/**
 * Automatically install Worktrunk using domestic (China) mirrors.
 * @param {{ onLog?: (msg: string) => void }} [options]
 */
export async function autoInstallWorktrunk(options = {}) {
  const logs = [];
  const log = (msg) => {
    logs.push(msg);
    options.onLog?.(msg);
  };

  const strategies = [installViaMirrorBinary, installViaCargoChinaMirror, installViaPackageManager];
  for (const strategy of strategies) {
    const res = await strategy(log);
    if (res.ok) {
      return { ...res, logs };
    }
  }

  return {
    ok: false,
    error: '自动安装 Worktrunk 失败，请检查网络连接或手动安装',
    logs,
  };
}

