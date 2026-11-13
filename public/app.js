import { getLang, setLang, t, applyStaticI18n, MESSAGES } from '/i18n.js';

const OPEN_TABS_KEY = 'wt_ui_open_tabs';

const state = {
  env: null,
  workspaces: [],
  projects: [],
  tools: [],
  openTabIds: [],
  worktreeCache: {},
  activeProjectId: null,
  worktreeData: null,
  browseCurrentPath: '',
  browseParentPath: null,
  mergeTargetBranch: null,
  mergeAllMode: false,
};

function loadOpenTabs() {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOpenTabs() {
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(state.openTabIds));
  } catch {
    // Ignore storage errors
  }
}

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.stderr || t('requestFailed', { status: res.status }));
    err.payload = data;
    throw err;
  }
  return data;
}

function showToast(message, type = 'info') {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function appendLog(title, details = '') {
  const logEl = $('command-log');
  const time = new Date().toLocaleTimeString();
  const block = `[${time}] ${title}${details ? `\n${details}` : ''}`;
  const isInitial = logEl.textContent === MESSAGES.zh.waitingAction || logEl.textContent === MESSAGES.en.waitingAction;
  const prev = isInitial ? '' : `${logEl.textContent}\n\n`;
  logEl.textContent = `${prev}${block}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModal(id) {
  $(id).classList.add('hidden');
}

function getActiveProject() {
  return state.projects.find((p) => p.id === state.activeProjectId) || null;
}

function getToolById(toolId) {
  return state.tools.find((t) => t.id === toolId) || null;
}

let isAutoInstalling = false;

async function triggerAutoInstallWt() {
  if (isAutoInstalling) return;
  isAutoInstalling = true;
  const badge = $('env-badge');
  const btn = $('btn-auto-install-wt');
  if (btn) btn.disabled = true;
  badge.className = 'env-badge env-warn';
  badge.textContent = t('autoInstallingBadge');
  showToast(t('autoInstallingToast'), 'info');
  try {
    const res = await api('/api/wt/install', { method: 'POST' });
    state.env = res.env;
    renderEnv(false);
    appendLog(t('autoInstallSuccessLog'), (res.installResult?.logs || []).join('\n'));
    showToast(t('autoInstallSuccessToast'), 'success');
    if (state.env?.ok) {
      closeModal('modal-install');
    }
    await refreshWorktrees();
  } catch (err) {
    const logs = err.payload?.installResult?.logs || [];
    appendLog(t('autoInstallFailLog'), [err.message, ...logs].join('\n'));
    showToast(t('autoInstallFailToast', { msg: err.message }), 'error');
    renderInstallGuide();
    openModal('modal-install');
  } finally {
    isAutoInstalling = false;
    if (btn) btn.disabled = false;
  }
}

function renderEnv(autoOpenGuide = false) {
  const badge = $('env-badge');
  const banner = $('env-banner');
  const bannerText = $('env-banner-text');
  if (!state.env) return;

  const wtVal = (state.env.wtVersion || '').replace(/^wt\s+/i, '') || (state.env.wtBin ? 'ready' : t('notInstalled'));
  const gitVal = (state.env.gitVersion || '').replace(/^git\s+version\s+/i, '') || t('notInstalled');
  const wtCls = state.env.wtBin ? 'env-ok' : 'env-warn';
  const gitCls = state.env.gitSupported ? 'env-ok' : 'env-warn';

  badge.className = 'env-badge';
  badge.innerHTML = `
    <span class="env-tag ${wtCls}" title="${escapeHtml(state.env.wtBin || 'Worktrunk')}">
      <span class="env-tag-key">wt</span>
      <span class="env-tag-val">${escapeHtml(wtVal)}</span>
    </span>
    <span class="env-tag ${gitCls}" title="${escapeHtml(state.env.gitVersion || 'Git')}">
      <span class="env-tag-key">git</span>
      <span class="env-tag-val">${escapeHtml(gitVal)}</span>
    </span>
  `;

  if (state.env.ok) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    bannerText.textContent = t('envCheckNotice', { issues: state.env.issues.join(' | ') });
    renderInstallGuide();
    if (autoOpenGuide && !state.env.wtBin) {
      triggerAutoInstallWt();
    }
  }
}

function renderInstallGuide() {
  const body = $('install-guide-body');
  const env = state.env;
  if (!env || !env.installGuide) return;

  const sections = [];
  if (!env.wtBin) {
    sections.push(`<p>${t('installGuideWtMissing')}</p>`);
    for (const opt of env.installGuide.wtOptions) {
      sections.push(`
        <div class="install-option">
          <strong>${escapeHtml(opt.label)}</strong>
          <div class="install-cmd-row">
            <code class="cmd-preview">${escapeHtml(opt.command)}</code>
            <button class="btn btn-secondary btn-sm btn-copy-cmd" data-cmd="${escapeHtml(opt.command)}">${escapeHtml(t('copyCommand'))}</button>
          </div>
          ${opt.note ? `<span class="muted">${escapeHtml(opt.note)}</span>` : ''}
        </div>
      `);
    }
  }

  if (!env.gitSupported) {
    sections.push(`
      <div class="install-option">
        <strong>${escapeHtml(t('gitUpgradeTitle', { version: env.gitVersion || t('unknown') }))}</strong>
        <div class="install-cmd-row">
          <code class="cmd-preview">${escapeHtml(env.installGuide.gitUpgradeCommand)}</code>
          <button class="btn btn-secondary btn-sm btn-copy-cmd" data-cmd="${escapeHtml(env.installGuide.gitUpgradeCommand)}">${escapeHtml(t('copyCommand'))}</button>
        </div>
      </div>
    `);
  }

  if (env.ok) {
    sections.push(`<p>${escapeHtml(t('envReadyText'))}</p>`);
  }

  sections.push(
    `<p class="muted">${escapeHtml(t('officialDocs'))}<a href="${escapeHtml(env.installGuide.docsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(env.installGuide.docsUrl)}</a></p>`
  );

  body.innerHTML = sections.join('');
  body.querySelectorAll('.btn-copy-cmd').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.getAttribute('data-cmd');
      try {
        await navigator.clipboard.writeText(cmd);
        showToast(t('copiedToClipboard'), 'success');
      } catch {
        showToast(t('copyManually', { cmd }), 'info');
      }
    });
  });
}

function renderToolSelects() {
  const grouped = {
    cli: state.tools.filter((t) => t.kind === 'cli'),
    gui: state.tools.filter((t) => t.kind === 'gui'),
  };

  const buildOptions = (selectEl, selectedId) => {
    selectEl.innerHTML = '';
    const groups = [
      { label: t('cliToolsGroup'), items: grouped.cli },
      { label: t('guiToolsGroup'), items: grouped.gui },
    ];
    for (const g of groups) {
      if (g.items.length === 0) continue;
      const optGroup = document.createElement('optgroup');
      optGroup.label = g.label;
      for (const tool of g.items) {
        const opt = document.createElement('option');
        opt.value = tool.id;
        opt.textContent = `${tool.name}${tool.command ? ` (${tool.command})` : ''}`;
        if (tool.id === selectedId) opt.selected = true;
        optGroup.appendChild(opt);
      }
      selectEl.appendChild(optGroup);
    }
  };

  const selectEl = $('select-tool');
  const currentToolId = selectEl.value || 'claude';
  buildOptions(selectEl, currentToolId);
  updateCommandPreview();
}

function updateCommandPreview() {
  const previewEl = $('cmd-preview');
  if (!previewEl) return;
  const branch = $('input-branch').value.trim() || 'feat-auth';
  const base = $('input-base').value.trim();
  const create = $('input-create').checked;
  const toolId = $('select-tool').value;
  const tool = getToolById(toolId);

  const parts = ['wt', 'switch'];
  if (create) parts.push('-c');
  parts.push(branch);
  if (base) parts.push('--base', base);

  if (tool && tool.kind === 'gui' && tool.command) {
    parts.push('--no-cd', '-x', tool.command);
    if (tool.args && tool.args.length > 0) {
      parts.push('--', ...tool.args);
    }
  } else if (tool && tool.kind === 'cli' && tool.command) {
    parts.push('-x', tool.command);
    const extra = [...(tool.args || [])];
    if (extra.length > 0) parts.push('--', ...extra);
  }

  $('cmd-preview').textContent = parts.join(' ');
}

function renderSidebar() {
  const tree = $('project-tree');
  tree.innerHTML = '';

  if (state.projects.length === 0) {
    tree.innerHTML = `<div class="empty-hint">${escapeHtml(t('emptySidebarHint'))}</div>`;
    return;
  }

  const createProjectNode = (proj) => {
    const item = document.createElement('div');
    item.className = `project-item${proj.id === state.activeProjectId ? ' active' : ''}`;
    item.innerHTML = `
      <div class="project-item-info">
        <div class="project-item-name">${escapeHtml(proj.name)}</div>
        <div class="project-item-path" title="${escapeHtml(proj.path)}">${escapeHtml(proj.path)}</div>
      </div>
      ${proj.workspaceId ? '' : `<button class="btn-icon" title="${escapeHtml(t('removeProjectTitle'))}">✕</button>`}
    `;
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectProject(proj.id);
    });
    const delBtn = item.querySelector('button');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteProject(proj.id);
      });
    }
    return item;
  };

  for (const ws of state.workspaces) {
    const wsProjects = state.projects.filter((p) => p.workspaceId === ws.id);
    if (wsProjects.length === 0) continue;
    const group = document.createElement('div');
    group.className = 'ws-group';
    const header = document.createElement('div');
    header.className = 'ws-header';
    header.innerHTML = `
      <span class="ws-name" title="${escapeHtml(ws.workspaceFile)}">${escapeHtml(t('workspacePrefix', { name: ws.name }))}</span>
      <button class="btn-icon" title="${escapeHtml(t('removeWorkspaceTitle'))}">✕</button>
    `;
    header.querySelector('button').addEventListener('click', async () => {
      await deleteWorkspace(ws.id);
    });
    group.appendChild(header);
    for (const p of wsProjects) {
      group.appendChild(createProjectNode(p));
    }
    tree.appendChild(group);
  }

  const standalone = state.projects.filter((p) => !p.workspaceId);
  for (const p of standalone) {
    tree.appendChild(createProjectNode(p));
  }
}

function renderTabs() {
  const bar = $('project-tabs');
  bar.innerHTML = '';

  const openProjects = state.openTabIds
    .map((id) => state.projects.find((p) => p.id === id))
    .filter(Boolean);

  if (openProjects.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  for (const proj of openProjects) {
    const ws = proj.workspaceId ? state.workspaces.find((w) => w.id === proj.workspaceId) : null;
    const tab = document.createElement('div');
    tab.className = `project-tab${proj.id === state.activeProjectId ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', proj.id === state.activeProjectId ? 'true' : 'false');
    tab.title = proj.path;
    tab.innerHTML = `
      <span class="project-tab-name">${escapeHtml(proj.name)}</span>
      ${ws ? `<span class="project-tab-ws">${escapeHtml(ws.name)}</span>` : ''}
      <button class="project-tab-close" title="${escapeHtml(t('closeTabTitle'))}" aria-label="${escapeHtml(t('closeTabAria', { name: proj.name }))}">✕</button>
    `;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.project-tab-close')) return;
      selectProject(proj.id);
    });
    tab.querySelector('.project-tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(proj.id);
    });
    bar.appendChild(tab);
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function generateRandomBranchName(baseBranch) {
  const base = (baseBranch || $('input-base')?.value.trim() || getMainWorktreeBranch(state.worktreeData) || 'main')
    .replace(/\s+/g, '-');
  return `${base}_${formatTimestamp()}`;
}

function getMainWorktreeBranch(worktreeData) {
  const items = worktreeData?.items || [];
  const mainItem = items.find((item) => item.worktree?.main && item.branch);
  return mainItem?.branch || worktreeData?.repo?.default_branch || 'main';
}

function applyAutoBranchName(baseBranch, force = false) {
  const branchInput = $('input-branch');
  if (!branchInput) return;
  const prevAuto = branchInput.dataset.autoValue || '';
  if (force || !branchInput.value.trim() || branchInput.value.trim() === prevAuto) {
    const generated = generateRandomBranchName(baseBranch);
    branchInput.value = generated;
    branchInput.dataset.autoValue = generated;
  }
}

function applyDefaultBranchToBaseInput(baseBranch, force = false) {
  const baseSelect = $('input-base');
  if (!baseSelect) return;

  const items = state.worktreeData?.items || [];
  const defaultBranch = state.worktreeData?.repo?.default_branch || 'main';
  const mainBranch = getMainWorktreeBranch(state.worktreeData);

  const branchNames = [];
  const addBranch = (b) => {
    if (b && !branchNames.includes(b)) branchNames.push(b);
  };
  addBranch(mainBranch);
  for (const item of items) {
    if (item.branch) addBranch(item.branch);
  }
  addBranch(defaultBranch);
  addBranch(baseBranch);

  const prevVal = baseSelect.value;
  const prevAuto = baseSelect.dataset.autoValue || '';
  baseSelect.innerHTML = '';

  for (const branch of branchNames) {
    const opt = document.createElement('option');
    opt.value = branch;
    const tags = [];
    if (branch === mainBranch && items.some((i) => i.worktree?.main && i.branch === branch)) {
      tags.push(t('mainWorktreeTag'));
    }
    if (branch === defaultBranch) {
      tags.push(t('defaultBranchTag'));
    }
    opt.textContent = tags.length > 0 ? `${branch} (${tags.join(' / ')})` : branch;
    baseSelect.appendChild(opt);
  }

  if (!force && prevVal && prevVal !== prevAuto && branchNames.includes(prevVal)) {
    baseSelect.value = prevVal;
  } else {
    baseSelect.value = baseBranch;
    baseSelect.dataset.autoValue = baseBranch;
  }
}

function renderMainProject() {
  renderTabs();
  const active = getActiveProject();
  if (!active || !state.openTabIds.includes(active.id)) {
    $('no-project-state').classList.remove('hidden');
    $('project-view').classList.add('hidden');
    return;
  }

  $('no-project-state').classList.add('hidden');
  $('project-view').classList.remove('hidden');

  const baseBranch = getMainWorktreeBranch(state.worktreeData);
  applyDefaultBranchToBaseInput(baseBranch, true);
  applyAutoBranchName(baseBranch, true);

  renderToolSelects();
}

function renderWorktrees() {
  const tbody = $('worktree-tbody');
  tbody.innerHTML = '';

  const items = state.worktreeData?.items || [];
  const defaultBranch = state.worktreeData?.repo?.default_branch || 'main';
  const mainBranch = getMainWorktreeBranch(state.worktreeData);
  applyDefaultBranchToBaseInput(mainBranch, false);
  applyAutoBranchName($('input-base').value.trim() || mainBranch, false);
  updateCommandPreview();
  $('wt-count').textContent = String(items.length);
  const mergeAllBtn = $('btn-merge-all');
  if (mergeAllBtn) {
    mergeAllBtn.classList.toggle('hidden', getMergeableWorktreeBranches().length === 0);
  }

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(t('noWorktreeData'))}</td></tr>`;
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');
    const branchName = item.branch || item.head?.short_sha || '(detached)';
    const wt = item.worktree;
    const hasWorktree = Boolean(wt);
    const isMain = Boolean(wt?.main);
    const gutter = wt?.current ? '@' : wt?.main ? '^' : wt ? '+' : '/';

    // Status pills
    const pills = [];
    if (item.branch && item.branch === defaultBranch) pills.push(`<span class="badge badge-success">${escapeHtml(t('defaultBranchTag'))}</span>`);
    if (isMain) pills.push(`<span class="badge badge-info">${escapeHtml(t('mainWorktreeTag'))}</span>`);
    if (!hasWorktree) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('noWorktreeTag'))}</span>`);
    if (wt?.changes?.conflicted) pills.push(`<span class="badge badge-danger">${escapeHtml(t('conflictTag'))}</span>`);
    if (wt?.changes?.staged) pills.push(`<span class="badge badge-success">${escapeHtml(t('stagedTag'))}</span>`);
    if (wt?.changes?.modified) pills.push(`<span class="badge badge-warn">${escapeHtml(t('modifiedTag'))}</span>`);
    if (wt?.changes?.untracked) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('untrackedTag'))}</span>`);
    if (wt?.operation) pills.push(`<span class="badge badge-warn">${escapeHtml(wt.operation)} ↻</span>`);

    // Divergence
    const db = item.default_branch;
    const divParts = [];
    if (db) {
      if (db.ahead || db.behind) {
        divParts.push(`<span>↑${db.ahead ?? 0} ↓${db.behind ?? 0}</span>`);
      }
      if (db.diff && (db.diff.added || db.diff.deleted)) {
        divParts.push(`<span class="mono">+${db.diff.added} -${db.diff.deleted}</span>`);
      }
      if (db.integration) {
        divParts.push(`<span class="badge badge-success">${escapeHtml(t('mergedTag', { reason: db.integration.reason }))}</span>`);
      }
      if (db.merge_conflicts) {
        divParts.push(`<span class="badge badge-danger">${escapeHtml(t('mergeConflictRisk'))}</span>`);
      }
    } else if (isMain || item.branch === defaultBranch) {
      divParts.push(`<span class="muted">${escapeHtml(t('baseBranchTag'))}</span>`);
    }

    const commitHtml = item.head
      ? `<div><span class="mono">${escapeHtml(item.head.short_sha)}</span> ${escapeHtml(item.head.subject || '')}</div>`
      : '<span class="muted">-</span>';

    const pathHtml = wt?.path
      ? `<span class="mono">${escapeHtml(wt.path)}</span>`
      : '<span class="muted">—</span>';

    const selectedTool = getToolById($('select-tool').value || 'claude');
    const openLabel = hasWorktree ? t('openWithTool', { tool: selectedTool?.name || t('toolFallback') }) : t('createAndOpen');

    tr.innerHTML = `
      <td>
        <div class="branch-cell">
          <div class="branch-main">
            <span class="gutter-symbol">${gutter}</span>
            <strong>${escapeHtml(branchName)}</strong>
          </div>
          <div class="status-pills">${pills.join('')}</div>
        </div>
      </td>
      <td><div class="status-pills">${divParts.join(' ') || `<span class="muted">${escapeHtml(t('noDiff'))}</span>`}</div></td>
      <td>${commitHtml}</td>
      <td>${pathHtml}</td>
      <td class="col-actions">
        <div class="actions-cell">
          <button class="btn btn-secondary btn-sm btn-open-wt">${escapeHtml(openLabel)}</button>
          ${
            hasWorktree && !isMain && item.branch
              ? `<button class="btn btn-success btn-sm btn-merge-wt">${escapeHtml(t('oneClickMerge'))}</button>`
              : ''
          }
          ${
            hasWorktree && !isMain
              ? `<button class="btn btn-danger-ghost btn-sm btn-remove-wt">${escapeHtml(t('removeBtn'))}</button>`
              : ''
          }
        </div>
      </td>
    `;

    tr.querySelector('.btn-open-wt').addEventListener('click', () => {
      openWorktreeRow(branchName, !hasWorktree);
    });

    const mergeBtn = tr.querySelector('.btn-merge-wt');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => openMergeModal(item.branch));
    }

    const removeBtn = tr.querySelector('.btn-remove-wt');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => removeWorktreeRow(item.branch || wt.path));
    }

    tbody.appendChild(tr);
  }
}

async function loadHealth(autoOpenGuide = false) {
  state.env = await api('/api/health');
  renderEnv(autoOpenGuide);
}

async function loadState() {
  const data = await api('/api/state');
  state.workspaces = data.workspaces;
  state.projects = data.projects;
  state.tools = data.tools;
  state.activeProjectId = data.activeProjectId;

  const validIds = new Set(state.projects.map((p) => p.id));
  const savedTabs = (state.openTabIds.length > 0 ? state.openTabIds : loadOpenTabs()).filter((id) =>
    validIds.has(id)
  );
  if (state.activeProjectId && validIds.has(state.activeProjectId) && !savedTabs.includes(state.activeProjectId)) {
    savedTabs.push(state.activeProjectId);
  } else if (savedTabs.length > 0 && (!state.activeProjectId || !savedTabs.includes(state.activeProjectId))) {
    state.activeProjectId = savedTabs[0];
  }
  state.openTabIds = savedTabs;
  saveOpenTabs();

  renderSidebar();
  renderMainProject();
  renderToolsModalList();
}

async function refreshWorktrees() {
  const active = getActiveProject();
  if (!active || !state.openTabIds.includes(active.id)) return;
  const branches = $('toggle-branches').checked ? '1' : '0';
  try {
    const res = await api(`/api/worktrees?projectId=${encodeURIComponent(active.id)}&branches=${branches}`);
    state.worktreeCache[active.id] = res.data;
    if (state.activeProjectId === active.id) {
      state.worktreeData = res.data;
      renderWorktrees();
    }
  } catch (err) {
    if (state.activeProjectId === active.id) {
      state.worktreeData = null;
      renderWorktrees();
    }
    appendLog(t('fetchWorktreesFail'), err.payload?.stderr || err.message);
  }
}

async function selectProject(projectId) {
  if (!state.openTabIds.includes(projectId)) {
    state.openTabIds.push(projectId);
    saveOpenTabs();
  }
  state.activeProjectId = projectId;
  state.worktreeData = state.worktreeCache[projectId] || null;
  renderSidebar();
  renderMainProject();
  if (state.worktreeData) {
    renderWorktrees();
  }
  await api('/api/active-project', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
  await refreshWorktrees();
}

async function closeTab(projectId) {
  const idx = state.openTabIds.indexOf(projectId);
  if (idx === -1) return;
  state.openTabIds.splice(idx, 1);
  saveOpenTabs();

  if (state.activeProjectId === projectId) {
    const nextId = state.openTabIds[idx] || state.openTabIds[idx - 1] || null;
    if (nextId) {
      await selectProject(nextId);
      return;
    }
    state.activeProjectId = null;
    state.worktreeData = null;
  }
  renderSidebar();
  renderMainProject();
}

async function deleteProject(projectId) {
  await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  await loadState();
  await refreshWorktrees();
}

async function deleteWorkspace(wsId) {
  await api(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' });
  await loadState();
  await refreshWorktrees();
}

async function openWorktreeRow(branch, shouldCreate) {
  const active = getActiveProject();
  if (!active) return;
  const toolId = $('select-tool').value || 'claude';
  try {
    const res = await api('/api/worktrees/switch', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        branch,
        create: shouldCreate,
        toolId,
      }),
    });
    appendLog(t('logExec', { cmd: res.command }), res.stdout || res.stderr || t('openedFallback'));
    showToast(t('openedWorktreeToast', { branch }), 'success');
    await refreshWorktrees();
  } catch (err) {
    appendLog(t('logFail', { target: err.payload?.command || branch }), err.payload?.stderr || err.message);
    showToast(err.message, 'error');
  }
}

function populateMergeTargetSelect(sourceBranch) {
  const selectEl = $('merge-target');
  if (!selectEl) return;

  const items = state.worktreeData?.items || [];
  const defaultBranch = state.worktreeData?.repo?.default_branch || 'main';
  const mainBranch = getMainWorktreeBranch(state.worktreeData);

  const branchNames = [];
  const addBranch = (b) => {
    if (b && b !== sourceBranch && !branchNames.includes(b)) branchNames.push(b);
  };
  addBranch(mainBranch);
  for (const item of items) {
    if (item.branch) addBranch(item.branch);
  }
  addBranch(defaultBranch);

  selectEl.innerHTML = '';
  for (const branch of branchNames) {
    const opt = document.createElement('option');
    opt.value = branch;
    const tags = [];
    if (branch === mainBranch && items.some((i) => i.worktree?.main && i.branch === branch)) {
      tags.push(t('mainWorktreeTag'));
    }
    if (branch === defaultBranch) {
      tags.push(t('defaultBranchTag'));
    }
    opt.textContent = tags.length > 0 ? `${branch} (${tags.join(' / ')})` : branch;
    selectEl.appendChild(opt);
  }

  if (mainBranch && branchNames.includes(mainBranch)) {
    selectEl.value = mainBranch;
  } else if (branchNames.length > 0) {
    selectEl.value = branchNames[0];
  }
}

function getMergeableWorktreeBranches(targetBranch = '') {
  const items = state.worktreeData?.items || [];
  return items
    .filter((item) => item.worktree && !item.worktree.main && item.branch && item.branch !== targetBranch)
    .map((item) => item.branch);
}

function openMergeModal(branch) {
  state.mergeAllMode = false;
  state.mergeTargetBranch = branch;
  const titleEl = $('modal-merge-title');
  if (titleEl) titleEl.textContent = t('mergeModalTitle');
  populateMergeTargetSelect(branch);
  $('merge-no-squash').checked = false;
  $('merge-no-rebase').checked = false;
  $('merge-no-ff').checked = false;
  $('merge-no-remove').checked = false;
  $('merge-no-hooks').checked = false;
  openModal('modal-merge');
}

function openMergeAllModal() {
  if (getMergeableWorktreeBranches().length === 0) {
    showToast(t('noMergeableBranchesToast'), 'info');
    return;
  }
  state.mergeAllMode = true;
  state.mergeTargetBranch = null;
  const titleEl = $('modal-merge-title');
  if (titleEl) titleEl.textContent = t('mergeAllModalTitle');
  populateMergeTargetSelect('');
  $('merge-no-squash').checked = false;
  $('merge-no-rebase').checked = false;
  $('merge-no-ff').checked = false;
  $('merge-no-remove').checked = false;
  $('merge-no-hooks').checked = false;
  openModal('modal-merge');
}

async function confirmMerge() {
  const active = getActiveProject();
  if (!active || (!state.mergeAllMode && !state.mergeTargetBranch)) return;
  const btn = $('btn-confirm-merge');
  const origLabel = btn.textContent;
  const target = $('merge-target').value.trim();
  const commonOptions = {
    projectId: active.id,
    target,
    noSquash: $('merge-no-squash').checked,
    noRebase: $('merge-no-rebase').checked,
    noFf: $('merge-no-ff').checked,
    noRemove: $('merge-no-remove').checked,
    noHooks: $('merge-no-hooks').checked,
  };

  if (!state.mergeAllMode) {
    btn.disabled = true;
    try {
      const res = await api('/api/worktrees/merge', {
        method: 'POST',
        body: JSON.stringify({ ...commonOptions, branch: state.mergeTargetBranch }),
      });
      appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      showToast(t('mergeSuccessToast', { branch: state.mergeTargetBranch }), 'success');
      closeModal('modal-merge');
      await refreshWorktrees();
    } catch (err) {
      appendLog(t('mergeFailLog', { cmd: err.payload?.command || '' }), err.payload?.stderr || err.message);
      showToast(t('mergeFailToast', { msg: err.payload?.stderr || err.message }), 'error');
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const branches = getMergeableWorktreeBranches(target);
  if (branches.length === 0) {
    showToast(t('noMergeableBranchesToast'), 'info');
    closeModal('modal-merge');
    return;
  }

  btn.disabled = true;
  let done = 0;
  try {
    for (const branch of branches) {
      btn.textContent = t('mergingProgressBtn', { done: done + 1, total: branches.length });
      try {
        const res = await api('/api/worktrees/merge', {
          method: 'POST',
          body: JSON.stringify({ ...commonOptions, branch }),
        });
        done += 1;
        appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      } catch (err) {
        const msg = err.payload?.stderr || err.message;
        appendLog(t('mergeFailLog', { cmd: err.payload?.command || branch }), msg);
        showToast(t('mergeAllPartialFailToast', { done, total: branches.length, branch, msg }), 'error');
        await refreshWorktrees();
        return;
      }
    }
    closeModal('modal-merge');
    showToast(t('mergeAllSuccessToast', { count: done, target: target || getMainWorktreeBranch(state.worktreeData) }), 'success');
    await refreshWorktrees();
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

async function removeWorktreeRow(branch) {
  const active = getActiveProject();
  if (!active) return;
  try {
    const res = await api('/api/worktrees/remove', {
      method: 'POST',
      body: JSON.stringify({ projectId: active.id, branch }),
    });
    appendLog(t('removeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('removedToast', { branch }), 'success');
    await refreshWorktrees();
  } catch (err) {
    const stderr = err.payload?.stderr || err.message;
    appendLog(t('removeFailLog', { cmd: err.payload?.command || '' }), stderr);
    const force = window.confirm(t('forceRemoveConfirm', { stderr }));
    if (!force) return;
    try {
      const res2 = await api('/api/worktrees/remove', {
        method: 'POST',
        body: JSON.stringify({ projectId: active.id, branch, force: true, forceDelete: true }),
      });
      appendLog(t('forceRemoveSuccessLog', { cmd: res2.command }), res2.stdout || res2.stderr);
      showToast(t('forceRemovedToast', { branch }), 'success');
      await refreshWorktrees();
    } catch (err2) {
      showToast(err2.payload?.stderr || err2.message, 'error');
    }
  }
}

// Browser modal
async function browseTo(path = '') {
  try {
    const res = await api(`/api/fs/browse?path=${encodeURIComponent(path)}`);
    state.browseCurrentPath = res.currentPath;
    state.browseParentPath = res.parentPath;
    $('input-browse-path').value = res.currentPath;
    renderBrowserEntries(res.entries);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderBrowserEntries(entries) {
  const list = $('browser-list');
  list.innerHTML = '';
  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-hint">${escapeHtml(t('emptyDir'))}</div>`;
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'browser-entry';
    const icon = entry.type === 'workspace' ? '🧩' : entry.isGitRepo ? '📦' : '📁';
    row.innerHTML = `
      <div class="browser-entry-left">
        <span>${icon}</span>
        <span class="browser-entry-name">${escapeHtml(entry.name)}</span>
        ${entry.isGitRepo ? `<span class="badge badge-info">${escapeHtml(t('gitRepoBadge'))}</span>` : ''}
        ${entry.type === 'workspace' ? '<span class="badge badge-success">.code-workspace</span>' : ''}
      </div>
      ${
        entry.isGitRepo || entry.type === 'workspace'
          ? `<button class="btn btn-primary btn-sm">${escapeHtml(entry.type === 'workspace' ? t('importWorkspaceBtn') : t('selectProjectBtn'))}</button>`
          : ''
      }
    `;
    row.querySelector('.browser-entry-left').addEventListener('click', () => {
      if (entry.type === 'workspace') {
        addTargetPath(entry.path);
      } else {
        browseTo(entry.path);
      }
    });
    const pickBtn = row.querySelector('button');
    if (pickBtn) {
      pickBtn.addEventListener('click', () => addTargetPath(entry.path));
    }
    list.appendChild(row);
  }
}

async function addTargetPath(rawPath) {
  const target = (rawPath || '').trim();
  if (!target) {
    showToast(t('enterOrSelectPath'), 'error');
    return;
  }
  try {
    if (target.toLowerCase().endsWith('.code-workspace')) {
      const res = await api('/api/workspaces/import', {
        method: 'POST',
        body: JSON.stringify({ workspaceFile: target }),
      });
      showToast(t('importedWorkspaceToast', { name: res.workspace.name, count: res.importedProjects.length }), 'success');
    } else {
      const res = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: target }),
      });
      showToast(t('addedProjectToast', { name: res.project.name }), 'success');
    }
    closeModal('modal-browser');
    await loadState();
    await refreshWorktrees();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function resetToolForm() {
  $('tool-edit-id').value = '';
  $('custom-tool-form').reset();
  $('btn-tool-submit').textContent = t('addToolBtn');
  $('btn-cancel-tool-edit').classList.add('hidden');
  renderToolsModalList();
}

function startEditTool(tool) {
  $('tool-edit-id').value = tool.id;
  $('tool-name').value = tool.name;
  $('tool-kind').value = tool.kind;
  $('tool-cmd').value = tool.command;
  $('tool-args').value = (tool.args || []).join(' ');
  $('btn-tool-submit').textContent = t('saveChangesBtn');
  $('btn-cancel-tool-edit').classList.remove('hidden');
  renderToolsModalList();
}

function renderToolsModalList() {
  const container = $('tools-list');
  container.innerHTML = '';
  const editingId = $('tool-edit-id').value;

  const columns = [
    { title: t('cliToolsGroup'), items: state.tools.filter((t) => t.kind === 'cli') },
    { title: t('guiToolsGroup'), items: state.tools.filter((t) => t.kind === 'gui') },
  ];

  for (const col of columns) {
    const colEl = document.createElement('div');
    colEl.className = 'tools-column';
    const heading = document.createElement('h4');
    heading.className = 'tools-column-title';
    heading.textContent = `${col.title} (${col.items.length})`;
    colEl.appendChild(heading);

    const gridEl = document.createElement('div');
    gridEl.className = 'tools-grid';

    for (const tool of col.items) {
      const row = document.createElement('div');
      row.className = `tool-row${editingId === tool.id ? ' editing' : ''}`;
      row.title = t('clickToEditTool');
      row.innerHTML = `
        <div class="tool-row-info">
          <strong>${escapeHtml(tool.name)}</strong>
          <div class="mono muted">${escapeHtml(tool.command)} ${escapeHtml((tool.args || []).join(' '))}</div>
        </div>
        ${tool.custom ? `<button type="button" class="btn btn-danger-ghost btn-sm">${escapeHtml(t('deleteBtn'))}</button>` : ''}
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        startEditTool(tool);
      });
      const delBtn = row.querySelector('button');
      if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api(`/api/tools/${encodeURIComponent(tool.id)}`, { method: 'DELETE' });
          if ($('tool-edit-id').value === tool.id) {
            resetToolForm();
          }
          await loadState();
          showToast(t('deletedCustomToolToast'), 'success');
        });
      }
      gridEl.appendChild(row);
    }
    colEl.appendChild(gridEl);
    container.appendChild(colEl);
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindEvents() {
  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => closeModal(el.getAttribute('data-close')));
  });

  $('btn-add-target').addEventListener('click', () => {
    openModal('modal-browser');
    browseTo(state.browseCurrentPath);
  });
  $('btn-empty-add').addEventListener('click', () => {
    openModal('modal-browser');
    browseTo(state.browseCurrentPath);
  });

  $('btn-browse-up').addEventListener('click', () => {
    if (state.browseParentPath !== null) {
      browseTo(state.browseParentPath);
    }
  });
  $('input-browse-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      browseTo($('input-browse-path').value);
    }
  });
  $('btn-add-direct').addEventListener('click', () => addTargetPath($('input-browse-path').value));

  const pickNative = async (mode) => {
    try {
      const res = await api('/api/fs/pick', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      if (!res.cancelled && res.path) {
        await addTargetPath(res.path);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  $('btn-pick-folder').addEventListener('click', () => pickNative('folder'));
  $('btn-pick-workspace').addEventListener('click', () => pickNative('workspace'));

  $('btn-refresh').addEventListener('click', refreshWorktrees);
  $('btn-merge-all').addEventListener('click', openMergeAllModal);
  $('toggle-branches').addEventListener('change', refreshWorktrees);

  $('input-branch').addEventListener('input', updateCommandPreview);
  $('input-create').addEventListener('change', updateCommandPreview);
  $('select-tool').addEventListener('change', () => {
    updateCommandPreview();
    renderWorktrees();
  });

  $('btn-random-branch').addEventListener('click', () => {
    applyAutoBranchName($('input-base').value.trim(), true);
    updateCommandPreview();
  });

  $('input-base').addEventListener('change', () => {
    applyAutoBranchName($('input-base').value.trim(), false);
    updateCommandPreview();
  });

  $('switch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const active = getActiveProject();
    if (!active) return;
    const btn = $('btn-switch-submit');
    btn.disabled = true;
    try {
      const res = await api('/api/worktrees/switch', {
        method: 'POST',
        body: JSON.stringify({
          projectId: active.id,
          branch: $('input-branch').value.trim(),
          create: $('input-create').checked,
          base: $('input-base').value.trim(),
          toolId: $('select-tool').value,
        }),
      });
      appendLog(t('logExec', { cmd: res.command }), res.stdout || res.stderr || t('worktreePathLog', { path: res.worktreePath }));
      showToast(t('worktreeReadyToast'), 'success');
      applyAutoBranchName($('input-base').value.trim(), true);
      updateCommandPreview();
      await refreshWorktrees();
    } catch (err) {
      appendLog(t('logFail', { target: err.payload?.command || '' }), err.payload?.stderr || err.message);
      showToast(err.payload?.stderr || err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-confirm-merge').addEventListener('click', confirmMerge);

  $('btn-manage-tools').addEventListener('click', () => {
    resetToolForm();
    openModal('modal-tools');
  });
  $('btn-cancel-tool-edit').addEventListener('click', resetToolForm);
  $('custom-tool-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('tool-edit-id').value;
    await api('/api/tools', {
      method: 'POST',
      body: JSON.stringify({
        id: editId || undefined,
        name: $('tool-name').value,
        kind: $('tool-kind').value,
        command: $('tool-cmd').value,
        args: $('tool-args').value,
      }),
    });
    resetToolForm();
    await loadState();
    showToast(editId ? t('updatedToolToast') : t('addedToolToast'), 'success');
  });

  $('btn-open-install-guide').addEventListener('click', () => {
    renderInstallGuide();
    openModal('modal-install');
  });

  const recheckEnv = async () => {
    await loadHealth(false);
    renderInstallGuide();
    if (state.env?.ok) {
      closeModal('modal-install');
      showToast(t('envCheckPassToast'), 'success');
      await refreshWorktrees();
    } else {
      showToast(t('envCheckFailToast'), 'error');
    }
  };
  $('btn-recheck-env').addEventListener('click', recheckEnv);
  $('btn-modal-recheck').addEventListener('click', recheckEnv);
  $('btn-auto-install-wt').addEventListener('click', triggerAutoInstallWt);

  $('btn-clear-log').addEventListener('click', () => {
    $('command-log').textContent = t('waitingAction');
  });

  $('btn-lang-toggle').addEventListener('click', () => {
    const next = getLang() === 'zh' ? 'en' : 'zh';
    applyLanguage(next, true);
  });

  $('btn-theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light', true);
  });
}

function applyLanguage(lang, persist = true) {
  setLang(lang, persist);
  const logEl = $('command-log');
  if (logEl && (logEl.textContent === MESSAGES.zh.waitingAction || logEl.textContent === MESSAGES.en.waitingAction)) {
    logEl.textContent = t('waitingAction');
  }
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  applyTheme(theme, false);
  if (state.env) renderEnv(false);
  renderSidebar();
  renderMainProject();
  if (state.worktreeData) renderWorktrees();
  if ($('tool-edit-id').value) {
    $('btn-tool-submit').textContent = t('saveChangesBtn');
  } else {
    $('btn-tool-submit').textContent = t('addToolBtn');
  }
  renderToolsModalList();
}

function applyTheme(theme, persist = true) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  if (persist) {
    try {
      localStorage.setItem('wt-ui-theme', next);
    } catch {
      // ignore storage errors
    }
  }
  const btn = $('btn-theme-toggle');
  if (btn) {
    const label = next === 'light' ? t('themeLightTitle') : t('themeDarkTitle');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
}

function initTheme() {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  applyTheme(current, false);
}

async function init() {
  setLang(getLang(), false);
  const logEl = $('command-log');
  if (logEl && (logEl.textContent === MESSAGES.zh.waitingAction || logEl.textContent === MESSAGES.en.waitingAction)) {
    logEl.textContent = t('waitingAction');
  }
  initTheme();
  bindEvents();
  await Promise.all([loadHealth(true), loadState()]);
  await refreshWorktrees();
}

init().catch((err) => {
  showToast(err.message, 'error');
});

