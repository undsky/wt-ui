import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

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

function defaultStore() {
  return {
    workspaces: [],
    projects: [],
    customTools: [],
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
    store.activeProjectId = existing.id;
    return existing;
  }
  const project = {
    id: `proj_${randomUUID().slice(0, 8)}`,
    name: name || basename(absPath),
    path: absPath,
    workspaceId: null,
    defaultToolId: defaultToolId || 'claude',
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
        addedAt: new Date().toISOString(),
      };
      store.projects.push(proj);
    } else {
      proj.workspaceId = ws.id;
      if (item.name) proj.name = item.name;
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

