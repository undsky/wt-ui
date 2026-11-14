import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Compare filesystem paths. Windows and macOS (default APFS) are case-insensitive;
 * Linux is case-sensitive.
 */
export function samePath(a, b, platform = process.platform) {
  if (platform === 'win32' || platform === 'darwin') {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
  return a === b;
}

export function getStoreDir() {
  return process.env.WT_UI_HOME ? resolve(process.env.WT_UI_HOME) : join(homedir(), '.wt-ui');
}

export function getStorePath() {
  return join(getStoreDir(), 'store.json');
}

export function getDefaultPreferredTerminal(platform = process.platform) {
  if (platform === 'darwin') {
    if (
      existsSync('/Applications/iTerm.app') ||
      existsSync(join(homedir(), 'Applications', 'iTerm.app'))
    ) {
      return 'iterm2';
    }
    return 'terminal';
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    if (existsSync(join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'))) {
      return 'wt';
    }
    return 'cmd';
  }
  return 'auto';
}

export function getAutoStartFilePath(platform = process.platform) {
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'LaunchAgents', 'dev.worktrunk.wt-ui.plist');
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'wt-ui-autostart.vbs');
  }
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), '.config');
  return join(configHome, 'autostart', 'wt-ui.desktop');
}

function getLegacyWindowsAutoStartCmdPath() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'wt-ui-autostart.cmd');
}

export function isAutoStartFilePresent(platform = process.platform) {
  if (existsSync(getAutoStartFilePath(platform))) return true;
  if (platform === 'win32' && existsSync(getLegacyWindowsAutoStartCmdPath())) return true;
  return false;
}

export function setAutoStartEnabled(enabled, platform = process.platform) {
  const targetFile = getAutoStartFilePath(platform);
  if (!enabled) {
    if (existsSync(targetFile)) {
      rmSync(targetFile, { force: true });
    }
    if (platform === 'win32') {
      const legacyCmd = getLegacyWindowsAutoStartCmdPath();
      if (existsSync(legacyCmd)) {
        rmSync(legacyCmd, { force: true });
      }
    }
    return { ok: true, enabled: false, path: targetFile };
  }

  const parentDir = dirname(targetFile);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const nodeBin = process.execPath;
  const cliScript = resolve(__dirname, '..', 'bin', 'wt-ui.js');
  const logFile = join(getStoreDir(), 'autostart.log');

  if (platform === 'darwin') {
    const escapeXml = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const envPath = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.worktrunk.wt-ui</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(cliScript)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homedir())}</string>
    <key>PATH</key>
    <string>${escapeXml(envPath)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
    writeFileSync(targetFile, plist, 'utf8');
  } else if (platform === 'win32') {
    const legacyCmd = getLegacyWindowsAutoStartCmdPath();
    if (existsSync(legacyCmd)) {
      rmSync(legacyCmd, { force: true });
    }
    const escapeVbs = (s) => String(s).replace(/"/g, '""');
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.CurrentDirectory = "${escapeVbs(homedir())}"`,
      `WshShell.Run """${escapeVbs(nodeBin)}"" ""${escapeVbs(cliScript)}"" start --no-open", 0, False`,
      '',
    ].join('\r\n');
    writeFileSync(targetFile, vbsContent, 'utf8');
  } else {
    const escapeDesktopArg = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
    const desktopContent = [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      'Name=wt-ui',
      'Comment=Worktrunk Visual Worktree Platform',
      `Exec=${escapeDesktopArg(nodeBin)} ${escapeDesktopArg(cliScript)} start --no-open`,
      `Path=${homedir()}`,
      'Terminal=false',
      'StartupNotify=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');
    writeFileSync(targetFile, desktopContent, 'utf8');
  }

  return { ok: true, enabled: true, path: targetFile };
}

function defaultStore() {
  return {
    workspaces: [],
    projects: [],
    customTools: [],
    generalConfig: {
      autoStart: isAutoStartFilePresent(),
      preferredTerminal: getDefaultPreferredTerminal(),
    },
    aiConfig: {
      url: '',
      key: '',
      model: '',
    },
    activeProjectId: null,
  };
}

export function loadStore() {
  const filePath = getStorePath();
  if (!existsSync(filePath)) {
    return defaultStore();
  }
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      customTools: Array.isArray(parsed.customTools) ? parsed.customTools : [],
      generalConfig: {
        autoStart:
          typeof parsed.generalConfig?.autoStart === 'boolean'
            ? parsed.generalConfig.autoStart
            : isAutoStartFilePresent(),
        preferredTerminal:
          typeof parsed.generalConfig?.preferredTerminal === 'string' && parsed.generalConfig.preferredTerminal.trim()
            ? parsed.generalConfig.preferredTerminal.trim()
            : getDefaultPreferredTerminal(),
      },
      aiConfig: {
        url: typeof parsed.aiConfig?.url === 'string' ? parsed.aiConfig.url : '',
        key: typeof parsed.aiConfig?.key === 'string' ? parsed.aiConfig.key : '',
        model: typeof parsed.aiConfig?.model === 'string' ? parsed.aiConfig.model : '',
      },
      activeProjectId: parsed.activeProjectId ?? null,
    };
  } catch {
    return defaultStore();
  }
}

export function saveStore(store) {
  const dir = getStoreDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf8');
  return store;
}

export function addStandaloneProject(store, { name, path, defaultToolId }) {
  const absPath = resolve(path);
  const existing = store.projects.find((p) => samePath(p.path, absPath));
  if (existing) {
    if (name) existing.name = name;
    if (defaultToolId !== undefined) existing.defaultToolId = defaultToolId;
    if (!existing.worktreeTools || typeof existing.worktreeTools !== 'object') {
      existing.worktreeTools = {};
    }
    store.activeProjectId = existing.id;
    return existing;
  }
  const project = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    name: name || basename(absPath),
    path: absPath,
    workspaceId: null,
    defaultToolId: defaultToolId || 'claude',
    worktreeTools: {},
    addedAt: new Date().toISOString(),
  };
  store.projects.push(project);
  store.activeProjectId = project.id;
  return project;
}

export function importWorkspaceProjects(store, workspaceData) {
  const absWsFile = resolve(workspaceData.workspaceFile);
  let ws = store.workspaces.find((w) => samePath(w.workspaceFile, absWsFile));
  if (!ws) {
    ws = {
      id: `ws_${randomUUID().slice(0, 8)}`,
      name: workspaceData.name,
      workspaceFile: absWsFile,
      addedAt: new Date().toISOString(),
    };
    store.workspaces.push(ws);
  } else {
    ws.name = workspaceData.name;
  }

  const importedProjects = [];
  for (const item of workspaceData.projects) {
    if (!item.isGitRepo) continue;
    const absPath = resolve(item.gitRoot || item.path);
    let proj = store.projects.find((p) => samePath(p.path, absPath));
    if (!proj) {
      proj = {
        id: `proj_${randomUUID().slice(0, 8)}`,
        name: item.name || basename(absPath),
        path: absPath,
        workspaceId: ws.id,
        defaultToolId: 'claude',
        worktreeTools: {},
        addedAt: new Date().toISOString(),
      };
      store.projects.push(proj);
    } else {
      proj.workspaceId = ws.id;
      if (item.name) proj.name = item.name;
      if (!proj.worktreeTools || typeof proj.worktreeTools !== 'object') {
        proj.worktreeTools = {};
      }
    }
    importedProjects.push(proj);
  }

  if (importedProjects.length > 0 && !store.activeProjectId) {
    store.activeProjectId = importedProjects[0].id;
  } else if (importedProjects.length > 0) {
    store.activeProjectId = importedProjects[0].id;
  }

  return { workspace: ws, projects: importedProjects };
}

export function removeProject(store, projectId) {
  store.projects = store.projects.filter((p) => p.id !== projectId);
  if (store.activeProjectId === projectId) {
    store.activeProjectId = store.projects[0]?.id ?? null;
  }
  // Clean up empty workspaces
  store.workspaces = store.workspaces.filter((ws) =>
    store.projects.some((p) => p.workspaceId === ws.id)
  );
  return store;
}

export function removeWorkspace(store, workspaceId) {
  store.workspaces = store.workspaces.filter((w) => w.id !== workspaceId);
  store.projects = store.projects.filter((p) => p.workspaceId !== workspaceId);
  if (!store.projects.some((p) => p.id === store.activeProjectId)) {
    store.activeProjectId = store.projects[0]?.id ?? null;
  }
  return store;
}

