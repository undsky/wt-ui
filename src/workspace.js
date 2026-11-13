import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Strip JSONC comments (// and /* *\/) and trailing commas safely outside strings.
 * @param {string} input
 * @returns {string}
 */
export function stripJsonc(input) {
  let out = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Remove trailing commas before } or ] outside strings
  let cleaned = '';
  inString = false;
  escape = false;
  for (let j = 0; j < out.length; j += 1) {
    const ch = out[j];
    if (inString) {
      cleaned += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k += 1;
      if (out[k] === '}' || out[k] === ']') {
        continue;
      }
    }
    cleaned += ch;
  }

  return cleaned;
}

/**
 * Check whether a directory is inside a Git repository and return its top-level root.
 * @param {string} dirPath
 * @returns {Promise<{ isGitRepo: boolean, rootPath: string | null }>}
 */
export async function inspectGitRepo(dirPath) {
  if (!dirPath || !existsSync(dirPath)) {
    return { isGitRepo: false, rootPath: null };
  }
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) {
      return { isGitRepo: false, rootPath: null };
    }
  } catch {
    return { isGitRepo: false, rootPath: null };
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', dirPath, 'rev-parse', '--show-toplevel'], {
      timeout: 3000,
      windowsHide: true,
    });
    const rootPath = stdout.trim();
    if (rootPath) {
      return { isGitRepo: true, rootPath: resolve(rootPath) };
    }
  } catch {
    // Fall back to checking .git existence in case git is unavailable or bare
    if (existsSync(resolve(dirPath, '.git'))) {
      return { isGitRepo: true, rootPath: resolve(dirPath) };
    }
  }

  return { isGitRepo: false, rootPath: null };
}

/**
 * Parse a VS Code / Cursor `.code-workspace` file and inspect its folders.
 * @param {string} workspaceFilePath
 */
export async function parseCodeWorkspace(workspaceFilePath) {
  const absFile = resolve(workspaceFilePath);
  if (!existsSync(absFile)) {
    throw new Error(`Workspace file not found: ${absFile}`);
  }
  const raw = readFileSync(absFile, 'utf8');
  const parsed = JSON.parse(stripJsonc(raw));
  const baseDir = dirname(absFile);
  const folders = Array.isArray(parsed.folders) ? parsed.folders : [];

  const resolvedProjects = [];
  for (const entry of folders) {
    if (!entry || typeof entry.path !== 'string') continue;
    const absPath = isAbsolute(entry.path) ? resolve(entry.path) : resolve(baseDir, entry.path);
    const gitInfo = await inspectGitRepo(absPath);
    resolvedProjects.push({
      name: entry.name || basename(absPath),
      path: absPath,
      exists: existsSync(absPath),
      isGitRepo: gitInfo.isGitRepo,
      gitRoot: gitInfo.rootPath,
    });
  }

  return {
    name: basename(absFile).replace(/\.code-workspace$/i, ''),
    workspaceFile: absFile,
    projects: resolvedProjects,
  };
}

/**
 * List available Windows drive roots (e.g. C:\, D:\, E:\).
 */
function listWindowsDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (existsSync(drive)) {
      drives.push({ name: drive, path: drive, type: 'drive', isGitRepo: false });
    }
  }
  return drives;
}

/**
 * Browse a filesystem path for directories and `.code-workspace` files.
 * @param {string | undefined} targetPath
 */
export function browsePath(targetPath) {
  if (!targetPath) {
    if (process.platform === 'win32') {
      return {
        currentPath: '',
        parentPath: null,
        entries: listWindowsDrives(),
      };
    }
    targetPath = '/';
  }

  const abs = resolve(targetPath);
  if (!existsSync(abs)) {
    throw new Error(`Path does not exist: ${abs}`);
  }

  const parent = dirname(abs);
  const parentPath = parent === abs ? (process.platform === 'win32' ? '' : null) : parent;

  const dirents = readdirSync(abs, { withFileTypes: true });
  const entries = [];

  for (const dirent of dirents) {
    if (dirent.name.startsWith('$') || dirent.name === 'System Volume Information') continue;
    const fullPath = resolve(abs, dirent.name);
    if (dirent.isDirectory()) {
      const isGitRepo = existsSync(resolve(fullPath, '.git'));
      entries.push({
        name: dirent.name,
        path: fullPath,
        type: 'directory',
        isGitRepo,
      });
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.code-workspace')) {
      entries.push({
        name: dirent.name,
        path: fullPath,
        type: 'workspace',
        isGitRepo: false,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'workspace' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    currentPath: abs,
    parentPath,
    entries,
  };
}

/**
 * Open a native OS folder or .code-workspace file picker dialog.
 * @param {'folder' | 'workspace'} mode
 */
export async function pickNativePath(mode = 'folder') {
  if (process.platform === 'win32') {
    const script =
      mode === 'workspace'
        ? [
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            'Add-Type -AssemblyName System.Windows.Forms',
            '$d = New-Object System.Windows.Forms.OpenFileDialog',
            "$d.Title = 'Select .code-workspace file'",
            "$d.Filter = 'Workspace (*.code-workspace)|*.code-workspace|All files (*.*)|*.*'",
            'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
          ].join('; ')
        : [
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            'Add-Type -AssemblyName System.Windows.Forms',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
            "$d.Description = 'Select Git project folder'",
            'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
          ].join('; ');

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', script],
      { timeout: 120_000, windowsHide: true }
    );
    const selected = (stdout || '').trim();
    return { cancelled: !selected, path: selected || null };
  }

  if (process.platform === 'darwin') {
    const script =
      mode === 'workspace'
        ? 'POSIX path of (choose file with prompt "选择 .code-workspace 文件")'
        : 'POSIX path of (choose folder with prompt "选择 Git 项目文件夹")';
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120_000 });
      const selected = (stdout || '').trim();
      return { cancelled: !selected, path: selected || null };
    } catch {
      return { cancelled: true, path: null };
    }
  }

  const zenityArgs =
    mode === 'workspace'
      ? ['--file-selection', '--file-filter=*.code-workspace']
      : ['--file-selection', '--directory'];
  try {
    const { stdout } = await execFileAsync('zenity', zenityArgs, { timeout: 120_000 });
    const selected = (stdout || '').trim();
    return { cancelled: !selected, path: selected || null };
  } catch (err) {
    // Fallback to kdialog on KDE/Qt Linux desktops when zenity is unavailable
    if (err?.code === 'ENOENT') {
      const kdialogArgs =
        mode === 'workspace'
          ? ['--getopenfilename', homedir(), '*.code-workspace|Workspace (*.code-workspace)']
          : ['--getexistingdirectory', homedir()];
      try {
        const { stdout } = await execFileAsync('kdialog', kdialogArgs, { timeout: 120_000 });
        const selected = (stdout || '').trim();
        return { cancelled: !selected, path: selected || null };
      } catch {
        return { cancelled: true, path: null };
      }
    }
    return { cancelled: true, path: null };
  }
}

