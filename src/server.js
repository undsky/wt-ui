import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  buildWtMergeArgs,
  checkEnvironment,
  invalidateEnvironmentCache,
  parseWtJson,
  resolveApprovalGate,
  runWt,
} from './wt-resolver.js';
import { autoInstallWorktrunk } from './wt-installer.js';
import { browsePath, inspectGitRepo, parseCodeWorkspace, pickNativePath } from './workspace.js';
import {
  detectOrStartLocalConflictSession,
  getWorktreeInProgressOp,
  listGitWorktrees,
  pullWorktreeBranch,
  pushWorktreeBranch,
} from './remote.js';
import {
  abortConflictMerge,
  aiResolveAndCompleteConflictMerge,
  completeConflictMerge,
  fetchAiModels,
  getConflictStatus,
  readConflictFileDetails,
  resolveConflictFile,
} from './conflict.js';
import {
  addStandaloneProject,
  importWorkspaceProjects,
  loadStore,
  removeProject,
  removeWorkspace,
  samePath,
  saveStore,
  setAutoStartEnabled,
  withStoreLock,
} from './store.js';
import {
  BUILTIN_TOOLS,
  findToolById,
  getAllTools,
  getSupportedTerminals,
  switchAndOpenWorktree,
} from './tools.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const MONACO_DIR = resolve(__dirname, '..', 'node_modules', 'monaco-editor', 'min');
const PKG = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));
const APP_VERSION = PKG.version || '0.1.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function isValidBranchName(name) {
  if (typeof name !== 'string') return false;
  if (!name || name.length > 255) return false;
  if (name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
    return false;
  }
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  const segments = name.split('/');
  return segments.every((seg) => seg.length > 0 && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  // Requiring application/json forces cross-origin requests through a CORS preflight,
  // which this server never approves.
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CACHED_HOSTNAME = (() => {
  try {
    return osHostname().toLowerCase();
  } catch {
    return '';
  }
})();

function isAllowedHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h)) return true; // DNS rebinding needs a domain name, IP literals are safe
  return Boolean(CACHED_HOSTNAME && h === CACHED_HOSTNAME);
}

/**
 * Reject requests that could come from a malicious web page:
 * - Host header must be localhost / an IP literal / this machine (blocks DNS rebinding)
 * - Origin, when present, must match the Host (blocks cross-site requests)
 */
function checkRequestOrigin(req) {
  const hostHeader = req.headers.host || '';
  let hostUrl;
  try {
    hostUrl = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!isAllowedHostname(hostUrl.hostname)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const o = new URL(origin);
      if (o.host.toLowerCase() !== hostUrl.host.toLowerCase()) return false;
    } catch {
      return false;
    }
  } else if (origin === 'null') {
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

async function serveStaticFromRoot(rootDir, reqPath, req, res, cacheControl = 'no-cache') {
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    sendJson(res, 400, { error: 'Bad path' });
    return;
  }
  const normalized = decoded.replace(/^\/+/, '');
  const target = resolve(rootDir, normalized);
  const inside = target === rootDir || target.startsWith(rootDir + sep);
  if (!inside) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  let st;
  try {
    st = await stat(target);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!st.isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return;
  }
  const ext = extname(target);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const buf = await readFile(target);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    ETag: etag,
  });
  res.end(buf);
}

async function serveStatic(reqPath, req, res) {
  if (reqPath.startsWith('/vendor/monaco/')) {
    const monacoSubPath = reqPath.slice('/vendor/monaco/'.length);
    await serveStaticFromRoot(MONACO_DIR, monacoSubPath, req, res, 'public, max-age=3600');
    return;
  }
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  await serveStaticFromRoot(PUBLIC_DIR, cleanPath, req, res, 'no-cache');
}

function requireProject(store, projectId, notFoundMsg = '项目不存在') {
  const project = store.projects.find((p) => p.id === (projectId || store.activeProjectId));
  if (!project) {
    throw new HttpError(404, notFoundMsg);
  }
  return project;
}

async function cleanupWorktreeTools(projectId, exactKeys = [], pathToMatch = '') {
  return withStoreLock(() => {
    const freshStore = loadStore();
    const proj = freshStore.projects.find((p) => p.id === projectId);
    if (!proj || !proj.worktreeTools || typeof proj.worktreeTools !== 'object') {
      return {};
    }
    let dirty = false;
    const delKey = (k) => {
      if (k && k in proj.worktreeTools) {
        delete proj.worktreeTools[k];
        dirty = true;
      }
    };
    for (const k of exactKeys) delKey(k);
    if (pathToMatch) {
      delKey(pathToMatch);
      for (const existingKey of Object.keys(proj.worktreeTools)) {
        if (samePath(existingKey, pathToMatch)) {
          delKey(existingKey);
        }
      }
    }
    if (dirty) saveStore(freshStore);
    return proj.worktreeTools;
  });
}

export function createAppServer({ wtBin: explicitWtBin, noAutoInstall = false } = {}) {
  const server = createServer(async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      } catch {
        throw new HttpError(400, 'Bad request URL or Host header');
      }
      const pathname = url.pathname;

      if (!pathname.startsWith('/api/')) {
        await serveStatic(pathname, req, res);
        return;
      }

      if (!checkRequestOrigin(req)) {
        sendJson(res, 403, { error: 'Forbidden: cross-origin or untrusted Host header' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        sendJson(res, 200, { ...env, autoInstall: !noAutoInstall });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/wt/install') {
        const installResult = await autoInstallWorktrunk();
        invalidateEnvironmentCache();
        const env = await checkEnvironment({ wtBin: explicitWtBin, fresh: true });
        sendJson(res, installResult.ok ? 200 : 500, { installResult, env });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        const store = loadStore();
        sendJson(res, 200, {
          ...store,
          appVersion: APP_VERSION,
          tools: getAllTools(store.customTools),
          terminals: getSupportedTerminals(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/fs/browse') {
        const target = url.searchParams.get('path') || '';
        const listing = browsePath(target);
        sendJson(res, 200, listing);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/fs/pick') {
        const body = await readJsonBody(req);
        const mode = body.mode === 'workspace' ? 'workspace' : 'folder';
        const picked = await pickNativePath(mode);
        sendJson(res, 200, picked);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/projects') {
        const body = await readJsonBody(req);
        if (!body.path || typeof body.path !== 'string') {
          sendJson(res, 400, { error: '请提供项目文件夹路径' });
          return;
        }
        const gitInfo = await inspectGitRepo(body.path);
        if (!gitInfo.isGitRepo) {
          sendJson(res, 400, { error: `该目录不是 Git 仓库: ${body.path}` });
          return;
        }
        const payload = await withStoreLock(() => {
          const store = loadStore();
          const project = addStandaloneProject(store, {
            name: body.name,
            path: gitInfo.rootPath || body.path,
            defaultToolId: body.defaultToolId,
          });
          saveStore(store);
          return { project, store };
        });
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/import') {
        const body = await readJsonBody(req);
        if (!body.workspaceFile || typeof body.workspaceFile !== 'string') {
          sendJson(res, 400, { error: '请提供 .code-workspace 文件路径' });
          return;
        }
        const wsData = await parseCodeWorkspace(body.workspaceFile);
        const gitCount = wsData.projects.filter((p) => p.isGitRepo).length;
        if (gitCount === 0) {
          sendJson(res, 400, {
            error: '该工作区中未找到有效的 Git 仓库文件夹',
            workspace: wsData,
          });
          return;
        }
        const payload = await withStoreLock(() => {
          const store = loadStore();
          const imported = importWorkspaceProjects(store, wsData);
          saveStore(store);
          return {
            workspace: imported.workspace,
            importedProjects: imported.projects,
            skippedCount: wsData.projects.length - gitCount,
            store,
          };
        });
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/active-project') {
        const body = await readJsonBody(req);
        const activeProjectId = await withStoreLock(() => {
          const store = loadStore();
          if (!store.projects.some((p) => p.id === body.projectId)) {
            throw new HttpError(404, '项目不存在');
          }
          store.activeProjectId = body.projectId;
          saveStore(store);
          return store.activeProjectId;
        });
        sendJson(res, 200, { activeProjectId });
        return;
      }

      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && req.method === 'PATCH') {
        const projectId = decodeURIComponent(projectMatch[1]);
        const body = await readJsonBody(req);
        const payload = await withStoreLock(() => {
          const current = loadStore();
          const project = current.projects.find((p) => p.id === projectId);
          if (!project) {
            throw new HttpError(404, '项目不存在');
          }
          if (typeof body.name === 'string' && body.name.trim()) {
            project.name = body.name.trim();
          }
          if (typeof body.defaultToolId === 'string' && body.defaultToolId.trim()) {
            project.defaultToolId = body.defaultToolId.trim();
          }
          if (body.worktreeTools && typeof body.worktreeTools === 'object') {
            project.worktreeTools = { ...(project.worktreeTools || {}), ...body.worktreeTools };
          }
          saveStore(current);
          return { project, store: current };
        });
        sendJson(res, 200, payload);
        return;
      }
      if (projectMatch && req.method === 'DELETE') {
        const projectId = decodeURIComponent(projectMatch[1]);
        const store = await withStoreLock(() => {
          const current = loadStore();
          removeProject(current, projectId);
          return saveStore(current);
        });
        sendJson(res, 200, { store });
        return;
      }

      const wsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (wsMatch && req.method === 'DELETE') {
        const wsId = decodeURIComponent(wsMatch[1]);
        const store = await withStoreLock(() => {
          const current = loadStore();
          removeWorkspace(current, wsId);
          return saveStore(current);
        });
        sendJson(res, 200, { store });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/general-config') {
        const body = await readJsonBody(req);
        const generalConfig = await withStoreLock(() => {
          const store = loadStore();
          const prevAutoStart = Boolean(store.generalConfig?.autoStart);
          const nextAutoStart =
            typeof body.autoStart === 'boolean' ? body.autoStart : prevAutoStart;
          const nextTerminal =
            typeof body.preferredTerminal === 'string' && body.preferredTerminal.trim()
              ? body.preferredTerminal.trim()
              : store.generalConfig?.preferredTerminal || '';

          if (typeof body.autoStart === 'boolean') {
            setAutoStartEnabled(nextAutoStart);
          }

          store.generalConfig = {
            autoStart: nextAutoStart,
            preferredTerminal: nextTerminal,
          };
          saveStore(store);
          return store.generalConfig;
        });
        sendJson(res, 200, {
          generalConfig,
          terminals: getSupportedTerminals(),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai-config') {
        const body = await readJsonBody(req);
        const aiConfig = await withStoreLock(() => {
          const store = loadStore();
          store.aiConfig = {
            url: typeof body.url === 'string' ? body.url.trim() : '',
            key: typeof body.key === 'string' ? body.key.trim() : '',
            model: typeof body.model === 'string' ? body.model.trim() : '',
          };
          saveStore(store);
          return store.aiConfig;
        });
        sendJson(res, 200, { aiConfig });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ai-models') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const url = typeof body.url === 'string' ? body.url.trim() : store.aiConfig?.url || '';
        const key = typeof body.key === 'string' ? body.key.trim() : store.aiConfig?.key || '';
        try {
          const models = await fetchAiModels({ url, key });
          sendJson(res, 200, { models });
        } catch (err) {
          sendJson(res, 400, { error: err?.message || String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tools') {
        const body = await readJsonBody(req);
        if (
          typeof body.name !== 'string' ||
          !body.name.trim() ||
          typeof body.command !== 'string' ||
          !body.command.trim()
        ) {
          sendJson(res, 400, { error: '工具名称和命令不能为空' });
          return;
        }
        const payload = await withStoreLock(() => {
          const store = loadStore();
          const toolId =
            typeof body.id === 'string' && body.id.trim()
              ? body.id.trim()
              : `custom_${randomUUID().slice(0, 6)}`;
          const isBuiltin = BUILTIN_TOOLS.some((t) => t.id === toolId);
          const existingTool = getAllTools(store.customTools).find((t) => t.id === toolId);
          const tool = {
            id: toolId,
            name: body.name.trim(),
            kind: body.kind === 'gui' ? 'gui' : 'cli',
            command: body.command.trim(),
            args: Array.isArray(body.args)
              ? body.args.map((a) => String(a))
              : typeof body.args === 'string' && body.args.trim()
                ? body.args.trim().split(/\s+/)
                : [],
            supportsPrompt:
              typeof body.supportsPrompt === 'boolean'
                ? body.supportsPrompt
                : existingTool
                  ? Boolean(existingTool.supportsPrompt)
                  : false,
            description:
              typeof body.description === 'string' && body.description.trim()
                ? body.description.trim()
                : isBuiltin
                  ? existingTool?.description || '内置工具（已编辑）'
                  : '自定义工具',
            custom: !isBuiltin,
          };
          const idx = store.customTools.findIndex((t) => t.id === tool.id);
          if (idx >= 0) store.customTools[idx] = tool;
          else store.customTools.push(tool);
          saveStore(store);
          return { tool, tools: getAllTools(store.customTools) };
        });
        sendJson(res, 200, payload);
        return;
      }

      const toolMatch = pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (toolMatch && req.method === 'DELETE') {
        const toolId = decodeURIComponent(toolMatch[1]);
        if (BUILTIN_TOOLS.some((t) => t.id === toolId)) {
          sendJson(res, 400, { error: '内置工具不可删除' });
          return;
        }
        const tools = await withStoreLock(() => {
          const store = loadStore();
          store.customTools = store.customTools.filter((t) => t.id !== toolId);
          saveStore(store);
          return getAllTools(store.customTools);
        });
        sendJson(res, 200, { tools });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/worktrees') {
        const projectId = url.searchParams.get('projectId');
        const includeBranches = url.searchParams.get('branches') !== '0';
        const full = url.searchParams.get('full') === '1';

        const store = loadStore();
        const project = store.projects.find((p) => p.id === (projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '未选择项目' });
          return;
        }
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        if (!env.wtBin) {
          sendJson(res, 503, { error: env.issues.join(' '), env });
          return;
        }

        const args = ['list', '--config-set', 'list.json-schema=2', '--format=json'];
        if (includeBranches) {
          args.push('--branches');
        } else {
          args.push('--config-set', 'list.branches=false');
        }
        if (full) args.push('--full');

        const result = await runWt(env.wtBin, project.path, args);
        const parsed = parseWtJson(result.stdout);
        // Schema 2 natively includes `worktree.operation`; only fall back to Git probing for Schema 1.
        if (parsed?.schema !== 2 && Array.isArray(parsed?.items)) {
          await Promise.all(
            parsed.items.map(async (item) => {
              if (item?.worktree?.path && !item.worktree.operation) {
                const op = await getWorktreeInProgressOp(item.worktree.path);
                if (op) {
                  item.worktree.operation = op;
                }
              }
            })
          );
        }
        sendJson(res, result.ok ? 200 : 422, {
          ok: result.ok,
          project,
          command: result.command,
          data: parsed,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/worktrees/switch') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        if (!body.branch || !String(body.branch).trim()) {
          sendJson(res, 400, { error: '请填写分支名称' });
          return;
        }
        const branch = String(body.branch).trim();
        if (!isValidBranchName(branch)) {
          sendJson(res, 400, { error: '分支名称格式无效' });
          return;
        }
        const base = body.base ? String(body.base).trim() : '';
        if (base && !isValidBranchName(base)) {
          sendJson(res, 400, { error: '基于分支名称格式无效' });
          return;
        }
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        if (!env.wtBin) {
          sendJson(res, 503, { error: env.issues.join(' '), env });
          return;
        }

        const create = Boolean(body.create);
        const noHooks = Boolean(body.noHooks);
        const approvalGate = await resolveApprovalGate({
          wtBin: env.wtBin,
          repoPath: project.path,
          approveHooks: Boolean(body.approveHooks),
          skipHooks: noHooks,
          phases: create ? ['pre-switch', 'post-switch', 'pre-start', 'post-start'] : ['pre-switch', 'post-switch'],
        });
        if (!approvalGate.allowed) {
          sendJson(res, 409, {
            ok: false,
            approvalRequired: true,
            unapprovedCommands: approvalGate.unapprovedCommands,
            error: '项目中存在未批准的 Worktrunk hook 命令，需要确认后执行。',
          });
          return;
        }

        const resolvedToolId = body.toolId || project.worktreeTools?.[branch] || project.defaultToolId || 'claude';
        const tool = findToolById(resolvedToolId, store.customTools);
        const result = await switchAndOpenWorktree({
          wtBin: env.wtBin,
          repoPath: project.path,
          branch,
          create,
          clobber: Boolean(body.clobber),
          base,
          tool,
          prompt: body.prompt ? String(body.prompt).trim() : '',
          preferredTerminal: store.generalConfig?.preferredTerminal || '',
          passYes: approvalGate.passYes,
          noHooks,
        });

        let worktreeTools = project.worktreeTools || {};
        if (result.ok && tool?.id) {
          worktreeTools = await withStoreLock(() => {
            const freshStore = loadStore();
            const freshProj = freshStore.projects.find((p) => p.id === project.id);
            if (!freshProj) return project.worktreeTools || {};
            if (!freshProj.worktreeTools || typeof freshProj.worktreeTools !== 'object') {
              freshProj.worktreeTools = {};
            }
            if (body.toolId || !freshProj.worktreeTools[branch]) {
              freshProj.worktreeTools[branch] = tool.id;
              saveStore(freshStore);
            }
            return freshProj.worktreeTools;
          });
        }

        sendJson(res, result.ok ? 200 : 422, {
          ...result,
          toolId: tool?.id || null,
          worktreeTools,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/worktrees/merge') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        if (!body.branch) {
          sendJson(res, 400, { error: '请指定要合并的分支' });
          return;
        }
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        if (!env.wtBin) {
          sendJson(res, 503, { error: env.issues.join(' '), env });
          return;
        }

        const mergeOptions = {
          target: body.target ? String(body.target).trim() : '',
          branch: String(body.branch).trim(),
          noSquash: Boolean(body.noSquash),
          noCommit: Boolean(body.noCommit),
          noRebase: Boolean(body.noRebase),
          noRemove: Boolean(body.noRemove),
          noFf: Boolean(body.noFf),
          noHooks: Boolean(body.noHooks),
        };
        const mergePhases = mergeOptions.noRemove
          ? ['pre-commit', 'post-commit', 'pre-merge', 'post-merge']
          : ['pre-commit', 'post-commit', 'pre-merge', 'post-merge', 'pre-remove', 'post-remove'];
        const approvalGate = await resolveApprovalGate({
          wtBin: env.wtBin,
          repoPath: project.path,
          approveHooks: Boolean(body.approveHooks),
          skipHooks: mergeOptions.noHooks,
          phases: mergePhases,
        });
        if (!approvalGate.allowed) {
          sendJson(res, 409, {
            ok: false,
            approvalRequired: true,
            unapprovedCommands: approvalGate.unapprovedCommands,
            error: '项目中存在未批准的 Worktrunk hook 命令，需要确认后执行。',
          });
          return;
        }

        const args = buildWtMergeArgs(mergeOptions, { includeYes: approvalGate.passYes });
        const result = await runWt(env.wtBin, project.path, args, { timeout: 120_000 });
        const parsed = parseWtJson(result.stdout);
        let conflictInfo = { hasConflicts: false, conflictSession: null };
        let finalOk = result.ok;
        let finalCmd = result.command;
        let finalStdout = result.stdout;
        let finalStderr = result.stderr;

        let pushFailed = null;
        if (!result.ok) {
          conflictInfo = await detectOrStartLocalConflictSession(project.path, {
            sourceBranch: mergeOptions.branch,
            targetBranch: mergeOptions.target,
            noFf: mergeOptions.noFf,
            noSquash: mergeOptions.noSquash,
            noRebase: mergeOptions.noRebase,
            wtOutput: `${result.stdout || ''}\n${result.stderr || ''}`,
            wtBin: env.wtBin,
            wtMergeOptions: mergeOptions,
          });
          if (conflictInfo.conflictSession) {
            conflictInfo.conflictSession.autoPush = Boolean(body.autoPush);
          }
        } else {
          if (!mergeOptions.noRemove) {
            await cleanupWorktreeTools(project.id, [mergeOptions.branch]);
          }
          if (body.autoPush) {
            const pushRes = await pushWorktreeBranch(project.path, {
              branch: mergeOptions.target,
            });
            finalOk = pushRes.ok;
            finalCmd = `${result.command} && ${pushRes.command}`;
            finalStdout = [result.stdout, pushRes.stdout].filter(Boolean).join('\n');
            finalStderr = [result.stderr, pushRes.stderr].filter(Boolean).join('\n');
            if (!pushRes.ok) {
              pushFailed = {
                workDir: pushRes.workDir,
                branch: pushRes.branch || mergeOptions.target,
                nonFastForward: Boolean(pushRes.nonFastForward),
                command: pushRes.command,
                stdout: pushRes.stdout,
                stderr: pushRes.stderr,
              };
            }
          }
        }
        sendJson(res, finalOk ? 200 : 422, {
          ok: finalOk,
          command: finalCmd,
          data: parsed,
          stdout: finalStdout,
          stderr: finalStderr,
          ...conflictInfo,
          ...(pushFailed ? { pushFailed } : {}),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/worktrees/remove') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        if (!body.branch) {
          sendJson(res, 400, { error: '请指定要移除的分支或路径' });
          return;
        }
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        if (!env.wtBin) {
          sendJson(res, 503, { error: env.issues.join(' '), env });
          return;
        }

        const targetBranch = String(body.branch).trim();
        const noHooks = Boolean(body.noHooks);
        const approvalGate = await resolveApprovalGate({
          wtBin: env.wtBin,
          repoPath: project.path,
          approveHooks: Boolean(body.approveHooks),
          skipHooks: noHooks,
          phases: ['pre-remove', 'post-remove'],
        });
        if (!approvalGate.allowed) {
          sendJson(res, 409, {
            ok: false,
            approvalRequired: true,
            unapprovedCommands: approvalGate.unapprovedCommands,
            error: '项目中存在未批准的 Worktrunk hook 命令，需要确认后执行。',
          });
          return;
        }

        const args = ['remove', targetBranch, '--foreground', '--format=json'];
        if (body.noDeleteBranch) {
          args.push('--no-delete-branch');
        } else {
          args.push('--config-set', 'remove.delete-branch=true');
        }
        if (body.force) args.push('--force');
        if (body.forceDelete) args.push('-D');
        if (noHooks) args.push('--no-hooks');
        if (approvalGate.passYes) args.push('-y');

        const result = await runWt(env.wtBin, project.path, args);
        const parsed = parseWtJson(result.stdout);
        const itemResult = Array.isArray(parsed) ? parsed[0] : parsed;
        const outcome = itemResult?.branch_outcome;
        let worktreeTools = project.worktreeTools || {};
        if (result.ok) {
          const exactKeys =
            outcome === 'deleted' || outcome === 'not_attempted'
              ? [targetBranch, itemResult?.branch].filter(Boolean)
              : [];
          worktreeTools = await cleanupWorktreeTools(project.id, exactKeys, itemResult?.path || '');
        }
        sendJson(res, result.ok ? 200 : 422, {
          ok: result.ok,
          command: result.command,
          data: parsed,
          stdout: result.stdout,
          stderr: result.stderr,
          worktreeTools,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/worktrees/pull') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, body.workDir || '');
        const result = await pullWorktreeBranch(project.path, {
          workDir,
          branch: body.branch ? String(body.branch).trim() : '',
          autoPush: Boolean(body.autoPush),
        });
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/worktrees/push') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, body.workDir || '');
        const result = await pushWorktreeBranch(project.path, {
          workDir,
          branch: body.branch ? String(body.branch).trim() : '',
          forceWithLease: Boolean(body.forceWithLease),
        });
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/conflicts/status') {
        const projectId = url.searchParams.get('projectId');
        const requestedWorkDir = url.searchParams.get('workDir') || '';
        const trackedRaw = url.searchParams.get('tracked') || '';
        const trackedFiles = trackedRaw ? trackedRaw.split('|').filter(Boolean) : [];

        const store = loadStore();
        const project = store.projects.find((p) => p.id === (projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '未选择项目' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, requestedWorkDir);
        const status = await getConflictStatus(workDir, trackedFiles);
        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/conflicts/file') {
        const projectId = url.searchParams.get('projectId');
        const requestedWorkDir = url.searchParams.get('workDir') || '';
        const filePath = url.searchParams.get('file') || '';

        const store = loadStore();
        const project = store.projects.find((p) => p.id === (projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '未选择项目' });
          return;
        }
        if (!filePath) {
          sendJson(res, 400, { error: '请提供冲突文件路径' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, requestedWorkDir);
        const file = await readConflictFileDetails(workDir, filePath);
        sendJson(res, 200, { ok: true, file });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/conflicts/resolve') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        if (!body.filePath) {
          sendJson(res, 400, { error: '请提供冲突文件路径' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, body.workDir);
        const result = await resolveConflictFile(workDir, {
          filePath: body.filePath,
          content: body.content,
          strategy: body.strategy,
          hunkIndex: body.hunkIndex,
          hunkChoice: body.hunkChoice,
          stage: body.stage,
          trackedFiles: Array.isArray(body.trackedFiles) ? body.trackedFiles : [],
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/conflicts/complete') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, body.workDir);
        const env = await checkEnvironment({ wtBin: explicitWtBin }).catch(() => ({ wtBin: '' }));
        const result = await completeConflictMerge(workDir, {
          sourceBranch: body.sourceBranch,
          targetBranch: body.targetBranch,
          autoPush: Boolean(body.autoPush),
          wtBin: env?.wtBin || '',
          repoPath: project.path,
          wtMergeOptions: body.wtMergeOptions || null,
        });
        if (result.ok && result.resumedWtMerge && body.wtMergeOptions?.branch && !body.wtMergeOptions?.noRemove) {
          await cleanupWorktreeTools(project.id, [body.wtMergeOptions.branch]);
        }
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/conflicts/ai-complete') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = requireProject(store, body.projectId);
        const workDir = await resolveProjectWorkDir(project, body.workDir);
        const env = await checkEnvironment({ wtBin: explicitWtBin }).catch(() => ({ wtBin: '' }));
        const trackedFiles = Array.isArray(body.trackedFiles) ? body.trackedFiles : [];
        const wantsStream = Boolean(body.stream) || String(req.headers.accept || '').includes('text/event-stream');

        const runAiMerge = async (onProgress) => {
          const result = await aiResolveAndCompleteConflictMerge(workDir, {
            sourceBranch: body.sourceBranch,
            targetBranch: body.targetBranch,
            autoPush: Boolean(body.autoPush),
            wtBin: env?.wtBin || '',
            repoPath: project.path,
            wtMergeOptions: body.wtMergeOptions || null,
            trackedFiles,
            aiConfig: store.aiConfig,
            onProgress,
          });
          if (result.ok && result.resumedWtMerge && body.wtMergeOptions?.branch && !body.wtMergeOptions?.noRemove) {
            await cleanupWorktreeTools(project.id, [body.wtMergeOptions.branch]);
          }
          return result;
        };

        if (wantsStream) {
          res.setTimeout?.(0);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          let closed = false;
          req.on('close', () => {
            closed = true;
          });
          const sendEvent = (payload) => {
            if (!closed && !res.writableEnded) {
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
            }
          };
          try {
            const result = await runAiMerge((ev) => sendEvent(ev));
            if (result.ok) {
              sendEvent({ type: 'done', result });
            } else {
              sendEvent({
                type: 'error',
                error: result.stderr || result.stdout || '完成合并提交失败',
                result,
                status: result.status,
              });
            }
          } catch (err) {
            const status = await getConflictStatus(workDir, trackedFiles).catch(() => null);
            sendEvent({
              type: 'error',
              error: err?.message || String(err),
              status,
            });
          } finally {
            if (!res.writableEnded) res.end();
          }
          return;
        }

        try {
          const result = await runAiMerge();
          sendJson(res, result.ok ? 200 : 422, result);
        } catch (err) {
          const status = await getConflictStatus(workDir, trackedFiles).catch(() => null);
          sendJson(res, 422, {
            ok: false,
            error: err?.message || String(err),
            status,
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/conflicts/abort') {
        const body = await readJsonBody(req);
        const store = loadStore();
        const project = store.projects.find((p) => p.id === (body.projectId || store.activeProjectId));
        if (!project) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        const workDir = await resolveProjectWorkDir(project, body.workDir);
        const result = await abortConflictMerge(workDir);
        sendJson(res, result.ok ? 200 : 422, result);
        return;
      }

      sendJson(res, 404, { error: `Unknown API route: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 500, { error: err?.message || String(err) });
    }
  });

  return server;
}

async function resolveProjectWorkDir(project, requestedWorkDir) {
  const projRoot = resolve(project.path);
  if (!requestedWorkDir) return projRoot;
  const candidate = resolve(requestedWorkDir);
  if (samePath(candidate, projRoot)) return candidate;

  const worktrees = await listGitWorktrees(projRoot);
  const matched = worktrees.find((wt) => samePath(resolve(wt.path), candidate));
  if (matched) return resolve(matched.path);

  throw new HttpError(403, `目标工作树目录不属于当前项目: ${requestedWorkDir}`);
}

