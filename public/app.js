import { getLang, setLang, t, applyStaticI18n, MESSAGES } from '/i18n.js';

const OPEN_TABS_KEY = 'wt_ui_open_tabs';
const SIDEBAR_COLLAPSED_KEY = 'wt_ui_sidebar_collapsed';

const state = {
  env: null,
  appVersion: '0.1.0',
  workspaces: [],
  projects: [],
  tools: [],
  terminals: [],
  generalConfig: { autoStart: false, preferredTerminal: '' },
  aiConfig: { url: '', key: '', model: '' },
  activeSettingsTab: 'general',
  openTabIds: [],
  worktreeCache: {},
  remoteCache: {},
  activeProjectId: null,
  worktreeData: null,
  remoteData: null,
  branchMode: 'local',
  browseCurrentPath: '',
  browseParentPath: null,
  mergeTargetBranch: null,
  mergeAllMode: false,
  mergeIsRemote: false,
  conflictSession: null,
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

function getWorktreeTool(branchName) {
  const active = getActiveProject();
  const savedToolId = branchName ? active?.worktreeTools?.[branchName] : null;
  const toolId = savedToolId || active?.defaultToolId || 'claude';
  return getToolById(toolId) || getToolById('claude') || state.tools[0] || null;
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

function applyBranchModeUI() {
  const isRemote = state.branchMode === 'remote';
  const localBtn = $('btn-mode-local');
  const remoteBtn = $('btn-mode-remote');
  if (localBtn) {
    localBtn.classList.toggle('active', !isRemote);
    localBtn.setAttribute('aria-selected', !isRemote ? 'true' : 'false');
  }
  if (remoteBtn) {
    remoteBtn.classList.toggle('active', isRemote);
    remoteBtn.setAttribute('aria-selected', isRemote ? 'true' : 'false');
  }

  const titleEl = $('list-card-title');
  if (titleEl) {
    titleEl.dataset.i18n = isRemote ? 'remoteListTitle' : 'worktreeListTitle';
    titleEl.textContent = t(isRemote ? 'remoteListTitle' : 'worktreeListTitle');
  }

  $('local-branches-toggle-wrap')?.classList.toggle('hidden', isRemote);
  $('remote-hide-merged-wrap')?.classList.toggle('hidden', !isRemote);
  $('btn-fetch-remote')?.classList.toggle('hidden', !isRemote);

  const thBranch = $('th-branch');
  if (thBranch) {
    thBranch.dataset.i18n = isRemote ? 'colRemoteBranchStatus' : 'colBranchStatus';
    thBranch.textContent = t(isRemote ? 'colRemoteBranchStatus' : 'colBranchStatus');
  }
  const thDiff = $('th-diff');
  if (thDiff) {
    thDiff.dataset.i18n = isRemote ? 'colDiffTarget' : 'colDiffDefault';
    thDiff.textContent = t(isRemote ? 'colDiffTarget' : 'colDiffDefault');
  }
  const thPath = $('th-path');
  if (thPath) {
    thPath.dataset.i18n = isRemote ? 'colRemoteMeta' : 'colWorktreePath';
    thPath.textContent = t(isRemote ? 'colRemoteMeta' : 'colWorktreePath');
  }
}

async function setBranchMode(mode) {
  const next = mode === 'remote' ? 'remote' : 'local';
  const changed = state.branchMode !== next;
  state.branchMode = next;
  applyBranchModeUI();

  if (next === 'remote') {
    const active = getActiveProject();
    if (active && state.remoteCache[active.id]) {
      state.remoteData = state.remoteCache[active.id];
      renderWorktrees();
    } else {
      renderWorktrees();
    }
    if (changed) {
      await refreshRemoteBranches(!state.remoteCache[active?.id]);
    }
  } else {
    renderWorktrees();
    if (changed) {
      await refreshWorktrees();
    }
  }
}

function renderWorktrees() {
  applyBranchModeUI();
  if (state.branchMode === 'remote') {
    renderRemoteBranches();
    return;
  }

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
    const isDefault = Boolean(item.branch && item.branch === defaultBranch);
    const gutter = wt?.current ? '@' : wt?.main ? '^' : wt ? '+' : '/';

    // Status pills
    const pills = [];
    if (isDefault) pills.push(`<span class="badge badge-success">${escapeHtml(t('defaultBranchTag'))}</span>`);
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
    } else if (isMain || isDefault) {
      divParts.push(`<span class="muted">${escapeHtml(t('baseBranchTag'))}</span>`);
    }

    const commitHtml = item.head
      ? `<div><span class="mono">${escapeHtml(item.head.short_sha)}</span> ${escapeHtml(item.head.subject || '')}</div>`
      : '<span class="muted">-</span>';

    const pathHtml = wt?.path
      ? `<span class="mono">${escapeHtml(wt.path)}</span>`
      : '<span class="muted">—</span>';

    const boundTool = getWorktreeTool(branchName);
    const openLabel = hasWorktree ? t('openWithTool', { tool: boundTool?.name || t('toolFallback') }) : t('createAndOpen');
    const remoteAhead = item.remote?.ahead || 0;
    const pushLabel = remoteAhead > 0 ? t('pushBtnAhead', { ahead: remoteAhead }) : t('pushBtn');
    const pushBtnCls = remoteAhead > 0 ? 'btn-primary' : 'btn-secondary';

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
          ${
            wt?.changes?.conflicted && wt?.path
              ? `<button class="btn btn-primary btn-sm btn-resolve-conflict">${escapeHtml(t('resolveConflictBtn'))}</button>`
              : ''
          }
          ${
            hasWorktree && wt?.path
              ? `<button class="btn btn-secondary btn-sm btn-pull-wt">${escapeHtml(t('pullBtn'))}</button>
                 <button class="btn ${pushBtnCls} btn-sm btn-push-wt">${escapeHtml(pushLabel)}</button>`
              : ''
          }
          <button class="btn btn-secondary btn-sm btn-open-wt">${escapeHtml(openLabel)}</button>
          ${
            hasWorktree && !isMain && item.branch
              ? `<button class="btn btn-success btn-sm btn-merge-wt">${escapeHtml(t('oneClickMerge'))}</button>`
              : ''
          }
          ${
            !isMain && (hasWorktree || (!isDefault && item.branch))
              ? `<button class="btn btn-danger-ghost btn-sm btn-remove-wt">${escapeHtml(hasWorktree ? t('removeBtn') : t('deleteBtn'))}</button>`
              : ''
          }
        </div>
      </td>
    `;

    const resolveBtn = tr.querySelector('.btn-resolve-conflict');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', () => openExistingWorktreeConflictModal(wt.path, branchName));
    }

    const pullBtn = tr.querySelector('.btn-pull-wt');
    if (pullBtn) {
      pullBtn.addEventListener('click', () => pullWorktreeRow(wt.path, item.branch || branchName, pullBtn));
    }

    const pushBtn = tr.querySelector('.btn-push-wt');
    if (pushBtn) {
      pushBtn.addEventListener('click', () => pushWorktreeRow(wt.path, item.branch || branchName, pushBtn));
    }

    tr.querySelector('.btn-open-wt').addEventListener('click', () => {
      const toolId = hasWorktree ? boundTool?.id : ($('select-tool').value || 'claude');
      openWorktreeRow(branchName, false, '', toolId);
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

function renderRemoteBranches() {
  const tbody = $('worktree-tbody');
  tbody.innerHTML = '';

  const allItems = state.remoteData?.items || [];
  const hideMerged = $('toggle-hide-merged-remote')?.checked;
  const items = hideMerged ? allItems.filter((item) => !item.merged || item.isDefault || item.isTarget) : allItems;

  $('wt-count').textContent = String(items.length);
  const mergeAllBtn = $('btn-merge-all');
  if (mergeAllBtn) {
    mergeAllBtn.classList.toggle('hidden', getMergeableRemoteBranches().length === 0);
  }

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(t('noRemoteData'))}</td></tr>`;
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');
    const pills = [];
    if (item.isDefault) {
      pills.push(`<span class="badge badge-success">${escapeHtml(t('defaultBranchTag'))}</span>`);
    }
    if (item.ahead > 0) {
      pills.push(`<span class="badge badge-warn">${escapeHtml(t('remoteAheadBadge', { ahead: item.ahead }))}</span>`);
    } else if (item.merged) {
      pills.push(`<span class="badge badge-success">${escapeHtml(t('remoteMergedBadge'))}</span>`);
    }
    if (item.worktreePath) {
      pills.push(`<span class="badge badge-info">${escapeHtml(t('localWorktreeExistsBadge'))}</span>`);
    } else if (item.hasLocalBranch) {
      pills.push(`<span class="badge badge-neutral">${escapeHtml(t('localBranchExistsBadge'))}</span>`);
    }

    const divParts = [];
    if (item.isDefault || item.isTarget) {
      divParts.push(`<span class="muted">${escapeHtml(t('baseBranchTag'))}</span>`);
    } else {
      if (item.ahead || item.behind) {
        divParts.push(`<span>↑${item.ahead ?? 0} ↓${item.behind ?? 0}</span>`);
      }
      if (item.diff && (item.diff.added || item.diff.deleted)) {
        divParts.push(`<span class="mono">+${item.diff.added} -${item.diff.deleted}</span>`);
      }
    }

    const commitHtml = item.head?.short_sha
      ? `<div><span class="mono">${escapeHtml(item.head.short_sha)}</span> ${escapeHtml(item.head.subject || '')}</div>`
      : '<span class="muted">-</span>';

    const metaParts = [`<span class="badge badge-neutral">${escapeHtml(item.remote)}</span>`];
    if (item.head?.author) {
      metaParts.push(`<span class="muted">${escapeHtml(item.head.author)}</span>`);
    }

    const boundTool = getWorktreeTool(item.branch);
    const openLabel = item.worktreePath
      ? t('openWithTool', { tool: boundTool?.name || t('toolFallback') })
      : t('checkoutWorktreeBtn');

    tr.innerHTML = `
      <td>
        <div class="branch-cell">
          <div class="branch-main">
            <span class="gutter-symbol">☁</span>
            <strong>${escapeHtml(item.fullRef)}</strong>
          </div>
          <div class="status-pills">${pills.join('')}</div>
        </div>
      </td>
      <td><div class="status-pills">${divParts.join(' ') || `<span class="muted">${escapeHtml(t('noDiff'))}</span>`}</div></td>
      <td>${commitHtml}</td>
      <td><div class="status-pills">${metaParts.join(' ')}</div></td>
      <td class="col-actions">
        <div class="actions-cell">
          ${
            !item.isDefault
              ? `<button class="btn btn-success btn-sm btn-merge-remote">${escapeHtml(t('oneClickMerge'))}</button>`
              : ''
          }
          <button class="btn btn-secondary btn-sm btn-checkout-remote">${escapeHtml(openLabel)}</button>
          ${
            !item.isDefault
              ? `<button class="btn btn-danger-ghost btn-sm btn-delete-remote">${escapeHtml(t('deleteBtn'))}</button>`
              : ''
          }
        </div>
      </td>
    `;

    const mergeBtn = tr.querySelector('.btn-merge-remote');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => openRemoteMergeModal(item.fullRef));
    }

    tr.querySelector('.btn-checkout-remote').addEventListener('click', () => {
      const shouldCreate = !item.hasLocalBranch && !item.worktreePath;
      const toolId = item.worktreePath ? boundTool?.id : ($('select-tool').value || 'claude');
      openWorktreeRow(item.branch, shouldCreate, shouldCreate ? item.fullRef : '', toolId);
    });

    const delBtn = tr.querySelector('.btn-delete-remote');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteRemoteBranchRow(item.fullRef));
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
  state.appVersion = data.appVersion || state.appVersion || '0.1.0';
  state.workspaces = data.workspaces;
  state.projects = data.projects;
  state.tools = data.tools;
  state.terminals = data.terminals || [];
  state.generalConfig = {
    autoStart: Boolean(data.generalConfig?.autoStart),
    preferredTerminal: data.generalConfig?.preferredTerminal || '',
  };
  state.aiConfig = {
    url: data.aiConfig?.url || '',
    key: data.aiConfig?.key || '',
    model: data.aiConfig?.model || '',
  };
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
  renderGeneralSettingsForm();
  renderAiConfigForm();
  renderToolsModalList();
  renderAboutPane();
}

async function refreshWorktrees() {
  const active = getActiveProject();
  if (!active || !state.openTabIds.includes(active.id)) return;
  const branches = $('toggle-branches').checked ? '1' : '0';
  try {
    const res = await api(`/api/worktrees?projectId=${encodeURIComponent(active.id)}&branches=${branches}`);
    if (res.project?.worktreeTools) {
      active.worktreeTools = res.project.worktreeTools;
    }
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

async function refreshRemoteBranches(fetchRemote = false) {
  const active = getActiveProject();
  if (!active || !state.openTabIds.includes(active.id)) return;
  const fetchBtn = $('btn-fetch-remote');
  if (fetchRemote && fetchBtn) {
    fetchBtn.disabled = true;
    fetchBtn.textContent = t('fetchingRemoteBtn');
  }
  try {
    const fetchParam = fetchRemote ? '&fetch=1' : '';
    const res = await api(`/api/remote/branches?projectId=${encodeURIComponent(active.id)}${fetchParam}`);
    state.remoteCache[active.id] = res.data;
    if (state.activeProjectId === active.id) {
      state.remoteData = res.data;
      renderWorktrees();
    }
    if (fetchRemote && res.data?.fetchCommand) {
      const out = [res.data.fetchStdout, res.data.fetchStderr].filter(Boolean).join('\n');
      if (res.data.fetchOk) {
        appendLog(t('fetchRemoteSuccessLog', { cmd: res.data.fetchCommand }), out);
        showToast(t('fetchRemoteSuccessToast'), 'success');
      } else {
        appendLog(t('fetchRemoteWarnLog', { cmd: res.data.fetchCommand }), out);
      }
    }
  } catch (err) {
    if (state.activeProjectId === active.id) {
      state.remoteData = null;
      renderWorktrees();
    }
    appendLog(t('fetchRemoteFail'), err.payload?.stderr || err.message);
  } finally {
    if (fetchBtn) {
      fetchBtn.disabled = false;
      fetchBtn.textContent = t('fetchRemoteBtn');
    }
  }
}

async function refreshCurrentList() {
  if (state.branchMode === 'remote') {
    await refreshRemoteBranches(false);
  } else {
    await refreshWorktrees();
  }
}

async function selectProject(projectId) {
  if (!state.openTabIds.includes(projectId)) {
    state.openTabIds.push(projectId);
    saveOpenTabs();
  }
  state.activeProjectId = projectId;
  state.worktreeData = state.worktreeCache[projectId] || null;
  state.remoteData = state.remoteCache[projectId] || null;
  renderSidebar();
  renderMainProject();
  renderWorktrees();
  await api('/api/active-project', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
  await refreshWorktrees();
  if (state.branchMode === 'remote') {
    await refreshRemoteBranches(!state.remoteCache[projectId]);
  }
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
    state.remoteData = null;
  }
  renderSidebar();
  renderMainProject();
}

async function deleteProject(projectId) {
  await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  await loadState();
  await refreshCurrentList();
}

async function deleteWorkspace(wsId) {
  await api(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' });
  await loadState();
  await refreshCurrentList();
}

async function switchWorktreeWithClobberPrompt(payload) {
  try {
    return await api('/api/worktrees/switch', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const stderr = err.payload?.stderr || err.message || '';
    if (!payload.clobber && /directory already exists|--clobber/i.test(stderr)) {
      appendLog(t('logFail', { target: err.payload?.command || payload.branch }), stderr);
      if (window.confirm(t('clobberConfirm', { stderr }))) {
        return api('/api/worktrees/switch', {
          method: 'POST',
          body: JSON.stringify({ ...payload, clobber: true }),
        });
      }
      err.clobberCancelled = true;
    }
    throw err;
  }
}

async function openWorktreeRow(branch, shouldCreate, base = '', explicitToolId = '') {
  const active = getActiveProject();
  if (!active) return;
  const toolId = explicitToolId || getWorktreeTool(branch)?.id || 'claude';
  try {
    const res = await switchWorktreeWithClobberPrompt({
      projectId: active.id,
      branch,
      create: shouldCreate,
      base,
      toolId,
    });
    if (res.worktreeTools) {
      active.worktreeTools = res.worktreeTools;
    }
    appendLog(t('logExec', { cmd: res.command }), res.stdout || res.stderr || t('openedFallback'));
    showToast(t('openedWorktreeToast', { branch }), 'success');
    await Promise.all([
      refreshWorktrees(),
      state.branchMode === 'remote' ? refreshRemoteBranches(false) : Promise.resolve(),
    ]);
  } catch (err) {
    if (!err.clobberCancelled) {
      appendLog(t('logFail', { target: err.payload?.command || branch }), err.payload?.stderr || err.message);
    }
    showToast(err.payload?.stderr || err.message, 'error');
  }
}

async function pullWorktreeRow(workDir, branch, btnEl) {
  const active = getActiveProject();
  if (!active || !workDir) return;
  const origLabel = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = t('pullingBtn');
  }
  try {
    const res = await api('/api/worktrees/pull', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir,
        branch,
      }),
    });
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n');
    appendLog(t('pullSuccessLog', { cmd: res.command }), out);
    showToast(t('pullSuccessToast', { branch }), 'success');
    await Promise.all([
      refreshWorktrees(),
      state.remoteCache[active.id] ? refreshRemoteBranches(false) : Promise.resolve(),
    ]);
  } catch (err) {
    const out = [err.payload?.stdout, err.payload?.stderr].filter(Boolean).join('\n') || err.message;
    appendLog(t('pullFailLog', { cmd: err.payload?.command || '' }), out);
    if (err.payload?.hasConflicts && err.payload?.conflictSession) {
      showToast(t('conflictDetectedToast'), 'info');
      await openConflictModal(err.payload.conflictSession);
      await refreshWorktrees();
    } else {
      showToast(t('pullFailToast', { msg: err.payload?.stderr || err.message }), 'error');
    }
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = origLabel || t('pullBtn');
    }
  }
}

async function pushWorktreeRow(workDir, branch, btnEl) {
  const active = getActiveProject();
  if (!active || !workDir) return;
  const origLabel = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = t('pushingBtn');
  }
  try {
    const res = await api('/api/worktrees/push', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir,
        branch,
      }),
    });
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n');
    appendLog(t('pushSuccessLog', { cmd: res.command }), out);
    showToast(t('pushSuccessToast', { branch }), 'success');
    await Promise.all([
      refreshWorktrees(),
      state.remoteCache[active.id] ? refreshRemoteBranches(false) : Promise.resolve(),
    ]);
  } catch (err) {
    const out = [err.payload?.stdout, err.payload?.stderr].filter(Boolean).join('\n') || err.message;
    appendLog(t('pushFailLog', { cmd: err.payload?.command || '' }), out);
    showToast(t('pushFailToast', { msg: err.payload?.stderr || err.message }), 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = origLabel || t('pushBtn');
    }
  }
}

function populateMergeTargetSelect(sourceBranch) {
  const selectEl = $('merge-target');
  if (!selectEl) return;

  const items = state.worktreeData?.items || [];
  const remoteLocalBranches = state.remoteData?.localBranches || [];
  const defaultBranch =
    state.worktreeData?.repo?.default_branch || state.remoteData?.defaultBranch || 'main';
  const mainBranch = state.remoteData?.targetBranch || getMainWorktreeBranch(state.worktreeData);

  const shortSource = String(sourceBranch || '').replace(/^[^/]+\//, '');
  const branchNames = [];
  const addBranch = (b) => {
    if (b && b !== sourceBranch && b !== shortSource && !branchNames.includes(b)) branchNames.push(b);
  };
  addBranch(mainBranch);
  for (const item of items) {
    if (item.branch) addBranch(item.branch);
  }
  for (const b of remoteLocalBranches) {
    addBranch(b);
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

function getMergeableRemoteBranches(targetBranch = '') {
  const items = state.remoteData?.items || [];
  const defaultBranch = state.remoteData?.defaultBranch || 'main';
  const effectiveTarget = targetBranch || state.remoteData?.targetBranch || defaultBranch;
  return items
    .filter(
      (item) =>
        !item.isDefault &&
        item.branch !== effectiveTarget &&
        item.fullRef !== effectiveTarget &&
        item.ahead > 0
    )
    .map((item) => item.fullRef);
}

function configureMergeModalMode(isRemote, summaryText = '') {
  state.mergeIsRemote = Boolean(isRemote);
  $('local-merge-options')?.classList.toggle('hidden', state.mergeIsRemote);
  $('remote-merge-options')?.classList.toggle('hidden', !state.mergeIsRemote);
  const summaryEl = $('merge-source-summary');
  if (summaryEl) {
    if (summaryText) {
      summaryEl.textContent = summaryText;
      summaryEl.classList.remove('hidden');
    } else {
      summaryEl.textContent = '';
      summaryEl.classList.add('hidden');
    }
  }
}

function openMergeModal(branch) {
  state.mergeAllMode = false;
  state.mergeTargetBranch = branch;
  configureMergeModalMode(false, '');
  const titleEl = $('modal-merge-title');
  if (titleEl) titleEl.textContent = t('mergeModalTitle');
  populateMergeTargetSelect(branch);
  if ($('merge-auto-push')) $('merge-auto-push').checked = false;
  $('merge-no-squash').checked = false;
  $('merge-no-rebase').checked = false;
  $('merge-no-ff').checked = false;
  $('merge-no-remove').checked = false;
  $('merge-no-hooks').checked = false;
  openModal('modal-merge');
}

function openRemoteMergeModal(fullRef) {
  state.mergeAllMode = false;
  state.mergeTargetBranch = fullRef;
  configureMergeModalMode(true, t('remoteMergeSummarySingle', { branch: fullRef }));
  const titleEl = $('modal-merge-title');
  if (titleEl) titleEl.textContent = t('remoteMergeModalTitle');
  populateMergeTargetSelect(fullRef);
  $('remote-merge-push').checked = false;
  $('remote-merge-no-ff').checked = false;
  $('remote-merge-squash').checked = false;
  $('remote-merge-delete').checked = false;
  openModal('modal-merge');
}

function openMergeAllModal() {
  if (state.branchMode === 'remote') {
    const branches = getMergeableRemoteBranches();
    if (branches.length === 0) {
      showToast(t('noMergeableRemoteToast'), 'info');
      return;
    }
    state.mergeAllMode = true;
    state.mergeTargetBranch = null;
    configureMergeModalMode(true, t('remoteMergeSummaryAll', { count: branches.length }));
    const titleEl = $('modal-merge-title');
    if (titleEl) titleEl.textContent = t('remoteMergeAllModalTitle');
    populateMergeTargetSelect('');
    $('remote-merge-push').checked = false;
    $('remote-merge-no-ff').checked = false;
    $('remote-merge-squash').checked = false;
    $('remote-merge-delete').checked = false;
    openModal('modal-merge');
    return;
  }

  if (getMergeableWorktreeBranches().length === 0) {
    showToast(t('noMergeableBranchesToast'), 'info');
    return;
  }
  state.mergeAllMode = true;
  state.mergeTargetBranch = null;
  configureMergeModalMode(false, '');
  const titleEl = $('modal-merge-title');
  if (titleEl) titleEl.textContent = t('mergeAllModalTitle');
  populateMergeTargetSelect('');
  if ($('merge-auto-push')) $('merge-auto-push').checked = false;
  $('merge-no-squash').checked = false;
  $('merge-no-rebase').checked = false;
  $('merge-no-ff').checked = false;
  $('merge-no-remove').checked = false;
  $('merge-no-hooks').checked = false;
  openModal('modal-merge');
}

async function confirmRemoteMerge(active, target, btn, origLabel) {
  const remoteOptions = {
    projectId: active.id,
    target,
    autoPush: $('remote-merge-push').checked,
    noFf: $('remote-merge-no-ff').checked,
    squash: $('remote-merge-squash').checked,
    deleteRemote: $('remote-merge-delete').checked,
  };

  if (!state.mergeAllMode) {
    btn.disabled = true;
    try {
      const res = await api('/api/remote/merge', {
        method: 'POST',
        body: JSON.stringify({ ...remoteOptions, branch: state.mergeTargetBranch }),
      });
      appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      showToast(t('mergeSuccessToast', { branch: state.mergeTargetBranch }), 'success');
      closeModal('modal-merge');
      await Promise.all([refreshRemoteBranches(false), refreshWorktrees()]);
    } catch (err) {
      appendLog(t('mergeFailLog', { cmd: err.payload?.command || '' }), err.payload?.stderr || err.message);
      if (err.payload?.hasConflicts && err.payload?.conflictSession) {
        closeModal('modal-merge');
        showToast(t('conflictDetectedToast'), 'info');
        await openConflictModal(err.payload.conflictSession);
        await Promise.all([refreshRemoteBranches(false), refreshWorktrees()]);
      } else {
        showToast(t('mergeFailToast', { msg: err.payload?.stderr || err.message }), 'error');
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }

  const branches = getMergeableRemoteBranches(target);
  if (branches.length === 0) {
    showToast(t('noMergeableRemoteToast'), 'info');
    closeModal('modal-merge');
    return;
  }

  btn.disabled = true;
  let done = 0;
  try {
    for (let i = 0; i < branches.length; i += 1) {
      const branch = branches[i];
      const isLast = i === branches.length - 1;
      btn.textContent = t('mergingProgressBtn', { done: done + 1, total: branches.length });
      try {
        const res = await api('/api/remote/merge', {
          method: 'POST',
          body: JSON.stringify({
            ...remoteOptions,
            branch,
            // When batch merging, push once on the final branch (unless deleteRemote is also set)
            autoPush: remoteOptions.autoPush && isLast,
          }),
        });
        done += 1;
        appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      } catch (err) {
        const msg = err.payload?.stderr || err.message;
        appendLog(t('mergeFailLog', { cmd: err.payload?.command || branch }), msg);
        if (err.payload?.hasConflicts && err.payload?.conflictSession) {
          closeModal('modal-merge');
          showToast(t('conflictDetectedToast'), 'info');
          await openConflictModal(err.payload.conflictSession);
        } else {
          showToast(t('mergeAllPartialFailToast', { done, total: branches.length, branch, msg }), 'error');
        }
        await Promise.all([refreshRemoteBranches(false), refreshWorktrees()]);
        return;
      }
    }
    closeModal('modal-merge');
    showToast(
      t('remoteMergeAllSuccessToast', {
        count: done,
        target: target || state.remoteData?.targetBranch || 'main',
      }),
      'success'
    );
    await Promise.all([refreshRemoteBranches(false), refreshWorktrees()]);
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

async function confirmMerge() {
  const active = getActiveProject();
  if (!active || (!state.mergeAllMode && !state.mergeTargetBranch)) return;
  const btn = $('btn-confirm-merge');
  const origLabel = btn.textContent;
  const target = $('merge-target').value.trim();

  if (state.mergeIsRemote) {
    await confirmRemoteMerge(active, target, btn, origLabel);
    return;
  }

  const autoPush = Boolean($('merge-auto-push')?.checked);
  const commonOptions = {
    projectId: active.id,
    target,
    autoPush,
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
      if (err.payload?.hasConflicts && err.payload?.conflictSession) {
        closeModal('modal-merge');
        showToast(t('conflictDetectedToast'), 'info');
        await openConflictModal(err.payload.conflictSession);
        await refreshWorktrees();
      } else {
        showToast(t('mergeFailToast', { msg: err.payload?.stderr || err.message }), 'error');
      }
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
    for (let i = 0; i < branches.length; i += 1) {
      const branch = branches[i];
      const isLast = i === branches.length - 1;
      btn.textContent = t('mergingProgressBtn', { done: done + 1, total: branches.length });
      try {
        const res = await api('/api/worktrees/merge', {
          method: 'POST',
          body: JSON.stringify({
            ...commonOptions,
            branch,
            autoPush: autoPush && isLast,
          }),
        });
        done += 1;
        appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      } catch (err) {
        const msg = err.payload?.stderr || err.message;
        appendLog(t('mergeFailLog', { cmd: err.payload?.command || branch }), msg);
        if (err.payload?.hasConflicts && err.payload?.conflictSession) {
          closeModal('modal-merge');
          showToast(t('conflictDetectedToast'), 'info');
          await openConflictModal(err.payload.conflictSession);
        } else {
          showToast(t('mergeAllPartialFailToast', { done, total: branches.length, branch, msg }), 'error');
        }
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

// Visual Conflict Resolver
async function openConflictModal(session) {
  const files = session.files || [];
  const trackedFiles = files.map((f) => f.path);
  const unresolvedCount = files.filter((f) => !f.resolved).length;
  const autoPush = Boolean(session.autoPush);
  state.conflictSession = {
    workDir: session.workDir,
    sourceBranch: session.sourceBranch || '',
    targetBranch: session.targetBranch || '',
    isRemote: Boolean(session.isRemote),
    autoPush,
    deleteRemote: Boolean(session.deleteRemote),
    files,
    trackedFiles,
    unresolvedCount,
    activeFile: files[0]?.path || '',
    fileDetails: null,
    viewMode: 'visual',
  };
  if ($('conflict-auto-push')) {
    $('conflict-auto-push').checked = autoPush;
  }
  openModal('modal-conflict');
  renderConflictHeaderAndSidebar();
  if (state.conflictSession.activeFile) {
    await loadConflictFile(state.conflictSession.activeFile);
  } else {
    renderConflictMainPane();
  }
}

async function openExistingWorktreeConflictModal(workDir, branchName) {
  const active = getActiveProject();
  if (!active) return;
  try {
    const res = await api(
      `/api/conflicts/status?projectId=${encodeURIComponent(active.id)}&workDir=${encodeURIComponent(workDir)}`
    );
    await openConflictModal({
      workDir: res.status.workDir,
      sourceBranch: '',
      targetBranch: branchName,
      isRemote: false,
      autoPush: false,
      deleteRemote: false,
      files: res.status.files,
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderConflictHeaderAndSidebar() {
  const cs = state.conflictSession;
  if (!cs) return;

  const branchBadge = $('conflict-branch-badge');
  if (branchBadge) {
    branchBadge.textContent = cs.sourceBranch
      ? `${cs.sourceBranch} → ${cs.targetBranch || 'HEAD'}`
      : cs.targetBranch || cs.workDir;
  }

  const countBadge = $('conflict-count-badge');
  if (countBadge) {
    if (cs.unresolvedCount > 0) {
      countBadge.className = 'badge badge-danger';
      countBadge.textContent = t('conflictRemainingBadge', { count: cs.unresolvedCount });
    } else {
      countBadge.className = 'badge badge-success';
      countBadge.textContent = t('conflictAllResolvedBadge');
    }
  }

  const completeBtn = $('btn-complete-conflict');
  if (completeBtn) {
    completeBtn.disabled = cs.unresolvedCount > 0;
  }
  const aiCompleteBtn = $('btn-ai-complete-conflict');
  if (aiCompleteBtn) {
    aiCompleteBtn.disabled = false;
    aiCompleteBtn.textContent = t('aiCompleteMergeBtn');
  }

  const listEl = $('conflict-file-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  for (const file of cs.files) {
    const row = document.createElement('div');
    row.className = `conflict-file-item${file.path === cs.activeFile ? ' active' : ''}`;
    const badgeHtml = file.resolved
      ? `<span class="badge badge-success">${escapeHtml(t('conflictFileResolvedBadge'))}</span>`
      : file.hunkCount > 0
        ? `<span class="badge badge-danger">${escapeHtml(t('conflictFileHunksBadge', { count: file.hunkCount }))}</span>`
        : `<span class="badge badge-warn">${escapeHtml(t('conflictFileUnmergedBadge'))}</span>`;

    row.innerHTML = `
      <span class="conflict-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>
      ${badgeHtml}
    `;
    row.addEventListener('click', () => {
      loadConflictFile(file.path);
    });
    listEl.appendChild(row);
  }
}

async function loadConflictFile(filePath) {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs || !filePath) return;

  cs.activeFile = filePath;
  renderConflictHeaderAndSidebar();

  try {
    const res = await api(
      `/api/conflicts/file?projectId=${encodeURIComponent(active.id)}&workDir=${encodeURIComponent(cs.workDir)}&file=${encodeURIComponent(filePath)}`
    );
    cs.fileDetails = res.file;
    renderConflictMainPane();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

const conflictEditor = {
  monacoPromise: null,
  instance: null,
  decorations: null,
  codeLensProviderRegistered: false,
  resizeObserver: null,
  loadedFileKey: '',
  lastSyncedContent: null,
  fallbackMode: false,
};

function getMonacoTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
}

function detectMonacoLanguage(filePath) {
  const name = String(filePath || '').split(/[\\/]/).pop() || '';
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'shell';

  const dotIdx = lower.lastIndexOf('.');
  const ext = dotIdx >= 0 ? lower.slice(dotIdx + 1) : '';
  const map = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    json: 'json',
    jsonc: 'json',
    'code-workspace': 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    vue: 'html',
    svelte: 'html',
    xml: 'xml',
    svg: 'xml',
    plist: 'xml',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    sql: 'sql',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    dart: 'dart',
    ini: 'ini',
    toml: 'ini',
    env: 'ini',
    conf: 'ini',
    bat: 'bat',
    cmd: 'bat',
    ps1: 'powershell',
    graphql: 'graphql',
    gql: 'graphql',
  };
  return map[ext] || 'plaintext';
}

function scanMonacoConflictBlocks(model) {
  if (!model) return [];
  const lineCount = model.getLineCount();
  const blocks = [];
  let i = 1;
  while (i <= lineCount) {
    const line = model.getLineContent(i);
    if (line.startsWith('<<<<<<<')) {
      const startLine = i;
      let baseLine = -1;
      let sepLine = -1;
      let endLine = -1;
      for (let j = i + 1; j <= lineCount; j += 1) {
        const cur = model.getLineContent(j);
        if (sepLine === -1 && baseLine === -1 && cur.startsWith('|||||||')) {
          baseLine = j;
        } else if (sepLine === -1 && cur.startsWith('=======')) {
          sepLine = j;
        } else if (sepLine !== -1 && cur.startsWith('>>>>>>>')) {
          endLine = j;
          break;
        }
      }
      if (sepLine !== -1 && endLine !== -1) {
        blocks.push({ startLine, baseLine, sepLine, endLine });
        i = endLine + 1;
        continue;
      }
    }
    i += 1;
  }
  return blocks;
}

function updateConflictEditorStatusBar(lang, blocksCount) {
  const langEl = $('conflict-editor-lang');
  if (langEl) langEl.textContent = lang || 'plaintext';
  const markersEl = $('conflict-editor-markers');
  if (markersEl) {
    markersEl.classList.remove('is-warn', 'is-clean');
    if (blocksCount > 0) {
      markersEl.classList.add('is-warn');
      markersEl.textContent = t('conflictEditorMarkersCount', { count: blocksCount });
    } else {
      markersEl.classList.add('is-clean');
      markersEl.textContent = t('conflictEditorClean');
    }
  }
}

function refreshMonacoConflictDecorations() {
  const editor = conflictEditor.instance;
  const monaco = window.monaco;
  if (!editor || !monaco) return;
  const model = editor.getModel();
  if (!model) return;

  const blocks = scanMonacoConflictBlocks(model);
  const lang = model.getLanguageId();
  updateConflictEditorStatusBar(lang, blocks.length);

  if (monaco.languages?.json?.jsonDefaults) {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: blocks.length === 0,
      allowComments: true,
    });
  }

  const decorations = [];
  for (const b of blocks) {
    const oursEnd = b.baseLine !== -1 ? b.baseLine - 1 : b.sepLine - 1;
    decorations.push({
      range: new monaco.Range(b.startLine, 1, b.startLine, 1),
      options: {
        isWholeLine: true,
        className: 'conflict-deco-ours-header',
        overviewRuler: { color: '#3b82f6', position: monaco.editor.OverviewRulerLane.Full },
      },
    });
    if (oursEnd >= b.startLine + 1) {
      decorations.push({
        range: new monaco.Range(b.startLine + 1, 1, oursEnd, 1),
        options: { isWholeLine: true, className: 'conflict-deco-ours-body' },
      });
    }
    if (b.baseLine !== -1) {
      decorations.push({
        range: new monaco.Range(b.baseLine, 1, b.baseLine, 1),
        options: { isWholeLine: true, className: 'conflict-deco-base-header' },
      });
      if (b.sepLine - 1 >= b.baseLine + 1) {
        decorations.push({
          range: new monaco.Range(b.baseLine + 1, 1, b.sepLine - 1, 1),
          options: { isWholeLine: true, className: 'conflict-deco-base-body' },
        });
      }
    }
    decorations.push({
      range: new monaco.Range(b.sepLine, 1, b.sepLine, 1),
      options: { isWholeLine: true, className: 'conflict-deco-sep' },
    });
    if (b.endLine - 1 >= b.sepLine + 1) {
      decorations.push({
        range: new monaco.Range(b.sepLine + 1, 1, b.endLine - 1, 1),
        options: { isWholeLine: true, className: 'conflict-deco-theirs-body' },
      });
    }
    decorations.push({
      range: new monaco.Range(b.endLine, 1, b.endLine, 1),
      options: {
        isWholeLine: true,
        className: 'conflict-deco-theirs-header',
        overviewRuler: { color: '#22c55e', position: monaco.editor.OverviewRulerLane.Full },
      },
    });
  }

  if (!conflictEditor.decorations) {
    conflictEditor.decorations = editor.createDecorationsCollection(decorations);
  } else {
    conflictEditor.decorations.set(decorations);
  }
}

function resolveBlockInsideMonaco(block, choice) {
  const editor = conflictEditor.instance;
  const monaco = window.monaco;
  if (!editor || !monaco || !block) return;
  const model = editor.getModel();
  if (!model) return;

  const oursEnd = block.baseLine !== -1 ? block.baseLine - 1 : block.sepLine - 1;
  const collectLines = (from, to) => {
    const out = [];
    for (let ln = from; ln <= to; ln += 1) {
      out.push(model.getLineContent(ln));
    }
    return out;
  };

  const oursLines = oursEnd >= block.startLine + 1 ? collectLines(block.startLine + 1, oursEnd) : [];
  const theirsLines = block.endLine - 1 >= block.sepLine + 1 ? collectLines(block.sepLine + 1, block.endLine - 1) : [];

  let chosenLines;
  if (choice === 'ours') chosenLines = oursLines;
  else if (choice === 'theirs') chosenLines = theirsLines;
  else chosenLines = [...oursLines, ...theirsLines];

  const eol = model.getEOL();
  const maxCol = model.getLineMaxColumn(block.endLine);
  const fullRange = new monaco.Range(block.startLine, 1, block.endLine, maxCol);
  let replacement = chosenLines.join(eol);
  if (chosenLines.length === 0 && block.endLine < model.getLineCount()) {
    fullRange.endLineNumber = block.endLine + 1;
    fullRange.endColumn = 1;
    replacement = '';
  }

  editor.pushUndoStop();
  editor.executeEdits('wtui-conflict-codelens', [{ range: fullRange, text: replacement, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
}

function registerMonacoConflictFeatures(monaco) {
  if (conflictEditor.codeLensProviderRegistered) return;
  conflictEditor.codeLensProviderRegistered = true;

  monaco.editor.registerCommand('wtui.resolveConflictInEditor', (_accessor, block, choice) => {
    resolveBlockInsideMonaco(block, choice);
  });

  monaco.languages.registerCodeLensProvider('*', {
    provideCodeLenses(model) {
      if (conflictEditor.instance?.getModel() !== model) {
        return { lenses: [], dispose: () => {} };
      }
      const blocks = scanMonacoConflictBlocks(model);
      const lenses = [];
      for (const block of blocks) {
        const range = new monaco.Range(block.startLine, 1, block.startLine, 1);
        lenses.push(
          {
            range,
            command: {
              id: 'wtui.resolveConflictInEditor',
              title: t('conflictLensAcceptOurs'),
              arguments: [block, 'ours'],
            },
          },
          {
            range,
            command: {
              id: 'wtui.resolveConflictInEditor',
              title: t('conflictLensAcceptTheirs'),
              arguments: [block, 'theirs'],
            },
          },
          {
            range,
            command: {
              id: 'wtui.resolveConflictInEditor',
              title: t('conflictLensAcceptBoth'),
              arguments: [block, 'both'],
            },
          }
        );
      }
      return { lenses, dispose: () => {} };
    },
    resolveCodeLens(_model, codeLens) {
      return codeLens;
    },
  });
}

function ensureMonacoStylesheetLoaded() {
  const targetHref = '/vendor/monaco/vs/editor/editor.main.css';
  let link = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((el) =>
    (el.getAttribute('href') || '').includes(targetHref)
  );

  if (!link) {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = targetHref;
    const appCss = document.querySelector('link[href="/styles.css"]');
    if (appCss && appCss.parentNode) {
      appCss.parentNode.insertBefore(link, appCss);
    } else {
      document.head.appendChild(link);
    }
  }

  if (link.sheet) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 4000);
  });
}

function loadMonacoEditor() {
  if (window.monaco?.editor) {
    registerMonacoConflictFeatures(window.monaco);
    return ensureMonacoStylesheetLoaded().then(() => window.monaco);
  }
  if (conflictEditor.monacoPromise) {
    return conflictEditor.monacoPromise;
  }

  const cssReady = ensureMonacoStylesheetLoaded();
  const jsReady = new Promise((resolvePromise, rejectPromise) => {
    const bootAmd = () => {
      if (typeof window.require !== 'function') {
        rejectPromise(new Error('Monaco AMD loader unavailable'));
        return;
      }
      window.require.config({
        paths: { vs: '/vendor/monaco/vs' },
        'vs/nls': {
          availableLanguages: {
            '*': getLang() === 'zh' ? 'zh-cn' : 'en',
          },
        },
      });
      window.require(
        ['vs/editor/editor.main'],
        (monacoApi) => {
          const monaco = monacoApi || window.monaco;
          if (!monaco?.editor) {
            rejectPromise(new Error('Failed to initialize Monaco editor'));
            return;
          }
          registerMonacoConflictFeatures(monaco);
          resolvePromise(monaco);
        },
        (err) => rejectPromise(err || new Error('Failed to load Monaco modules'))
      );
    };

    if (typeof window.require === 'function' && window.require.config) {
      bootAmd();
      return;
    }

    const script = document.createElement('script');
    script.src = '/vendor/monaco/vs/loader.js';
    script.async = true;
    script.onload = bootAmd;
    script.onerror = () => rejectPromise(new Error('Failed to load /vendor/monaco/vs/loader.js'));
    document.head.appendChild(script);
  });

  conflictEditor.monacoPromise = Promise.all([cssReady, jsReady]).then(([, monaco]) => monaco);
  return conflictEditor.monacoPromise;
}

function getRawConflictEditorValue() {
  if (conflictEditor.instance && !conflictEditor.fallbackMode) {
    return conflictEditor.instance.getValue();
  }
  return $('conflict-raw-textarea')?.value || '';
}

async function syncConflictCodeEditor(content, filePath, workDir) {
  const host = $('conflict-monaco-host');
  const fallbackTextarea = $('conflict-raw-textarea');
  if (!host) return;

  const nextKey = `${workDir || ''}::${filePath || ''}`;
  const lang = detectMonacoLanguage(filePath);

  if (conflictEditor.fallbackMode) {
    host.classList.add('hidden');
    if (fallbackTextarea) {
      fallbackTextarea.classList.remove('hidden');
      if (conflictEditor.loadedFileKey !== nextKey || conflictEditor.lastSyncedContent !== content) {
        fallbackTextarea.value = content || '';
        conflictEditor.loadedFileKey = nextKey;
        conflictEditor.lastSyncedContent = content || '';
      }
    }
    const blockMatches = String(content || '').match(/^<{7}\s/gm);
    updateConflictEditorStatusBar(lang, blockMatches ? blockMatches.length : 0);
    return;
  }

  if (!conflictEditor.instance) {
    if (!host.querySelector('.conflict-monaco-loading') && !host.querySelector('.monaco-editor')) {
      const loadingEl = document.createElement('div');
      loadingEl.className = 'conflict-monaco-loading';
      loadingEl.textContent = t('conflictEditorLoading');
      host.replaceChildren(loadingEl);
    }
    try {
      const monaco = await loadMonacoEditor();
      // Bail if modal was closed or switched back while loading
      if (!state.conflictSession) return;
      if (!conflictEditor.instance) {
        host.replaceChildren();
        const model = monaco.editor.createModel(content || '', lang);
        const editor = monaco.editor.create(host, {
          model,
          theme: getMonacoTheme(),
          automaticLayout: true,
          fontSize: 13,
          lineHeight: 20,
          fontFamily:
            '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'selection',
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          bracketPairColorization: { enabled: true },
          codeLens: true,
          padding: { top: 8, bottom: 8 },
        });

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          saveRawConflictFile();
        });

        editor.onDidChangeModelContent(() => {
          refreshMonacoConflictDecorations();
        });

        if (typeof ResizeObserver === 'function') {
          conflictEditor.resizeObserver = new ResizeObserver(() => {
            editor.layout();
          });
          conflictEditor.resizeObserver.observe(host);
        }

        conflictEditor.instance = editor;
        conflictEditor.loadedFileKey = nextKey;
        conflictEditor.lastSyncedContent = content || '';
        refreshMonacoConflictDecorations();
        requestAnimationFrame(() => editor.layout());
        document.fonts?.ready?.then(() => {
          monaco.editor.remeasureFonts?.();
          if (conflictEditor.instance === editor) {
            editor.layout();
          }
        });
      }
    } catch {
      conflictEditor.fallbackMode = true;
      host.classList.add('hidden');
      if (fallbackTextarea) {
        fallbackTextarea.classList.remove('hidden');
        fallbackTextarea.value = content || '';
        conflictEditor.loadedFileKey = nextKey;
        conflictEditor.lastSyncedContent = content || '';
      }
      return;
    }
  }

  const editor = conflictEditor.instance;
  const monaco = window.monaco;
  if (!editor || !monaco) return;

  const model = editor.getModel();
  if (model) {
    if (model.getLanguageId() !== lang) {
      monaco.editor.setModelLanguage(model, lang);
    }
    const shouldReplaceValue =
      conflictEditor.loadedFileKey !== nextKey || conflictEditor.lastSyncedContent !== content;
    if (shouldReplaceValue && model.getValue() !== (content || '')) {
      model.setValue(content || '');
    }
  }
  conflictEditor.loadedFileKey = nextKey;
  conflictEditor.lastSyncedContent = content || '';
  refreshMonacoConflictDecorations();
  requestAnimationFrame(() => editor.layout());
}

function setConflictViewMode(mode) {
  if (!state.conflictSession) return;
  state.conflictSession.viewMode = mode === 'raw' ? 'raw' : 'visual';
  renderConflictMainPane();
}

function renderConflictMainPane() {
  const cs = state.conflictSession;
  if (!cs) return;

  const isRaw = cs.viewMode === 'raw';
  $('btn-conflict-view-visual')?.classList.toggle('active', !isRaw);
  $('btn-conflict-view-raw')?.classList.toggle('active', isRaw);
  $('conflict-visual-pane')?.classList.toggle('hidden', isRaw);
  $('conflict-raw-pane')?.classList.toggle('hidden', !isRaw);
  $('btn-save-conflict-file')?.classList.toggle('hidden', !isRaw);

  const fileLabel = $('conflict-active-file');
  if (fileLabel) fileLabel.textContent = cs.activeFile || '-';

  const details = cs.fileDetails;
  const visualPane = $('conflict-visual-pane');
  const rawTextarea = $('conflict-raw-textarea');

  if (!details) {
    if (visualPane) visualPane.innerHTML = '';
    if (rawTextarea) rawTextarea.value = '';
    if (conflictEditor.instance?.getModel()) {
      conflictEditor.instance.getModel().setValue('');
    }
    conflictEditor.loadedFileKey = '';
    conflictEditor.lastSyncedContent = '';
    return;
  }

  if (isRaw) {
    syncConflictCodeEditor(details.content, cs.activeFile, cs.workDir);
  } else if (rawTextarea && conflictEditor.fallbackMode) {
    rawTextarea.value = details.content;
  } else {
    // Pre-warm Monaco when visual mode loads so switching to Raw Editor is instant
    loadMonacoEditor().catch(() => {});
  }

  if (!visualPane) return;
  visualPane.innerHTML = '';

  if (details.hunkCount === 0 && details.resolved) {
    const banner = document.createElement('div');
    banner.className = 'conflict-resolved-banner';
    banner.innerHTML = `
      <span>${escapeHtml(t('conflictFileResolvedBanner'))}</span>
      <button type="button" class="btn btn-secondary btn-sm btn-switch-raw">${escapeHtml(t('editInRawViewBtn'))}</button>
    `;
    banner.querySelector('.btn-switch-raw').addEventListener('click', () => setConflictViewMode('raw'));
    visualPane.appendChild(banner);

    const preview = document.createElement('pre');
    preview.className = 'conflict-code-block';
    preview.style.border = '1px solid var(--border)';
    preview.style.borderRadius = '8px';
    preview.style.background = 'var(--code-bg)';
    preview.textContent = details.content;
    visualPane.appendChild(preview);
    return;
  }

  for (const seg of details.segments || []) {
    if (seg.type === 'normal') {
      const lines = seg.lines || [];
      if (lines.length === 0) continue;
      const snippet =
        lines.length > 6
          ? [...lines.slice(0, 3), `... (${lines.length - 6} lines) ...`, ...lines.slice(-3)].join('\n')
          : lines.join('\n');
      const ctx = document.createElement('div');
      ctx.className = 'conflict-context-card';
      ctx.textContent = snippet;
      visualPane.appendChild(ctx);
      continue;
    }

    if (seg.type === 'conflict') {
      const h = seg.hunk;
      const card = document.createElement('div');
      card.className = 'conflict-hunk-card';
      card.innerHTML = `
        <div class="conflict-hunk-header">
          <div class="conflict-hunk-title">
            <span class="badge badge-danger">#${h.id + 1}</span>
            <span>${escapeHtml(t('conflictHunkTitle', { index: h.id + 1, start: h.startLine, end: h.endLine }))}</span>
          </div>
          <div class="conflict-hunk-actions">
            <button type="button" class="btn btn-primary btn-sm" data-choice="ours">${escapeHtml(t('acceptHunkOursBtn'))}</button>
            <button type="button" class="btn btn-success btn-sm" data-choice="theirs">${escapeHtml(t('acceptHunkTheirsBtn'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-choice="both">${escapeHtml(t('acceptHunkBothBtn'))}</button>
            <button type="button" class="btn btn-secondary btn-sm" data-choice="both_reverse">${escapeHtml(t('acceptHunkBothRevBtn'))}</button>
          </div>
        </div>
        <div class="conflict-hunk-split">
          <div class="conflict-side conflict-side-ours">
            <div class="conflict-side-label">${escapeHtml(t('conflictSideOursLabel', { label: h.oursLabel }))}</div>
            <pre class="conflict-code-block">${escapeHtml(h.oursText || ' ')}</pre>
          </div>
          <div class="conflict-side conflict-side-theirs">
            <div class="conflict-side-label">${escapeHtml(t('conflictSideTheirsLabel', { label: h.theirsLabel }))}</div>
            <pre class="conflict-code-block">${escapeHtml(h.theirsText || ' ')}</pre>
          </div>
        </div>
      `;
      card.querySelectorAll('[data-choice]').forEach((btn) => {
        btn.addEventListener('click', () => {
          applyHunkChoice(h.id, btn.getAttribute('data-choice'));
        });
      });
      visualPane.appendChild(card);
    }
  }
}

async function updateConflictSessionFromResponse(res) {
  const cs = state.conflictSession;
  if (!cs) return;
  cs.fileDetails = res.file;
  cs.files = res.status.files;
  cs.unresolvedCount = res.status.unresolvedCount;
  renderConflictHeaderAndSidebar();
  renderConflictMainPane();

  if (res.file.resolved) {
    showToast(t('conflictFileSavedToast', { file: res.file.path }), 'success');
    const nextUnresolved = cs.files.find((f) => !f.resolved && f.path !== res.file.path);
    if (nextUnresolved) {
      await loadConflictFile(nextUnresolved.path);
    }
  }
}

async function applyHunkChoice(hunkIndex, hunkChoice) {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs || !cs.activeFile) return;

  try {
    const res = await api('/api/conflicts/resolve', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        filePath: cs.activeFile,
        hunkIndex,
        hunkChoice,
        trackedFiles: cs.trackedFiles,
      }),
    });
    await updateConflictSessionFromResponse(res);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function applyWholeFileStrategy(strategy) {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs || !cs.activeFile) return;

  try {
    const res = await api('/api/conflicts/resolve', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        filePath: cs.activeFile,
        strategy,
        trackedFiles: cs.trackedFiles,
      }),
    });
    await updateConflictSessionFromResponse(res);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveRawConflictFile() {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs || !cs.activeFile) return;

  const content = getRawConflictEditorValue();
  if (/^<{7}\s|^={7}\s*$|^>{7}\s/m.test(content)) {
    showToast(t('conflictMarkersRemainWarn'), 'error');
    return;
  }

  try {
    const res = await api('/api/conflicts/resolve', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        filePath: cs.activeFile,
        content,
        stage: true,
        trackedFiles: cs.trackedFiles,
      }),
    });
    await updateConflictSessionFromResponse(res);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function completeConflictResolution() {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs) return;

  const btn = $('btn-complete-conflict');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/conflicts/complete', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        sourceBranch: cs.sourceBranch,
        targetBranch: cs.targetBranch,
        isRemote: cs.isRemote,
        autoPush: Boolean($('conflict-auto-push')?.checked ?? cs.autoPush),
        deleteRemote: cs.deleteRemote,
      }),
    });
    appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('conflictCompleteSuccessToast'), 'success');
    closeModal('modal-conflict');
    state.conflictSession = null;
    await Promise.all([refreshWorktrees(), refreshRemoteBranches(false)]);
  } catch (err) {
    const msg = err.payload?.stderr || err.message;
    appendLog(t('mergeFailLog', { cmd: err.payload?.command || '' }), msg);
    showToast(t('mergeFailToast', { msg }), 'error');
    if (btn && cs.unresolvedCount === 0) btn.disabled = false;
  }
}

async function aiCompleteConflictResolution() {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs) return;

  if (!state.aiConfig?.url || !state.aiConfig?.key || !state.aiConfig?.model) {
    showToast(t('aiConfigMissingWarn'), 'error');
    resetToolForm();
    renderAiConfigForm();
    setSettingsTab('ai');
    openModal('modal-tools');
    return;
  }

  const aiBtn = $('btn-ai-complete-conflict');
  const completeBtn = $('btn-complete-conflict');
  if (aiBtn) {
    aiBtn.disabled = true;
    aiBtn.textContent = t('aiCompletingMergeBtn');
  }
  if (completeBtn) completeBtn.disabled = true;

  try {
    const res = await api('/api/conflicts/ai-complete', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        sourceBranch: cs.sourceBranch,
        targetBranch: cs.targetBranch,
        isRemote: cs.isRemote,
        autoPush: Boolean($('conflict-auto-push')?.checked ?? cs.autoPush),
        deleteRemote: cs.deleteRemote,
        trackedFiles: cs.trackedFiles,
      }),
    });
    if (Array.isArray(res.resolvedFiles) && res.resolvedFiles.length > 0) {
      appendLog(
        t('aiConflictResolveLog', {
          model: res.aiModel || state.aiConfig.model,
          files: res.resolvedFiles.join(', '),
        })
      );
    }
    appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('aiConflictCompleteSuccessToast'), 'success');
    closeModal('modal-conflict');
    state.conflictSession = null;
    await Promise.all([refreshWorktrees(), refreshRemoteBranches(false)]);
  } catch (err) {
    const msg = err.payload?.error || err.payload?.stderr || err.message;
    appendLog(t('mergeFailLog', { cmd: err.payload?.command || 'AI Merge' }), msg);
    showToast(t('mergeFailToast', { msg }), 'error');
    if (err.payload?.status && state.conflictSession) {
      state.conflictSession.files = err.payload.status.files;
      state.conflictSession.unresolvedCount = err.payload.status.unresolvedCount;
      renderConflictHeaderAndSidebar();
      if (state.conflictSession.activeFile) {
        await loadConflictFile(state.conflictSession.activeFile);
      }
    }
  } finally {
    if (aiBtn) {
      aiBtn.disabled = false;
      aiBtn.textContent = t('aiCompleteMergeBtn');
    }
    if (completeBtn && state.conflictSession) {
      completeBtn.disabled = state.conflictSession.unresolvedCount > 0;
    }
  }
}

async function abortConflictResolution() {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs) return;
  if (!window.confirm(t('abortMergeConfirm'))) return;

  try {
    const res = await api('/api/conflicts/abort', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
      }),
    });
    appendLog(t('mergeAbortedLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('mergeAbortedToast'), 'info');
    closeModal('modal-conflict');
    state.conflictSession = null;
    await Promise.all([refreshWorktrees(), refreshRemoteBranches(false)]);
  } catch (err) {
    showToast(err.payload?.stderr || err.message, 'error');
  }
}

async function deleteRemoteBranchRow(fullRef) {
  const active = getActiveProject();
  if (!active) return;
  if (!window.confirm(t('deleteRemoteBranchConfirm', { branch: fullRef }))) return;
  try {
    const res = await api('/api/remote/delete', {
      method: 'POST',
      body: JSON.stringify({ projectId: active.id, branch: fullRef }),
    });
    appendLog(t('deleteRemoteSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('deleteRemoteSuccessToast', { branch: fullRef }), 'success');
    await refreshRemoteBranches(false);
  } catch (err) {
    const msg = err.payload?.stderr || err.message;
    appendLog(t('logFail', { target: err.payload?.command || fullRef }), msg);
    showToast(msg, 'error');
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
    const outcome = Array.isArray(res.data) ? res.data[0]?.branch_outcome : res.data?.branch_outcome;
    if (outcome === 'retained_unmerged' || outcome === 'retained_failed') {
      const err = new Error(res.stderr || outcome);
      err.payload = { command: res.command, stderr: res.stderr || outcome };
      throw err;
    }
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
    if (state.branchMode === 'remote') {
      await refreshRemoteBranches(true);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function setSettingsTab(tab) {
  const next = tab === 'tools' || tab === 'ai' || tab === 'about' ? tab : 'general';
  state.activeSettingsTab = next;
  const isGeneral = next === 'general';
  const isAi = next === 'ai';
  const isTools = next === 'tools';
  const isAbout = next === 'about';

  const tabGeneral = $('tab-settings-general');
  const tabAi = $('tab-settings-ai');
  const tabTools = $('tab-settings-tools');
  const tabAbout = $('tab-settings-about');
  if (tabGeneral) {
    tabGeneral.classList.toggle('active', isGeneral);
    tabGeneral.setAttribute('aria-selected', isGeneral ? 'true' : 'false');
  }
  if (tabAi) {
    tabAi.classList.toggle('active', isAi);
    tabAi.setAttribute('aria-selected', isAi ? 'true' : 'false');
  }
  if (tabTools) {
    tabTools.classList.toggle('active', isTools);
    tabTools.setAttribute('aria-selected', isTools ? 'true' : 'false');
  }
  if (tabAbout) {
    tabAbout.classList.toggle('active', isAbout);
    tabAbout.setAttribute('aria-selected', isAbout ? 'true' : 'false');
  }
  $('settings-pane-general')?.classList.toggle('hidden', !isGeneral);
  $('settings-pane-ai')?.classList.toggle('hidden', !isAi);
  $('settings-pane-tools')?.classList.toggle('hidden', !isTools);
  $('settings-pane-about')?.classList.toggle('hidden', !isAbout);
}

function renderAboutPane() {
  const versionEl = $('about-version-text');
  if (versionEl) {
    versionEl.textContent = t('aboutVersionLabel', { version: state.appVersion || '0.1.0' });
  }
}

function getThemeMode() {
  const mode = document.documentElement.dataset.themeMode;
  if (mode === 'system' || mode === 'light' || mode === 'dark') {
    return mode;
  }
  try {
    const saved = localStorage.getItem('wt-ui-theme');
    if (saved === 'system' || saved === 'light' || saved === 'dark') {
      return saved;
    }
  } catch {
    // ignore storage errors
  }
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function renderGeneralSettingsForm() {
  const langSelect = $('setting-lang-select');
  if (langSelect) {
    langSelect.value = getLang();
  }

  const currentMode = getThemeMode();
  document.querySelectorAll('.theme-segment-btn[data-theme-mode]').forEach((btn) => {
    const isActive = btn.getAttribute('data-theme-mode') === currentMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  const autoStartEl = $('setting-auto-start');
  if (autoStartEl) {
    autoStartEl.checked = Boolean(state.generalConfig?.autoStart);
  }

  const termSelect = $('setting-preferred-terminal');
  if (termSelect) {
    termSelect.replaceChildren();
    for (const term of state.terminals || []) {
      const opt = document.createElement('option');
      opt.value = term.id;
      opt.textContent = term.name;
      termSelect.appendChild(opt);
    }
    const preferred = state.generalConfig?.preferredTerminal;
    if (preferred && (state.terminals || []).some((item) => item.id === preferred)) {
      termSelect.value = preferred;
    } else if (state.terminals?.length > 0) {
      termSelect.value = state.terminals[0].id;
    }
  }
}

async function saveGeneralConfig(partial) {
  try {
    const res = await api('/api/general-config', {
      method: 'POST',
      body: JSON.stringify(partial),
    });
    state.generalConfig = {
      autoStart: Boolean(res.generalConfig?.autoStart),
      preferredTerminal: res.generalConfig?.preferredTerminal || '',
    };
    renderGeneralSettingsForm();
    showToast(t('savedGeneralConfigToast'), 'success');
  } catch (err) {
    renderGeneralSettingsForm();
    showToast(err.message, 'error');
  }
}

function renderAiConfigForm() {
  const urlEl = $('ai-url');
  const keyEl = $('ai-key');
  const modelEl = $('ai-model');
  if (urlEl) urlEl.value = state.aiConfig?.url || '';
  if (keyEl) keyEl.value = state.aiConfig?.key || '';
  if (modelEl) modelEl.value = state.aiConfig?.model || '';
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
  container.replaceChildren();
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

      const infoEl = document.createElement('div');
      infoEl.className = 'tool-row-info';
      const strongEl = document.createElement('strong');
      strongEl.textContent = tool.name;
      const cmdEl = document.createElement('div');
      cmdEl.className = 'mono muted';
      cmdEl.textContent = `${tool.command} ${(tool.args || []).join(' ')}`.trim();
      infoEl.appendChild(strongEl);
      infoEl.appendChild(cmdEl);
      row.appendChild(infoEl);

      if (tool.custom) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger-ghost btn-sm';
        delBtn.textContent = t('deleteBtn');
        delBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await api(`/api/tools/${encodeURIComponent(tool.id)}`, { method: 'DELETE' });
          if ($('tool-edit-id').value === tool.id) {
            resetToolForm();
          }
          await loadState();
          showToast(t('deletedCustomToolToast'), 'success');
        });
        row.appendChild(delBtn);
      }

      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        startEditTool(tool);
      });
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
  $('btn-toggle-sidebar')?.addEventListener('click', () => {
    const layoutEl = $('workspace-layout');
    const isCollapsed = Boolean(layoutEl?.classList.contains('sidebar-collapsed'));
    applySidebarCollapsed(!isCollapsed, true);
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

  $('btn-mode-local').addEventListener('click', () => setBranchMode('local'));
  $('btn-mode-remote').addEventListener('click', () => setBranchMode('remote'));
  $('btn-fetch-remote').addEventListener('click', () => refreshRemoteBranches(true));
  $('toggle-hide-merged-remote').addEventListener('change', renderWorktrees);

  $('btn-refresh').addEventListener('click', refreshCurrentList);
  $('btn-merge-all').addEventListener('click', openMergeAllModal);
  $('toggle-branches').addEventListener('change', refreshWorktrees);

  $('remote-merge-squash').addEventListener('change', () => {
    if ($('remote-merge-squash').checked) {
      $('remote-merge-no-ff').checked = false;
    }
  });
  $('remote-merge-no-ff').addEventListener('change', () => {
    if ($('remote-merge-no-ff').checked) {
      $('remote-merge-squash').checked = false;
    }
  });

  $('input-branch').addEventListener('input', updateCommandPreview);
  $('input-create').addEventListener('change', updateCommandPreview);
  $('select-tool').addEventListener('change', () => {
    updateCommandPreview();
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
      const targetBranch = $('input-branch').value.trim();
      const selectedToolId = $('select-tool').value;
      const res = await switchWorktreeWithClobberPrompt({
        projectId: active.id,
        branch: targetBranch,
        create: $('input-create').checked,
        base: $('input-base').value.trim(),
        toolId: selectedToolId,
      });
      if (res.worktreeTools) {
        active.worktreeTools = res.worktreeTools;
      } else if (targetBranch && selectedToolId) {
        active.worktreeTools = { ...(active.worktreeTools || {}), [targetBranch]: selectedToolId };
      }
      appendLog(t('logExec', { cmd: res.command }), res.stdout || res.stderr || t('worktreePathLog', { path: res.worktreePath }));
      showToast(t('worktreeReadyToast'), 'success');
      applyAutoBranchName($('input-base').value.trim(), true);
      updateCommandPreview();
      await refreshWorktrees();
    } catch (err) {
      if (!err.clobberCancelled) {
        appendLog(t('logFail', { target: err.payload?.command || '' }), err.payload?.stderr || err.message);
      }
      showToast(err.payload?.stderr || err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-confirm-merge').addEventListener('click', confirmMerge);

  $('btn-conflict-view-visual').addEventListener('click', () => setConflictViewMode('visual'));
  $('btn-conflict-view-raw').addEventListener('click', () => setConflictViewMode('raw'));
  $('btn-file-accept-ours').addEventListener('click', () => applyWholeFileStrategy('ours'));
  $('btn-file-accept-theirs').addEventListener('click', () => applyWholeFileStrategy('theirs'));
  $('btn-save-conflict-file').addEventListener('click', saveRawConflictFile);
  $('btn-complete-conflict').addEventListener('click', completeConflictResolution);
  $('btn-ai-complete-conflict').addEventListener('click', aiCompleteConflictResolution);
  $('btn-abort-conflict').addEventListener('click', abortConflictResolution);

  $('btn-manage-tools').addEventListener('click', () => {
    resetToolForm();
    renderGeneralSettingsForm();
    renderAiConfigForm();
    renderAboutPane();
    setSettingsTab(state.activeSettingsTab || 'general');
    openModal('modal-tools');
  });
  $('tab-settings-general')?.addEventListener('click', () => setSettingsTab('general'));
  $('tab-settings-ai').addEventListener('click', () => setSettingsTab('ai'));
  $('tab-settings-tools').addEventListener('click', () => setSettingsTab('tools'));
  $('tab-settings-about')?.addEventListener('click', () => setSettingsTab('about'));
  $('btn-check-update')?.addEventListener('click', () => {
    showToast(t('aboutUpdateComingSoonToast'), 'info');
  });

  $('setting-lang-select')?.addEventListener('change', (e) => {
    applyLanguage(e.target.value, true);
  });

  document.querySelectorAll('.theme-segment-btn[data-theme-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-theme-mode') || 'dark';
      applyTheme(mode, true);
    });
  });

  $('setting-auto-start')?.addEventListener('change', (e) => {
    saveGeneralConfig({ autoStart: Boolean(e.target.checked) });
  });

  $('setting-preferred-terminal')?.addEventListener('change', (e) => {
    saveGeneralConfig({ preferredTerminal: e.target.value });
  });

  $('ai-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/ai-config', {
      method: 'POST',
      body: JSON.stringify({
        url: $('ai-url').value,
        key: $('ai-key').value,
        model: $('ai-model').value,
      }),
    });
    state.aiConfig = res.aiConfig || { url: '', key: '', model: '' };
    renderAiConfigForm();
    showToast(t('savedAiConfigToast'), 'success');
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
}

function applySidebarCollapsed(collapsed, persist = true) {
  const layoutEl = $('workspace-layout');
  const toggleBtn = $('btn-toggle-sidebar');
  const isCollapsed = Boolean(collapsed);
  if (layoutEl) {
    layoutEl.classList.toggle('sidebar-collapsed', isCollapsed);
  }
  if (toggleBtn) {
    const label = t(isCollapsed ? 'expandSidebarTitle' : 'collapseSidebarTitle');
    toggleBtn.title = label;
    toggleBtn.setAttribute('aria-label', label);
    toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
  }
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, isCollapsed ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }
}

function initSidebarCollapsed() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    collapsed = false;
  }
  applySidebarCollapsed(collapsed, false);
}

function applyLanguage(lang, persist = true) {
  setLang(lang, persist);
  const logEl = $('command-log');
  if (logEl && (logEl.textContent === MESSAGES.zh.waitingAction || logEl.textContent === MESSAGES.en.waitingAction)) {
    logEl.textContent = t('waitingAction');
  }
  applyTheme(getThemeMode(), false);
  const layoutEl = $('workspace-layout');
  applySidebarCollapsed(Boolean(layoutEl?.classList.contains('sidebar-collapsed')), false);
  renderGeneralSettingsForm();
  renderAboutPane();
  if (state.env) renderEnv(false);
  renderSidebar();
  renderMainProject();
  renderWorktrees();
  if (state.conflictSession) {
    renderConflictHeaderAndSidebar();
    renderConflictMainPane();
  }
  if ($('tool-edit-id').value) {
    $('btn-tool-submit').textContent = t('saveChangesBtn');
  } else {
    $('btn-tool-submit').textContent = t('addToolBtn');
  }
  renderToolsModalList();
  if (conflictEditor.instance) {
    refreshMonacoConflictDecorations();
  }
}

function applyTheme(mode, persist = true) {
  const nextMode = mode === 'system' || mode === 'light' || mode === 'dark' ? mode : 'dark';
  const sysLight =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  const resolved = nextMode === 'system' ? (sysLight ? 'light' : 'dark') : nextMode;
  document.documentElement.dataset.themeMode = nextMode;
  document.documentElement.dataset.theme = resolved;
  if (persist) {
    try {
      localStorage.setItem('wt-ui-theme', nextMode);
    } catch {
      // ignore storage errors
    }
  }
  document.querySelectorAll('.theme-segment-btn[data-theme-mode]').forEach((btn) => {
    const isActive = btn.getAttribute('data-theme-mode') === nextMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  if (window.monaco?.editor) {
    window.monaco.editor.setTheme(resolved === 'light' ? 'vs' : 'vs-dark');
  }
}

function initTheme() {
  applyTheme(getThemeMode(), false);
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSystemThemeChange = () => {
      if (getThemeMode() === 'system') {
        applyTheme('system', false);
      }
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onSystemThemeChange);
    }
  }
}

async function init() {
  setLang(getLang(), false);
  const logEl = $('command-log');
  if (logEl && (logEl.textContent === MESSAGES.zh.waitingAction || logEl.textContent === MESSAGES.en.waitingAction)) {
    logEl.textContent = t('waitingAction');
  }
  initTheme();
  initSidebarCollapsed();
  bindEvents();
  await Promise.all([loadHealth(true), loadState()]);
  await refreshWorktrees();
}

init().catch((err) => {
  showToast(err.message, 'error');
});

