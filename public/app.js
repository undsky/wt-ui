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
  aiModels: [],
  activeSettingsTab: 'general',
  openTabIds: [],
  worktreeCache: {},
  activeProjectId: null,
  worktreeData: null,
  browseCurrentPath: '',
  browseParentPath: null,
  mergeTargetBranch: null,
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

let confirmResolver = null;
let confirmKeydownHandler = null;

function settleConfirm(result) {
  const modal = $('modal-confirm');
  if (modal) modal.classList.add('hidden');
  if (confirmKeydownHandler) {
    document.removeEventListener('keydown', confirmKeydownHandler, true);
    confirmKeydownHandler = null;
  }
  const resolver = confirmResolver;
  confirmResolver = null;
  if (resolver) resolver(Boolean(result));
}

function showConfirm({ title = '', message = '', confirmText = '', cancelText = '', danger = false } = {}) {
  if (confirmResolver) {
    settleConfirm(false);
  }
  const titleEl = $('modal-confirm-title');
  const msgEl = $('modal-confirm-message');
  const okBtn = $('btn-confirm-ok');
  const cancelBtn = $('btn-confirm-cancel');
  if (!titleEl || !msgEl || !okBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  titleEl.textContent = title || t('confirmModalTitle');
  msgEl.textContent = message;
  okBtn.textContent = confirmText || t('confirmBtn');
  cancelBtn.textContent = cancelText || t('cancelBtn');
  okBtn.classList.toggle('btn-danger', Boolean(danger));
  okBtn.classList.toggle('btn-primary', !danger);

  openModal('modal-confirm');
  (danger ? cancelBtn : okBtn).focus();

  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmKeydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settleConfirm(false);
      }
    };
    document.addEventListener('keydown', confirmKeydownHandler, true);
  });
}

let pushRejectedResolver = null;
let pushRejectedKeydownHandler = null;

function settlePushRejected(choice) {
  const modal = $('modal-push-rejected');
  if (modal) modal.classList.add('hidden');
  if (pushRejectedKeydownHandler) {
    document.removeEventListener('keydown', pushRejectedKeydownHandler, true);
    pushRejectedKeydownHandler = null;
  }
  const resolver = pushRejectedResolver;
  pushRejectedResolver = null;
  if (resolver) resolver(choice || 'cancel');
}

function showPushRejectedDialog() {
  if (pushRejectedResolver) {
    settlePushRejected('cancel');
  }
  const msgEl = $('modal-push-rejected-message');
  const pullBtn = $('btn-push-rejected-pull');
  if (!msgEl || !pullBtn) {
    return Promise.resolve('cancel');
  }

  msgEl.textContent = t('pushRejectedMessage');
  openModal('modal-push-rejected');
  pullBtn.focus();

  return new Promise((resolve) => {
    pushRejectedResolver = resolve;
    pushRejectedKeydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settlePushRejected('cancel');
      }
    };
    document.addEventListener('keydown', pushRejectedKeydownHandler, true);
  });
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
    if (autoOpenGuide && !state.env.wtBin && state.env.autoInstall !== false) {
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
}

async function apiWithHookApproval(path, payload) {
  try {
    return await api(path, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (!err.payload?.approvalRequired || payload.approveHooks) {
      throw err;
    }
    const cmds = Array.isArray(err.payload.unapprovedCommands) ? err.payload.unapprovedCommands : [];
    const formatted = cmds
      .map((c) => `• [${c.phase || 'hook'}${c.name ? `:${c.name}` : ''}] ${c.template || ''}`.trim())
      .join('\n');
    const approved = await showConfirm({
      title: t('hookApprovalTitle'),
      message: t('hookApprovalPrompt', { commands: formatted || '-' }),
      confirmText: t('hookApprovalConfirmBtn'),
      danger: false,
    });
    if (!approved) {
      const cancelErr = new Error(t('hookApprovalCancelToast'));
      cancelErr.approvalCancelled = true;
      throw cancelErr;
    }
    const res = await api(path, {
      method: 'POST',
      body: JSON.stringify({ ...payload, approveHooks: true }),
    });
    return { ...res, hookApproved: true };
  }
}

function renderSidebar({ autoOpenAdd = false } = {}) {
  const tree = $('project-tree');
  tree.innerHTML = '';

  if (state.projects.length === 0) {
    if (autoOpenAdd) {
      openAddTargetModal();
    }
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
    $('project-view').classList.add('hidden');
    return;
  }

  $('project-view').classList.remove('hidden');

  const baseBranch = getMainWorktreeBranch(state.worktreeData);
  applyDefaultBranchToBaseInput(baseBranch, true);

  renderToolSelects();
}

const ACTION_ICON_PATHS = {
  conflict: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pull: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  push: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};

function renderActionIcon(name) {
  const paths = ACTION_ICON_PATHS[name] || '';
  return `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function renderOpenActionButton({ cls, hasWorktree, toolName, disabled = false }) {
  const disabledAttr = disabled ? ' disabled' : '';
  if (hasWorktree) {
    const label = toolName || t('toolFallback');
    const title = t('openWithTool', { tool: label });
    return `<button type="button" class="btn btn-secondary btn-action btn-open-tool ${cls}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabledAttr}>${renderActionIcon('open')}<span class="btn-label btn-tool-name">${escapeHtml(label)}</span></button>`;
  }
  const title = t('createAndOpen');
  return `<button type="button" class="btn btn-secondary btn-action ${cls}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"${disabledAttr}>${renderActionIcon('plus')}<span class="btn-label">${escapeHtml(title)}</span></button>`;
}

function renderRowActionsHtml({
  hasConflict = false,
  hasSync = false,
  remoteAhead = 0,
  openBtnHtml = '',
  mergeBtnCls = '',
  removeBtnCls = '',
  removeLabel = '',
}) {
  const toolSlotHtml = `<div class="action-slot action-slot-tool">${openBtnHtml}</div>`;

  let syncSlotHtml = '';
  if (hasSync) {
    const pushTitle = remoteAhead > 0 ? t('pushBtnAhead', { ahead: remoteAhead }) : t('pushBtn');
    syncSlotHtml = `<div class="action-slot action-slot-sync"><div class="action-btn-group" role="group">
        <button type="button" class="btn-group-item btn-pull-wt" title="${escapeHtml(t('pullBtn'))}">${renderActionIcon('pull')}<span class="btn-label">${escapeHtml(t('pullBtn'))}</span></button>
        <button type="button" class="btn-group-item ${remoteAhead > 0 ? 'is-accent ' : ''}btn-push-wt" title="${escapeHtml(pushTitle)}">${renderActionIcon('push')}<span class="btn-label">${escapeHtml(t('pushBtn'))}</span>${remoteAhead > 0 ? `<span class="action-count-badge">${remoteAhead}</span>` : ''}</button>
      </div></div>`;
  } else {
    syncSlotHtml = '<div class="action-slot action-slot-sync action-slot-empty" aria-hidden="true"></div>';
  }

  const mergeGroupBtns = [];
  if (hasConflict) {
    mergeGroupBtns.push(
      `<button type="button" class="btn btn-warning btn-action btn-resolve-conflict" title="${escapeHtml(t('resolveConflictBtn'))}">${renderActionIcon('conflict')}<span class="btn-label">${escapeHtml(t('resolveConflictBtn'))}</span></button>`,
    );
  }
  if (mergeBtnCls) {
    mergeGroupBtns.push(
      `<button type="button" class="btn btn-success btn-action ${mergeBtnCls}" title="${escapeHtml(t('oneClickMerge'))}">${renderActionIcon('merge')}<span class="btn-label">${escapeHtml(t('oneClickMerge'))}</span></button>`,
    );
  }

  const mergeSlotHtml =
    mergeGroupBtns.length > 0
      ? `<div class="action-slot action-slot-merge"><div class="action-merge-group" role="group">${mergeGroupBtns.join('')}</div></div>`
      : '<div class="action-slot action-slot-merge action-slot-empty" aria-hidden="true"></div>';

  const hasMergeAndRemove = mergeGroupBtns.length > 0 && Boolean(removeBtnCls);
  const dangerSlotHtml = removeBtnCls
    ? `<div class="action-slot action-slot-danger">${hasMergeAndRemove ? '<span class="action-divider" aria-hidden="true"></span>' : ''}<button type="button" class="btn-icon-danger ${removeBtnCls}" title="${escapeHtml(removeLabel)}" aria-label="${escapeHtml(removeLabel)}">${renderActionIcon('trash')}</button></div>`
    : '<div class="action-slot action-slot-danger action-slot-empty" aria-hidden="true"></div>';

  return {
    toolSyncHtml: `<div class="actions-cell actions-cell-tool-sync">${toolSlotHtml}${syncSlotHtml}</div>`,
    manageHtml: `<div class="actions-cell actions-cell-manage">${mergeSlotHtml}${dangerSlotHtml}</div>`,
  };
}

function renderWorktrees() {
  const tbody = $('worktree-tbody');
  tbody.innerHTML = '';

  const items = state.worktreeData?.items || [];
  const defaultBranch = state.worktreeData?.repo?.default_branch || 'main';
  const mainBranch = getMainWorktreeBranch(state.worktreeData);
  applyDefaultBranchToBaseInput(mainBranch, false);
  $('wt-count').textContent = String(items.length);

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(t('noWorktreeData'))}</td></tr>`;
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');
    const branchName = item.branch || item.head?.short_sha || '(detached)';
    const wt = item.worktree;
    const hasWorktree = Boolean(wt);
    const isMain = Boolean(wt?.main);
    const isLocked = Boolean(wt?.locked);
    const isPrunable = Boolean(wt?.prunable);
    const isDefault = Boolean(item.branch && item.branch === defaultBranch);
    const gutter = wt?.current ? '@' : wt?.main ? '^' : wt ? '+' : '/';

    // Status pills (Schema 2 independent fields + working tree changes)
    const pills = [];
    if (isDefault) pills.push(`<span class="badge badge-success">${escapeHtml(t('defaultBranchTag'))}</span>`);
    if (isMain) pills.push(`<span class="badge badge-info">${escapeHtml(t('mainWorktreeTag'))}</span>`);
    if (!hasWorktree) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('noWorktreeTag'))}</span>`);
    if (item.marker) pills.push(`<span class="badge badge-info">${escapeHtml(item.marker)}</span>`);
    if (wt?.detached) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('detachedTag'))}</span>`);
    if (isLocked) {
      const lockTitle = wt.locked.reason ? ` title="${escapeHtml(wt.locked.reason)}"` : '';
      pills.push(`<span class="badge badge-warn"${lockTitle}>${escapeHtml(t('lockedTag'))}</span>`);
    }
    if (isPrunable) {
      const pruneTitle = wt.prunable.reason ? ` title="${escapeHtml(wt.prunable.reason)}"` : '';
      pills.push(`<span class="badge badge-danger"${pruneTitle}>${escapeHtml(t('prunableTag'))}</span>`);
    }
    if (wt?.branch_mismatch) pills.push(`<span class="badge badge-warn">${escapeHtml(t('branchMismatchTag'))}</span>`);
    if (wt?.duplicate_branch) pills.push(`<span class="badge badge-warn">${escapeHtml(t('duplicateBranchTag'))}</span>`);
    if (wt?.changes?.conflicted) pills.push(`<span class="badge badge-danger">${escapeHtml(t('conflictTag'))}</span>`);
    if (wt?.changes?.staged) pills.push(`<span class="badge badge-success">${escapeHtml(t('stagedTag'))}</span>`);
    if (wt?.changes?.modified) pills.push(`<span class="badge badge-warn">${escapeHtml(t('modifiedTag'))}</span>`);
    if (wt?.changes?.untracked) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('untrackedTag'))}</span>`);
    if (wt?.changes?.renamed) pills.push(`<span class="badge badge-neutral">${escapeHtml(t('renamedTag'))}</span>`);
    if (wt?.changes?.deleted) pills.push(`<span class="badge badge-warn">${escapeHtml(t('deletedTag'))}</span>`);
    if (wt?.operation) pills.push(`<span class="badge badge-warn">${escapeHtml(wt.operation)} ↻</span>`);

    // Divergence
    const db = item.default_branch;
    const divStats = [];
    const divPills = [];
    if (db) {
      if (db.orphan) {
        divPills.push(`<span class="badge badge-neutral">${escapeHtml(t('orphanTag'))}</span>`);
      } else if ((db.ahead !== null && db.ahead !== undefined && db.ahead > 0) || (db.behind !== null && db.behind !== undefined && db.behind > 0)) {
        divStats.push(`<span>↑${db.ahead ?? '-'} ↓${db.behind ?? '-'}</span>`);
      }
      if (db.diff && (db.diff.added || db.diff.deleted)) {
        divStats.push(`<span class="mono">+${db.diff.added} -${db.diff.deleted}</span>`);
      }
      if (db.integration) {
        divPills.push(`<span class="badge badge-success">${escapeHtml(t('mergedTag', { reason: db.integration.reason }))}</span>`);
      }
      if (db.merge_conflicts) {
        divPills.push(`<span class="badge badge-danger">${escapeHtml(t('mergeConflictRisk'))}</span>`);
      }
    } else if (isMain || isDefault) {
      divStats.push(`<span class="muted">${escapeHtml(t('baseBranchTag'))}</span>`);
    }

    const divHtml =
      divStats.length === 0 && divPills.length === 0
        ? `<div class="diff-stats"><span class="muted">${escapeHtml(t('noDiff'))}</span></div>`
        : `<div class="branch-cell">
            ${divStats.length > 0 ? `<div class="diff-stats">${divStats.join('')}</div>` : ''}
            ${divPills.length > 0 ? `<div class="status-pills">${divPills.join('')}</div>` : ''}
          </div>`;

    const toolKey = item.branch || wt?.path || branchName;
    const boundTool = getWorktreeTool(toolKey);
    const remoteAhead =
      item.upstream?.ahead ?? (typeof item.remote === 'object' && item.remote ? item.remote.ahead : 0) ?? 0;
    const hasConflict = Boolean(!isPrunable && (wt?.changes?.conflicted || wt?.operation) && wt?.path);
    const hasSync = Boolean(hasWorktree && !isPrunable && wt?.path);
    const canMerge = Boolean(hasWorktree && !isPrunable && !isMain && item.branch);
    const canRemove = Boolean(!isMain && !isLocked && (hasWorktree || (!isDefault && item.branch)));
    const { toolSyncHtml, manageHtml } = renderRowActionsHtml({
      hasConflict,
      hasSync,
      remoteAhead,
      openBtnHtml: renderOpenActionButton({
        cls: 'btn-open-wt',
        hasWorktree,
        toolName: boundTool?.name,
        disabled: isPrunable,
      }),
      mergeBtnCls: canMerge ? 'btn-merge-wt' : '',
      removeBtnCls: canRemove ? 'btn-remove-wt' : '',
      removeLabel: hasWorktree ? t('removeBtn') : t('deleteBtn'),
    });

    tr.innerHTML = `
      <td>
        <div class="branch-cell">
          <div class="branch-main">
            <span class="gutter-symbol">${gutter}</span>
            <strong>${escapeHtml(branchName)}</strong>
          </div>
          ${pills.length > 0 ? `<div class="status-pills">${pills.join('')}</div>` : ''}
        </div>
      </td>
      <td>${divHtml}</td>
      <td class="col-actions col-tool-sync">${toolSyncHtml}</td>
      <td class="col-actions col-manage-actions">${manageHtml}</td>
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
      if (isPrunable) return;
      const toolId = hasWorktree ? boundTool?.id : ($('select-tool').value || 'claude');
      // Detached HEAD or duplicate branch checkouts must be targeted by worktree path
      const switchTarget = item.branch
        ? wt?.duplicate_branch && wt?.path
          ? wt.path
          : item.branch
        : wt?.path || branchName;
      openWorktreeRow(switchTarget, false, '', toolId, branchName);
    });

    const mergeBtn = tr.querySelector('.btn-merge-wt');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', () => openMergeModal(item.branch));
    }

    const removeBtn = tr.querySelector('.btn-remove-wt');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => removeWorktreeRow(item.branch || wt.path, item));
    }

    tbody.appendChild(tr);
  }
}

async function loadHealth(autoOpenGuide = false) {
  state.env = await api('/api/health');
  renderEnv(autoOpenGuide);
}

async function loadState({ autoOpenAdd = false } = {}) {
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

  renderSidebar({ autoOpenAdd });
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

async function selectProject(projectId) {
  const prevProjectId = state.activeProjectId;
  if (!state.openTabIds.includes(projectId)) {
    state.openTabIds.push(projectId);
    saveOpenTabs();
  }
  state.activeProjectId = projectId;
  state.worktreeData = state.worktreeCache[projectId] || null;
  if (prevProjectId !== projectId && $('input-branch')) {
    $('input-branch').value = '';
  }
  renderSidebar();
  renderMainProject();
  renderWorktrees();
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
  await loadState({ autoOpenAdd: true });
  await refreshWorktrees();
}

async function deleteWorkspace(wsId) {
  await api(`/api/workspaces/${encodeURIComponent(wsId)}`, { method: 'DELETE' });
  await loadState({ autoOpenAdd: true });
  await refreshWorktrees();
}

async function switchWorktreeWithClobberPrompt(payload) {
  try {
    return await apiWithHookApproval('/api/worktrees/switch', payload);
  } catch (err) {
    const stderr = err.payload?.stderr || err.message || '';
    if (!err.approvalCancelled && !payload.clobber && /directory already exists|--clobber/i.test(stderr)) {
      appendLog(t('logFail', { target: err.payload?.command || payload.branch }), stderr);
      const confirmed = await showConfirm({
        title: t('clobberConfirmTitle'),
        message: t('clobberConfirm', { stderr }),
        danger: true,
      });
      if (confirmed) {
        return apiWithHookApproval('/api/worktrees/switch', { ...payload, clobber: true });
      }
      err.clobberCancelled = true;
    }
    throw err;
  }
}

async function openWorktreeRow(branch, shouldCreate, base = '', explicitToolId = '', displayLabel = '') {
  const active = getActiveProject();
  if (!active) return;
  const label = displayLabel || branch;
  const toolId = explicitToolId || getWorktreeTool(label)?.id || getWorktreeTool(branch)?.id || 'claude';
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
    showToast(t('openedWorktreeToast', { branch: label }), 'success');
    await refreshWorktrees();
  } catch (err) {
    if (!err.clobberCancelled && !err.approvalCancelled) {
      appendLog(t('logFail', { target: err.payload?.command || label }), err.payload?.stderr || err.message);
    }
    if (!err.approvalCancelled) {
      showToast(err.payload?.stderr || err.message, 'error');
    } else {
      showToast(err.message, 'info');
    }
  }
}

function setActionButtonBusy(btnEl, busyLabel, fallbackLabel) {
  if (!btnEl) return () => {};
  const labelEl = btnEl.querySelector('.btn-label') || btnEl;
  const badgeEl = btnEl.querySelector('.action-count-badge');
  const origLabel = labelEl.textContent;
  btnEl.disabled = true;
  labelEl.textContent = busyLabel;
  if (badgeEl) badgeEl.classList.add('hidden');
  return () => {
    btnEl.disabled = false;
    labelEl.textContent = origLabel || fallbackLabel;
    if (badgeEl) badgeEl.classList.remove('hidden');
  };
}

async function executePullRequest({ projectId, workDir, branch, autoPush = false }) {
  try {
    const res = await api('/api/worktrees/pull', {
      method: 'POST',
      body: JSON.stringify({ projectId, workDir, branch, autoPush }),
    });
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n');
    appendLog(t('pullSuccessLog', { cmd: res.command }), out);
    return { ok: true, res };
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
    return { ok: false, err };
  }
}

async function pullWorktreeRow(workDir, branch, btnEl) {
  const active = getActiveProject();
  if (!active || !workDir) return;
  const restoreBtn = setActionButtonBusy(btnEl, t('pullingBtn'), t('pullBtn'));
  try {
    const result = await executePullRequest({ projectId: active.id, workDir, branch });
    if (result.ok) {
      showToast(t('pullSuccessToast', { branch }), 'success');
      await refreshWorktrees();
    }
  } finally {
    restoreBtn();
  }
}

async function handlePushNonFastForward({ workDir, branch } = {}) {
  const active = getActiveProject();
  if (!active || !workDir) return false;

  const choice = await showPushRejectedDialog();
  if (choice === 'cancel') return false;

  if (choice === 'force') {
    try {
      const res = await api('/api/worktrees/push', {
        method: 'POST',
        body: JSON.stringify({
          projectId: active.id,
          workDir,
          branch,
          forceWithLease: true,
        }),
      });
      const out = [res.stdout, res.stderr].filter(Boolean).join('\n');
      appendLog(t('pushSuccessLog', { cmd: res.command }), out);
      showToast(t('pushForceSuccessToast', { branch: branch || res.branch || '' }), 'success');
      await refreshWorktrees();
      return true;
    } catch (err) {
      const out = [err.payload?.stdout, err.payload?.stderr].filter(Boolean).join('\n') || err.message;
      appendLog(t('pushFailLog', { cmd: err.payload?.command || '' }), out);
      showToast(t('pushFailToast', { msg: err.payload?.stderr || err.message }), 'error');
      return false;
    }
  }

  if (choice === 'pull') {
    const pullOutcome = await executePullRequest({
      projectId: active.id,
      workDir,
      branch,
      autoPush: true,
    });
    if (!pullOutcome.ok) return false;

    try {
      const pushRes = await api('/api/worktrees/push', {
        method: 'POST',
        body: JSON.stringify({
          projectId: active.id,
          workDir,
          branch,
        }),
      });
      const pushOut = [pushRes.stdout, pushRes.stderr].filter(Boolean).join('\n');
      appendLog(t('pushSuccessLog', { cmd: pushRes.command }), pushOut);
      showToast(t('pushPullSuccessToast', { branch: branch || pushRes.branch || '' }), 'success');
      await refreshWorktrees();
      return true;
    } catch (err) {
      const out = [err.payload?.stdout, err.payload?.stderr].filter(Boolean).join('\n') || err.message;
      appendLog(t('pushFailLog', { cmd: err.payload?.command || '' }), out);
      showToast(t('pushFailToast', { msg: err.payload?.stderr || err.message }), 'error');
      await refreshWorktrees();
      return false;
    }
  }

  return false;
}

async function handleAutoPushFailure(pushFailed, fallbackMsg = '') {
  if (!pushFailed) return false;
  if (pushFailed.nonFastForward) {
    return handlePushNonFastForward({
      workDir: pushFailed.workDir,
      branch: pushFailed.branch,
    });
  }
  showToast(t('pushFailToast', { msg: pushFailed.stderr || fallbackMsg }), 'error');
  return false;
}

async function pushWorktreeRow(workDir, branch, btnEl) {
  const active = getActiveProject();
  if (!active || !workDir) return;
  const restoreBtn = setActionButtonBusy(btnEl, t('pushingBtn'), t('pushBtn'));
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
    await refreshWorktrees();
  } catch (err) {
    const out = [err.payload?.stdout, err.payload?.stderr].filter(Boolean).join('\n') || err.message;
    appendLog(t('pushFailLog', { cmd: err.payload?.command || '' }), out);
    if (err.payload?.nonFastForward) {
      await handlePushNonFastForward({
        workDir: err.payload?.workDir || workDir,
        branch: err.payload?.branch || branch,
      });
    } else {
      showToast(t('pushFailToast', { msg: err.payload?.stderr || err.message }), 'error');
    }
  } finally {
    restoreBtn();
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

function openMergeModal(branch) {
  state.mergeTargetBranch = branch || null;
  populateMergeTargetSelect(branch || '');
  const defaultChecked = {
    'merge-auto-push': true,
    'merge-no-squash': false,
    'merge-no-ff': false,
    'merge-no-remove': true,
    'merge-no-hooks': false,
  };
  for (const [id, checked] of Object.entries(defaultChecked)) {
    if ($(id)) $(id).checked = checked;
  }
  openModal('modal-merge');
}

async function confirmMerge() {
  const active = getActiveProject();
  if (!active || !state.mergeTargetBranch) return;
  const btn = $('btn-confirm-merge');
  const target = $('merge-target').value.trim();

  const autoPush = Boolean($('merge-auto-push')?.checked);
  const payload = {
    projectId: active.id,
    branch: state.mergeTargetBranch,
    target,
    autoPush,
    noSquash: Boolean($('merge-no-squash')?.checked),
    noFf: Boolean($('merge-no-ff')?.checked),
    noRemove: Boolean($('merge-no-remove')?.checked),
    noHooks: Boolean($('merge-no-hooks')?.checked),
  };

  btn.disabled = true;
  try {
    const res = await apiWithHookApproval('/api/worktrees/merge', payload);
    appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('mergeSuccessToast', { branch: state.mergeTargetBranch }), 'success');
    closeModal('modal-merge');
    await refreshWorktrees();
  } catch (err) {
    if (err.approvalCancelled) {
      showToast(err.message, 'info');
      return;
    }
    appendLog(t('mergeFailLog', { cmd: err.payload?.command || '' }), err.payload?.stderr || err.message);
    if (err.payload?.hasConflicts && err.payload?.conflictSession) {
      closeModal('modal-merge');
      showToast(t('conflictDetectedToast'), 'info');
      await openConflictModal(err.payload.conflictSession);
      await refreshWorktrees();
    } else if (err.payload?.pushFailed) {
      closeModal('modal-merge');
      await refreshWorktrees();
      await handleAutoPushFailure(err.payload.pushFailed, err.payload?.stderr || err.message);
    } else {
      showToast(t('mergeFailToast', { msg: err.payload?.stderr || err.message }), 'error');
    }
  } finally {
    btn.disabled = false;
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
    operation: session.operation || null,
    wtMergeOptions: session.wtMergeOptions || null,
    autoPush,
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
      operation: res.status.operation || null,
      autoPush: false,
      files: res.status.files,
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

const ABORT_BTN_KEY_BY_OP = {
  rebase: 'abortRebaseBtn',
  merge: 'abortMergeBtn',
  cherry_pick: 'abortCherryPickBtn',
  revert: 'abortRevertBtn',
  bisect: 'abortBisectBtn',
};

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

  const abortBtn = $('btn-abort-conflict');
  if (abortBtn) {
    abortBtn.textContent = t(ABORT_BTN_KEY_BY_OP[cs.operation] || 'abortMergeBtn');
  }

  const completeBtn = $('btn-complete-conflict');
  if (completeBtn) {
    completeBtn.disabled = cs.unresolvedCount > 0;
    completeBtn.textContent =
      cs.operation === 'rebase' && cs.wtMergeOptions ? t('completeRebaseAndMergeBtn') : t('completeMergeBtn');
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

function loadMonacoEditor() {
  if (window.monaco?.editor) {
    registerMonacoConflictFeatures(window.monaco);
    return Promise.resolve(window.monaco);
  }
  if (conflictEditor.monacoPromise) {
    return conflictEditor.monacoPromise;
  }

  conflictEditor.monacoPromise = new Promise((resolvePromise, rejectPromise) => {
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

  return conflictEditor.monacoPromise;
}

function getRawConflictEditorValue() {
  if (conflictEditor.instance && !conflictEditor.fallbackMode) {
    return conflictEditor.instance.getValue();
  }
  return $('conflict-raw-textarea')?.value || '';
}

function hasConflictMarkers(text) {
  const src = String(text ?? '');
  const hasStart = /^<{7}(?:\s|$)/m.test(src);
  if (!hasStart) return false;
  return /^={7}\s*$/m.test(src) || /^>{7}(?:\s|$)/m.test(src);
}

function updateFallbackStatusBar(text, filePath) {
  const lang = detectMonacoLanguage(filePath);
  const blockMatches = hasConflictMarkers(text) ? String(text || '').match(/^<{7}(?:\s|$)/gm) : null;
  updateConflictEditorStatusBar(lang, blockMatches ? blockMatches.length : 0);
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
    updateFallbackStatusBar(fallbackTextarea?.value ?? content, filePath);
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
      // Re-read the active conflict session after awaiting async Monaco initialization
      const latestCs = state.conflictSession;
      if (!latestCs) return;
      const latestFile = latestCs.activeFile || filePath;
      const latestWorkDir = latestCs.workDir || workDir;
      const latestContent = latestCs.fileDetails?.content ?? content ?? '';
      const latestKey = `${latestWorkDir || ''}::${latestFile || ''}`;
      const latestLang = detectMonacoLanguage(latestFile);
      if (!conflictEditor.instance) {
        host.replaceChildren();
        const model = monaco.editor.createModel(latestContent, latestLang);
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
        conflictEditor.loadedFileKey = latestKey;
        conflictEditor.lastSyncedContent = latestContent;
        refreshMonacoConflictDecorations();
        requestAnimationFrame(() => editor.layout());
        document.fonts?.ready?.then(() => {
          monaco.editor.remeasureFonts?.();
          if (conflictEditor.instance === editor) {
            editor.layout();
          }
        });
        return;
      }
    } catch {
      const latestCs = state.conflictSession;
      const latestFile = latestCs?.activeFile || filePath;
      const latestContent = latestCs?.fileDetails?.content ?? content ?? '';
      const latestKey = `${latestCs?.workDir || workDir || ''}::${latestFile || ''}`;
      conflictEditor.fallbackMode = true;
      host.classList.add('hidden');
      if (fallbackTextarea) {
        fallbackTextarea.classList.remove('hidden');
        fallbackTextarea.value = latestContent;
        conflictEditor.loadedFileKey = latestKey;
        conflictEditor.lastSyncedContent = latestContent;
        updateFallbackStatusBar(latestContent, latestFile);
      }
      return;
    }
  }

  const editor = conflictEditor.instance;
  const monaco = window.monaco;
  const currentCs = state.conflictSession;
  if (!editor || !monaco || !currentCs) return;

  const finalFile = currentCs.activeFile || filePath;
  const finalWorkDir = currentCs.workDir || workDir;
  const finalContent = currentCs.fileDetails?.content ?? content ?? '';
  const finalKey = `${finalWorkDir || ''}::${finalFile || ''}`;
  const finalLang = detectMonacoLanguage(finalFile);

  const model = editor.getModel();
  if (model) {
    if (model.getLanguageId() !== finalLang) {
      monaco.editor.setModelLanguage(model, finalLang);
    }
    const shouldReplaceValue =
      conflictEditor.loadedFileKey !== finalKey || conflictEditor.lastSyncedContent !== finalContent;
    if (shouldReplaceValue && model.getValue() !== finalContent) {
      model.setValue(finalContent);
    }
  }
  conflictEditor.loadedFileKey = finalKey;
  conflictEditor.lastSyncedContent = finalContent;
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
    if (visualPane) {
      visualPane.innerHTML = '';
      if (cs.unresolvedCount === 0 && (!cs.files || cs.files.length === 0)) {
        const banner = document.createElement('div');
        banner.className = 'conflict-resolved-banner';
        banner.innerHTML = `<span>${escapeHtml(t('conflictPendingFinalizeBanner'))}</span>`;
        visualPane.appendChild(banner);
      }
    }
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
  if (hasConflictMarkers(content)) {
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

function setConflictActionControlsDisabled(disabled) {
  for (const id of [
    'btn-complete-conflict',
    'btn-ai-complete-conflict',
    'btn-abort-conflict',
    'btn-file-accept-ours',
    'btn-file-accept-theirs',
    'btn-save-conflict-file',
  ]) {
    if ($(id)) $(id).disabled = disabled;
  }
}

async function completeConflictResolution() {
  const active = getActiveProject();
  const cs = state.conflictSession;
  if (!active || !cs) return;

  setConflictActionControlsDisabled(true);
  try {
    const res = await api('/api/conflicts/complete', {
      method: 'POST',
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        sourceBranch: cs.sourceBranch,
        targetBranch: cs.targetBranch,
        wtMergeOptions: cs.wtMergeOptions || null,
        autoPush: Boolean($('conflict-auto-push')?.checked ?? cs.autoPush),
      }),
    });
    appendLog(t('mergeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('conflictCompleteSuccessToast'), 'success');
    closeModal('modal-conflict');
    state.conflictSession = null;
    await refreshWorktrees();
  } catch (err) {
    const msg = err.payload?.stderr || err.message;
    appendLog(t('mergeFailLog', { cmd: err.payload?.command || '' }), msg);
    if (err.payload?.hasMoreConflicts && err.payload?.status) {
      const nextStatus = err.payload.status;
      cs.files = nextStatus.files || [];
      cs.trackedFiles = cs.files.map((f) => f.path);
      cs.unresolvedCount = nextStatus.unresolvedCount ?? cs.files.filter((f) => !f.resolved).length;
      cs.operation = nextStatus.operation || cs.operation;
      cs.activeFile = cs.files.find((f) => !f.resolved)?.path || cs.files[0]?.path || '';
      cs.fileDetails = null;
      renderConflictHeaderAndSidebar();
      if (cs.activeFile) {
        await loadConflictFile(cs.activeFile);
      } else {
        renderConflictMainPane();
      }
      showToast(t('rebaseNextConflictToast'), 'info');
      await refreshWorktrees();
    } else if (err.payload?.pushFailed) {
      closeModal('modal-conflict');
      state.conflictSession = null;
      await refreshWorktrees();
      await handleAutoPushFailure(err.payload.pushFailed, msg);
    } else {
      showToast(t('mergeFailToast', { msg }), 'error');
    }
  } finally {
    setConflictActionControlsDisabled(false);
    if ($('btn-complete-conflict') && state.conflictSession) {
      $('btn-complete-conflict').disabled = state.conflictSession.unresolvedCount > 0;
    }
  }
}

let isAiProgressRunning = false;

function setAiProgressControlsLocked(locked) {
  isAiProgressRunning = Boolean(locked);
  const closeBtn = $('btn-ai-progress-close');
  const closeX = $('btn-ai-progress-close-x');
  if (closeBtn) closeBtn.disabled = isAiProgressRunning;
  if (closeX) closeX.disabled = isAiProgressRunning;
}

function closeAiProgressModal() {
  if (isAiProgressRunning) return;
  closeModal('modal-ai-progress');
}

function openAiProgressModal(model, totalFiles) {
  const badge = $('ai-progress-status-badge');
  const modelLabel = $('ai-progress-model-label');
  const counter = $('ai-progress-counter');
  const fill = $('ai-progress-fill');
  const steps = $('ai-progress-steps');

  if (badge) {
    badge.className = 'badge badge-info';
    badge.textContent = t('aiProgressStatusRunning');
  }
  if (modelLabel) modelLabel.textContent = model || '-';
  if (counter) counter.textContent = `0 / ${totalFiles}`;
  if (fill) {
    fill.className = 'ai-progress-fill';
    fill.style.width = '5%';
  }
  if (steps) steps.innerHTML = '';

  setAiProgressControlsLocked(true);
  openModal('modal-ai-progress');
}

function updateAiProgressBar(doneCount, totalFiles, stateClass = '') {
  const counter = $('ai-progress-counter');
  const fill = $('ai-progress-fill');
  if (counter && totalFiles >= 0) {
    counter.textContent = `${doneCount} / ${totalFiles}`;
  }
  if (fill) {
    const pct = stateClass === 'is-done'
      ? 100
      : totalFiles > 0
        ? Math.min(95, Math.max(8, Math.round((doneCount / totalFiles) * 90)))
        : 50;
    fill.style.width = `${pct}%`;
    fill.className = `ai-progress-fill${stateClass ? ` ${stateClass}` : ''}`;
  }
}

function appendAiProgressStep(text, status = 'running') {
  const steps = $('ai-progress-steps');
  if (!steps) return;
  const resolveRunningAsError = status === 'error';
  steps.querySelectorAll('.ai-progress-step.is-running').forEach((el) => {
    el.classList.remove('is-running');
    el.classList.add(resolveRunningAsError ? 'is-error' : 'is-done');
    const icon = el.querySelector('.ai-progress-step-icon');
    if (icon) icon.textContent = resolveRunningAsError ? '✕' : '✓';
  });

  const row = document.createElement('div');
  row.className = `ai-progress-step is-${status}`;
  const iconChar = status === 'done' ? '✓' : status === 'error' ? '✕' : '⏳';
  const timeStr = new Date().toLocaleTimeString();
  row.innerHTML = `
    <span class="ai-progress-step-icon">${iconChar}</span>
    <span class="ai-progress-step-text">${escapeHtml(text)}</span>
    <span class="ai-progress-step-time">${escapeHtml(timeStr)}</span>
  `;
  steps.appendChild(row);
  steps.scrollTop = steps.scrollHeight;
}

function finishAiProgressModal(ok) {
  const badge = $('ai-progress-status-badge');
  if (badge) {
    badge.className = `badge ${ok ? 'badge-success' : 'badge-danger'}`;
    badge.textContent = t(ok ? 'aiProgressStatusDone' : 'aiProgressStatusError');
  }
  setAiProgressControlsLocked(false);
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

  let totalFiles = cs.files.filter((f) => !f.resolved || f.unmerged || f.hunkCount > 0).length;
  let doneFiles = 0;
  openAiProgressModal(state.aiConfig.model, totalFiles);

  try {
    const resp = await fetch('/api/conflicts/ai-complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        projectId: active.id,
        workDir: cs.workDir,
        sourceBranch: cs.sourceBranch,
        targetBranch: cs.targetBranch,
        wtMergeOptions: cs.wtMergeOptions || null,
        autoPush: Boolean($('conflict-auto-push')?.checked ?? cs.autoPush),
        trackedFiles: cs.trackedFiles,
        stream: true,
      }),
    });

    if (!resp.ok || !resp.body) {
      const payload = await resp.json().catch(() => ({}));
      const err = new Error(payload.error || payload.stderr || `HTTP ${resp.status}`);
      err.payload = payload;
      throw err;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    const handleEvent = (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'start') {
        totalFiles = ev.totalFiles ?? totalFiles;
        updateAiProgressBar(0, totalFiles);
        if (totalFiles > 0) {
          appendAiProgressStep(t('aiProgressStepStart', { model: ev.model || state.aiConfig.model, count: totalFiles }), 'done');
        } else {
          appendAiProgressStep(t('aiProgressStepNoFiles'), 'done');
        }
      } else if (ev.type === 'file_start') {
        appendAiProgressStep(
          t('aiProgressStepFileStart', { index: ev.index, total: ev.total, file: ev.file, hunks: ev.hunkCount || 1 }),
          'running'
        );
      } else if (ev.type === 'file_ai_done') {
        const sec = ((ev.elapsedMs || 0) / 1000).toFixed(1);
        appendAiProgressStep(
          t('aiProgressStepFileAiDone', { index: ev.index, total: ev.total, file: ev.file, sec }),
          'running'
        );
      } else if (ev.type === 'file_done') {
        doneFiles = ev.index || doneFiles + 1;
        updateAiProgressBar(doneFiles, ev.total || totalFiles);
        appendAiProgressStep(
          t('aiProgressStepFileDone', { index: ev.index, total: ev.total, file: ev.file }),
          'done'
        );
      } else if (ev.type === 'commit_start') {
        appendAiProgressStep(t('aiProgressStepCommit'), 'running');
      } else if (ev.type === 'done') {
        finalResult = ev.result;
      } else if (ev.type === 'error') {
        const err = new Error(ev.error || ev.result?.stderr || 'AI Merge failed');
        err.payload = { ...(ev.result || {}), error: ev.error, status: ev.status };
        throw err;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const dataLines = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const parsed = JSON.parse(dataLines.join('\n'));
        handleEvent(parsed);
      }
    }
    if (buffer.trim()) {
      const dataLines = buffer
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length > 0) {
        handleEvent(JSON.parse(dataLines.join('\n')));
      }
    }

    if (!finalResult) {
      throw new Error('AI 合并响应中断，未收到完成结果');
    }

    updateAiProgressBar(totalFiles, totalFiles, 'is-done');
    appendAiProgressStep(t('aiProgressStepDone'), 'done');
    finishAiProgressModal(true);

    if (Array.isArray(finalResult.resolvedFiles) && finalResult.resolvedFiles.length > 0) {
      appendLog(
        t('aiConflictResolveLog', {
          model: finalResult.aiModel || state.aiConfig.model,
          files: finalResult.resolvedFiles.join(', '),
        })
      );
    }
    appendLog(t('mergeSuccessLog', { cmd: finalResult.command }), finalResult.stdout || finalResult.stderr);
    showToast(t('aiConflictCompleteSuccessToast'), 'success');
    closeModal('modal-conflict');
    state.conflictSession = null;
    await refreshWorktrees();
  } catch (err) {
    const msg = err.payload?.error || err.payload?.stderr || err.message;
    updateAiProgressBar(doneFiles, totalFiles, 'is-error');
    appendAiProgressStep(t('aiProgressStepFail', { msg }), 'error');
    finishAiProgressModal(false);
    appendLog(t('mergeFailLog', { cmd: err.payload?.command || 'AI Merge' }), msg);
    showToast(err.payload?.hasMoreConflicts ? t('rebaseNextConflictToast') : t('mergeFailToast', { msg }), err.payload?.hasMoreConflicts ? 'info' : 'error');
    if (err.payload?.status && state.conflictSession) {
      const nextStatus = err.payload.status;
      state.conflictSession.files = nextStatus.files || [];
      state.conflictSession.trackedFiles = state.conflictSession.files.map((f) => f.path);
      state.conflictSession.unresolvedCount = nextStatus.unresolvedCount ?? 0;
      state.conflictSession.operation = nextStatus.operation || state.conflictSession.operation;
      if (!state.conflictSession.files.some((f) => f.path === state.conflictSession.activeFile)) {
        state.conflictSession.activeFile = state.conflictSession.files[0]?.path || '';
      }
      renderConflictHeaderAndSidebar();
      if (state.conflictSession.activeFile) {
        await loadConflictFile(state.conflictSession.activeFile);
      } else {
        state.conflictSession.fileDetails = null;
        renderConflictMainPane();
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
  const confirmed = await showConfirm({
    title: t('abortMergeConfirmTitle'),
    message: t('abortMergeConfirm'),
    danger: true,
  });
  if (!confirmed) return;

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
    await refreshWorktrees();
  } catch (err) {
    showToast(err.payload?.stderr || err.message, 'error');
  }
}

async function removeWorktreeRow(branch, item = null) {
  const active = getActiveProject();
  if (!active) return;

  const lockInfo = item?.worktree?.locked;
  if (lockInfo) {
    const reasonSuffix = lockInfo.reason ? ` (${lockInfo.reason})` : '';
    showToast(t('removeLockedWarn', { reason: reasonSuffix }), 'error');
    return;
  }

  const confirmed = await showConfirm({
    title: t('removeWorktreeConfirmTitle'),
    message: t('removeWorktreeConfirm', { branch }),
    danger: true,
  });
  if (!confirmed) return;

  const runRemoveStep = async (opts = {}) =>
    apiWithHookApproval('/api/worktrees/remove', {
      projectId: active.id,
      branch,
      ...opts,
    });

  const handleBranchOutcome = async (res, alreadyApproved = false) => {
    const itemResult = Array.isArray(res.data) ? res.data[0] : res.data;
    const outcome = itemResult?.branch_outcome;

    if (outcome === 'retained_checked_out') {
      appendLog(t('removeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
      showToast(t('removeCheckedOutWarn', { path: itemResult?.branch_checked_out_at || '-' }), 'info');
      await refreshWorktrees();
      return true;
    }

    if (outcome === 'retained_raced') {
      const retry = await showConfirm({
        title: t('removeWorktreeConfirmTitle'),
        message: t('removeRacedConfirm'),
      });
      if (!retry) {
        await refreshWorktrees();
        return true;
      }
      const resRetry = await runRemoveStep({ approveHooks: alreadyApproved });
      return handleBranchOutcome(resRetry, alreadyApproved || resRetry.hookApproved);
    }

    if (outcome === 'retained_unmerged' || outcome === 'retained_failed') {
      const detail = res.stderr || res.stdout || outcome;
      appendLog(t('removeFailLog', { cmd: res.command }), detail);
      const confirmForceDel = await showConfirm({
        title: t('forceDeleteBranchConfirmTitle'),
        message: t('forceDeleteBranchConfirm', { stderr: detail }),
        danger: true,
      });
      if (!confirmForceDel) {
        await refreshWorktrees();
        return true;
      }
      const resDel = await runRemoveStep({ forceDelete: true, approveHooks: alreadyApproved });
      appendLog(t('forceRemoveSuccessLog', { cmd: resDel.command }), resDel.stdout || resDel.stderr);
      showToast(t('forceRemovedToast', { branch }), 'success');
      await refreshWorktrees();
      return true;
    }

    appendLog(t('removeSuccessLog', { cmd: res.command }), res.stdout || res.stderr);
    showToast(t('removedToast', { branch }), 'success');
    await refreshWorktrees();
    return true;
  };

  try {
    const res = await runRemoveStep();
    await handleBranchOutcome(res, Boolean(res.hookApproved));
  } catch (err) {
    if (err.approvalCancelled) {
      showToast(err.message, 'info');
      return;
    }
    const stderr = err.payload?.stderr || err.message;
    appendLog(t('removeFailLog', { cmd: err.payload?.command || '' }), stderr);

    if (/locked/i.test(stderr)) {
      showToast(t('removeLockedWarn', { reason: '' }), 'error');
      return;
    }

    const isUnmergedErr = /not fully merged|unmerged|use -D/i.test(stderr);
    const isDirtyErr = /uncommitted|untracked|modified|dirty|changes|--force/i.test(stderr);
    const confirmForce = await showConfirm({
      title: isUnmergedErr ? t('forceDeleteBranchConfirmTitle') : t('forceRemoveConfirmTitle'),
      message: isUnmergedErr
        ? t('forceDeleteBranchConfirm', { stderr })
        : isDirtyErr
          ? t('forceRemoveDirtyConfirm', { stderr })
          : t('forceRemoveConfirm', { stderr }),
      danger: true,
    });
    if (!confirmForce) return;

    try {
      const retryOpts = isUnmergedErr ? { forceDelete: true } : { force: true };
      const res2 = await runRemoveStep(retryOpts);
      const itemResult2 = Array.isArray(res2.data) ? res2.data[0] : res2.data;
      const outcome2 = itemResult2?.branch_outcome;
      if (!isUnmergedErr && (outcome2 === 'retained_unmerged' || outcome2 === 'retained_failed')) {
        await handleBranchOutcome(res2, Boolean(res2.hookApproved));
        return;
      }
      appendLog(t('forceRemoveSuccessLog', { cmd: res2.command }), res2.stdout || res2.stderr);
      showToast(t('forceRemovedToast', { branch }), 'success');
      await refreshWorktrees();
    } catch (err2) {
      if (err2.approvalCancelled) {
        showToast(err2.message, 'info');
      } else {
        showToast(err2.payload?.stderr || err2.message, 'error');
      }
    }
  }
}

// Browser modal
function openAddTargetModal() {
  const modal = $('modal-browser');
  if (!modal || !modal.classList.contains('hidden')) return;
  openModal('modal-browser');
  browseTo(state.browseCurrentPath);
}

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

function renderAiModelSelect(preferredModel = '') {
  const modelEl = $('ai-model');
  if (!modelEl) return;

  const targetModel = String(preferredModel ?? '').trim();
  const options = [...(Array.isArray(state.aiModels) ? state.aiModels : [])];
  if (targetModel && !options.includes(targetModel)) {
    options.unshift(targetModel);
  }

  modelEl.innerHTML = '';
  if (options.length === 0) {
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = t('aiModelSelectPlaceholder');
    modelEl.appendChild(placeholderOpt);
    modelEl.value = '';
    return;
  }

  for (const id of options) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    modelEl.appendChild(opt);
  }
  modelEl.value = targetModel && options.includes(targetModel) ? targetModel : options[0];
}

function renderAiConfigForm() {
  const urlEl = $('ai-url');
  const keyEl = $('ai-key');
  if (urlEl) urlEl.value = state.aiConfig?.url || '';
  if (keyEl) keyEl.value = state.aiConfig?.key || '';
  renderAiModelSelect(state.aiConfig?.model || '');
}

async function fetchAiModelsList() {
  const urlEl = $('ai-url');
  const keyEl = $('ai-key');
  const btnEl = $('btn-fetch-ai-models');
  const url = (urlEl?.value || '').trim();
  const key = (keyEl?.value || '').trim();

  if (!url) {
    showToast(t('aiUrlMissingWarn'), 'error');
    urlEl?.focus();
    return;
  }

  const prevSelected = ($('ai-model')?.value || state.aiConfig?.model || '').trim();
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = t('fetchingAiModelsBtn');
  }
  try {
    const res = await api('/api/ai-models', {
      method: 'POST',
      body: JSON.stringify({ url, key }),
    });
    const models = Array.isArray(res.models) ? res.models : [];
    state.aiModels = models;
    const nextModel = prevSelected && models.includes(prevSelected) ? prevSelected : models[0] || '';
    renderAiModelSelect(nextModel);
    showToast(t('fetchedAiModelsToast', { count: models.length }), 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = t('fetchAiModelsBtn');
    }
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

  $('modal-confirm-backdrop')?.addEventListener('click', () => settleConfirm(false));
  $('btn-confirm-close')?.addEventListener('click', () => settleConfirm(false));
  $('btn-confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  $('btn-confirm-ok')?.addEventListener('click', () => settleConfirm(true));

  $('modal-push-rejected-backdrop')?.addEventListener('click', () => settlePushRejected('cancel'));
  $('btn-push-rejected-close')?.addEventListener('click', () => settlePushRejected('cancel'));
  $('btn-push-rejected-cancel')?.addEventListener('click', () => settlePushRejected('cancel'));
  $('btn-push-rejected-force')?.addEventListener('click', () => settlePushRejected('force'));
  $('btn-push-rejected-pull')?.addEventListener('click', () => settlePushRejected('pull'));

  $('modal-ai-progress-backdrop')?.addEventListener('click', closeAiProgressModal);
  $('btn-ai-progress-close-x')?.addEventListener('click', closeAiProgressModal);
  $('btn-ai-progress-close')?.addEventListener('click', closeAiProgressModal);

  $('btn-add-target').addEventListener('click', openAddTargetModal);
  $('btn-toggle-sidebar')?.addEventListener('click', () => {
    const layoutEl = $('workspace-layout');
    const isCollapsed = Boolean(layoutEl?.classList.contains('sidebar-collapsed'));
    applySidebarCollapsed(!isCollapsed, true);
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
  $('toggle-branches').addEventListener('change', refreshWorktrees);

  $('switch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const active = getActiveProject();
    if (!active) return;
    const btn = $('btn-switch-submit');
    btn.disabled = true;
    try {
      const baseBranch = $('input-base').value.trim();
      const branchInput = $('input-branch');
      const customBranch = branchInput ? branchInput.value.trim() : '';
      const targetBranch = customBranch || generateRandomBranchName(baseBranch);
      const selectedToolId = $('select-tool').value;
      const res = await switchWorktreeWithClobberPrompt({
        projectId: active.id,
        branch: targetBranch,
        create: true,
        base: baseBranch,
        toolId: selectedToolId,
      });
      if (res.worktreeTools) {
        active.worktreeTools = res.worktreeTools;
      } else if (targetBranch && selectedToolId) {
        active.worktreeTools = { ...(active.worktreeTools || {}), [targetBranch]: selectedToolId };
      }
      if (branchInput) branchInput.value = '';
      appendLog(t('logExec', { cmd: res.command }), res.stdout || res.stderr || t('worktreePathLog', { path: res.worktreePath }));
      showToast(t('worktreeReadyToast'), 'success');
      await refreshWorktrees();
    } catch (err) {
      if (!err.clobberCancelled && !err.approvalCancelled) {
        appendLog(t('logFail', { target: err.payload?.command || '' }), err.payload?.stderr || err.message);
      }
      showToast(err.approvalCancelled ? err.message : err.payload?.stderr || err.message, err.approvalCancelled ? 'info' : 'error');
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
  $('conflict-raw-textarea')?.addEventListener('input', (e) => {
    if (conflictEditor.fallbackMode) {
      updateFallbackStatusBar(e.target.value, state.conflictSession?.activeFile || '');
    }
  });

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

  $('btn-fetch-ai-models')?.addEventListener('click', fetchAiModelsList);

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

  $('btn-copy-log')?.addEventListener('click', async () => {
    const text = $('command-log')?.textContent || '';
    const isInitial = !text.trim() || text === MESSAGES.zh.waitingAction || text === MESSAGES.en.waitingAction;
    if (isInitial) {
      showToast(t('copyLogEmptyToast'), 'info');
      return;
    }
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      }
      if (!copied) throw new Error('copy failed');
      showToast(t('copiedToClipboard'), 'success');
    } catch {
      showToast(t('copyLogFailToast'), 'error');
    }
  });

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
  renderAiModelSelect($('ai-model')?.value || state.aiConfig?.model || '');
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
  await Promise.all([loadHealth(true), loadState({ autoOpenAdd: true })]);
  await refreshWorktrees();
}

init().catch((err) => {
  showToast(err.message, 'error');
});

