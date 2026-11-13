import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { hostname as osHostname } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkEnvironment, invalidateEnvironmentCache, parseWtJson, runWt } from './wt-resolver.js';
import { autoInstallWorktrunk } from './wt-installer.js';
import { browsePath, inspectGitRepo, parseCodeWorkspace, pickNativePath } from './workspace.js';
import {
  addStandaloneProject,
  importWorkspaceProjects,
  loadStore,
  removeProject,
  removeWorkspace,
  saveStore,
} from './store.js';
import { BUILTIN_TOOLS, findToolById, getAllTools, switchAndOpenWorktree } from './tools.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

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

function isAllowedHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h)) return true; // DNS rebinding needs a domain name, IP literals are safe
  return h === hostname_().toLowerCase();
}

function hostname_() {
  try {
    return osHostname();
  } catch {
    return '';
  }
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

function serveStatic(reqPath, res) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  let decoded;
  try {
    decoded = decodeURIComponent(cleanPath);
  } catch {
    sendJson(res, 400, { error: 'Bad path' });
    return;
  }
  const target = resolve(PUBLIC_DIR, `.${decoded}`);
  const inside = target === PUBLIC_DIR || target.startsWith(PUBLIC_DIR + sep);
  if (!inside || !existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const ext = extname(target);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(readFileSync(target));
}

export function createAppServer({ wtBin: explicitWtBin } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    try {
      if (!pathname.startsWith('/api/')) {
        serveStatic(pathname, res);
        return;
      }

      if (!checkRequestOrigin(req)) {
        sendJson(res, 403, { error: 'Forbidden: cross-origin or untrusted Host header' });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/health') {
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        sendJson(res, 200, env);
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
          tools: getAllTools(store.customTools),
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
        if (!body.path) {
          sendJson(res, 400, { error: '请提供项目文件夹路径' });
          return;
        }
        const gitInfo = await inspectGitRepo(body.path);
        if (!gitInfo.isGitRepo) {
          sendJson(res, 400, { error: `该目录不是 Git 仓库: ${body.path}` });
          return;
        }
        const store = loadStore();
        const project = addStandaloneProject(store, {
          name: body.name,
          path: gitInfo.rootPath || body.path,
          defaultToolId: body.defaultToolId,
        });
        saveStore(store);
        sendJson(res, 200, { project, store });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workspaces/import') {
        const body = await readJsonBody(req);
        if (!body.workspaceFile) {
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
        const store = loadStore();
        const imported = importWorkspaceProjects(store, wsData);
        saveStore(store);
        sendJson(res, 200, {
          workspace: imported.workspace,
          importedProjects: imported.projects,
          skippedCount: wsData.projects.length - gitCount,
          store,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/active-project') {
        const body = await readJsonBody(req);
        const store = loadStore();
        if (!store.projects.some((p) => p.id === body.projectId)) {
          sendJson(res, 404, { error: '项目不存在' });
          return;
        }
        store.activeProjectId = body.projectId;
        saveStore(store);
        sendJson(res, 200, { activeProjectId: store.activeProjectId });
        return;
      }

      const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        const store = loadStore();
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req);
          const proj = store.projects.find((p) => p.id === projectId);
          if (!proj) {
            sendJson(res, 404, { error: '项目不存在' });
            return;
          }
          if (body.name !== undefined) proj.name = body.name;
          if (body.defaultToolId !== undefined) proj.defaultToolId = body.defaultToolId;
          saveStore(store);
          sendJson(res, 200, { project: proj });
          return;
        }
        if (req.method === 'DELETE') {
          removeProject(store, projectId);
          saveStore(store);
          sendJson(res, 200, { store });
          return;
        }
      }

      const wsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (wsMatch && req.method === 'DELETE') {
        const wsId = decodeURIComponent(wsMatch[1]);
        const store = loadStore();
        removeWorkspace(store, wsId);
        saveStore(store);
        sendJson(res, 200, { store });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/tools') {
        const body = await readJsonBody(req);
        if (!body.name || !body.command) {
          sendJson(res, 400, { error: '工具名称和命令不能为空' });
          return;
        }
        const store = loadStore();
        const isBuiltin = BUILTIN_TOOLS.some((t) => t.id === body.id);
        const tool = {
          id: body.id || `custom_${randomUUID().slice(0, 6)}`,
          name: body.name.trim(),
          kind: body.kind === 'gui' ? 'gui' : 'cli',
          command: body.command.trim(),
          args: Array.isArray(body.args)
            ? body.args
            : typeof body.args === 'string' && body.args.trim()
              ? body.args.trim().split(/\s+/)
              : [],
          description: body.description || (isBuiltin ? '内置工具（已编辑）' : '自定义工具'),
          custom: !isBuiltin,
        };
        const idx = store.customTools.findIndex((t) => t.id === tool.id);
        if (idx >= 0) store.customTools[idx] = tool;
        else store.customTools.push(tool);
        saveStore(store);
        sendJson(res, 200, { tool, tools: getAllTools(store.customTools) });
        return;
      }

      const toolMatch = pathname.match(/^\/api\/tools\/([^/]+)$/);
      if (toolMatch && req.method === 'DELETE') {
        const toolId = decodeURIComponent(toolMatch[1]);
        if (BUILTIN_TOOLS.some((t) => t.id === toolId)) {
          sendJson(res, 400, { error: '内置工具不可删除' });
          return;
        }
        const store = loadStore();
        store.customTools = store.customTools.filter((t) => t.id !== toolId);
        saveStore(store);
        sendJson(res, 200, { tools: getAllTools(store.customTools) });
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

        const args = ['list', '--format=json'];
        if (includeBranches) args.push('--branches');
        if (full) args.push('--full');

        const result = await runWt(env.wtBin, project.path, args);
        const parsed = parseWtJson(result.stdout);
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
        const env = await checkEnvironment({ wtBin: explicitWtBin });
        if (!env.wtBin) {
          sendJson(res, 503, { error: env.issues.join(' '), env });
          return;
        }

        const tool = findToolById(body.toolId || project.defaultToolId || 'claude', store.customTools);
        const result = await switchAndOpenWorktree({
          wtBin: env.wtBin,
          repoPath: project.path,
          branch: String(body.branch).trim(),
          create: Boolean(body.create),
          clobber: Boolean(body.clobber),
          base: body.base ? String(body.base).trim() : '',
          tool,
          prompt: body.prompt ? String(body.prompt).trim() : '',
        });

        sendJson(res, result.ok ? 200 : 422, result);
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

        const args = ['merge'];
        if (body.target) args.push(String(body.target).trim());
        args.push('--branch', String(body.branch).trim());
        if (body.noSquash) args.push('--no-squash');
        if (body.noCommit) args.push('--no-commit');
        if (body.noRebase) args.push('--no-rebase');
        if (body.noRemove) args.push('--no-remove');
        if (body.noFf) args.push('--no-ff');
        if (body.noHooks) args.push('--no-hooks');
        args.push('--format=json', '-y');

        const result = await runWt(env.wtBin, project.path, args, { timeout: 120_000 });
        const parsed = parseWtJson(result.stdout);
        sendJson(res, result.ok ? 200 : 422, {
          ok: result.ok,
          command: result.command,
          data: parsed,
          stdout: result.stdout,
          stderr: result.stderr,
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

        const args = ['remove', String(body.branch).trim(), '--foreground', '--format=json', '-y'];
        if (body.force) args.push('--force');
        if (body.forceDelete) args.push('-D');
        if (body.noDeleteBranch) args.push('--no-delete-branch');

        const result = await runWt(env.wtBin, project.path, args);
        const parsed = parseWtJson(result.stdout);
        sendJson(res, result.ok ? 200 : 422, {
          ok: result.ok,
          command: result.command,
          data: parsed,
          stdout: result.stdout,
          stderr: result.stderr,
        });
        return;
      }

      sendJson(res, 404, { error: `Unknown API route: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, err instanceof HttpError ? err.status : 500, { error: err?.message || String(err) });
    }
  });

  return server;
}

