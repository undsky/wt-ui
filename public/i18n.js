const LANG_STORAGE_KEY = 'wt-ui-lang';

export const MESSAGES = {
  zh: {
    pageTitle: 'wt-ui — Worktrunk 可视化工作树平台',
    brandSub: 'Worktrunk 可视化操作平台',
    envChecking: '检查环境中...',
    manageTools: '工具配置',
    langToggleLabel: '中文',
    langToggleTitle: '当前：中文，点击切换到 English',
    themeLightTitle: '当前：白天模式，点击切换到黑夜模式',
    themeDarkTitle: '当前：黑夜模式，点击切换到白天模式',
    viewInstallGuide: '查看安装引导',
    recheckEnv: '重新检测',
    sidebarTitle: '项目与工作区',
    addBtn: '+ 添加',
    emptySidebarHint: '点击上方「+ 添加」选择项目文件夹或 .code-workspace 文件',
    welcomeTitle: '欢迎使用 wt-ui',
    welcomeDesc: '选择一个 Git 项目文件夹或 VS Code / Cursor 的 <code>.code-workspace</code> 工作区文件，即可可视化创建工作树、用 CLI/GUI 工具打开开发，并在完成后一键合并。',
    chooseProjectOrWs: '选择项目或工作区',
    openTabsLabel: '已打开的项目',
    branchNameLabel: '分支名称',
    branchPlaceholder: '例如 main_20261113102530',
    generateBtn: '生成',
    generateBtnTitle: '根据基于分支和当前时间戳重新生成',
    baseBranchLabel: '基于分支 (--base)',
    selectToolLabel: '选择打开工具 (CLI / GUI)',
    createNewBranchHtml: '创建新分支 (<code>-c</code>)',
    createAndOpen: '创建并打开',
    commandLogTitle: '命令执行日志',
    clearBtn: '清空',
    waitingAction: '等待操作...',
    worktreeListTitle: '工作树列表',
    mergeAllBtn: '全部合并',
    showUnlinkedBranches: '显示无工作树分支',
    refreshList: '刷新列表',
    colBranchStatus: '分支与状态',
    colDiffDefault: '与默认分支差异',
    colLatestCommit: '最近提交',
    colWorktreePath: '工作树路径',
    colActions: '操作',
    browserModalTitle: '添加项目文件夹或工作区 (.code-workspace)',
    parentDirBtn: '上级目录',
    browsePathPlaceholder: '输入目录路径后按回车跳转，或点击下方选择',
    addCurrentPathBtn: '添加当前路径',
    pickFolderBtn: '选择本地文件夹...',
    pickWorkspaceBtn: '选择 .code-workspace 文件...',
    mergeModalTitle: '一键合并分支',
    mergeAllModalTitle: '全部合并工作树',
    mergeSummaryHtml: '将分支 <code id="merge-source-branch"></code> 合并到目标分支：',
    mergeTargetLabel: '目标分支',
    mergeNoSquashHtml: '保留提交历史 (<code>--no-squash</code>)',
    mergeNoRebaseHtml: '跳过变基 (<code>--no-rebase</code>)',
    mergeNoFfHtml: '创建合并提交 (<code>--no-ff</code>)',
    mergeNoRemoveHtml: '合并后保留工作树 (<code>--no-remove</code>)',
    mergeNoHooksHtml: '跳过钩子 (<code>--no-hooks</code>)',
    cancelBtn: '取消',
    confirmMergeBtn: '确认合并',
    toolsModalTitle: '开发工具配置',
    toolKindLabel: '类型',
    toolKindCliOption: '命令行 (CLI)',
    toolKindGuiOption: '图形界面 (GUI)',
    toolNameLabel: '名称',
    toolCmdLabel: '可执行命令',
    toolArgsLabel: '默认参数',
    toolArgsPlaceholder: '如 .',
    addToolBtn: '添加工具',
    saveChangesBtn: '保存修改',
    installModalTitle: 'Worktrunk 安装与环境引导',
    autoInstallBtn: '国内源自动安装',
    recheckEnvModalBtn: '重新检测环境',
    closeBtn: '关闭',

    // Dynamic strings
    requestFailed: '请求失败 ({status})',
    autoInstallingBadge: '正在通过国内源自动安装 wt...',
    autoInstallingToast: '未检测到 Worktrunk，正在通过国内源自动安装...',
    autoInstallSuccessLog: 'Worktrunk 自动安装成功',
    autoInstallSuccessToast: 'Worktrunk 自动安装完成',
    autoInstallFailLog: 'Worktrunk 自动安装失败',
    autoInstallFailToast: '自动安装失败: {msg}',
    notInstalled: '未安装',
    envCheckNotice: '环境检查提示: {issues}',
    installGuideWtMissing: '未检测到 Worktrunk (<code>wt</code>)。请先在终端运行以下任一命令安装，然后点击「重新检测环境」：',
    copyCommand: '复制命令',
    gitUpgradeTitle: 'Git 版本升级 (要求 >= 2.43.0，当前 {version})',
    unknown: '未知',
    envReadyText: 'Worktrunk 与 Git 环境均已就绪。',
    officialDocs: '官方文档：',
    copiedToClipboard: '已复制到剪贴板',
    copyManually: '请手动复制: {cmd}',
    cliToolsGroup: '命令行工具 (CLI)',
    guiToolsGroup: '图形界面工具 (GUI)',
    removeProjectTitle: '移除项目',
    workspacePrefix: '工作区: {name}',
    removeWorkspaceTitle: '移除整个工作区',
    closeTabTitle: '关闭标签页',
    closeTabAria: '关闭 {name}',
    mainWorktreeTag: '主工作树',
    defaultBranchTag: '默认分支',
    noWorktreeData: '暂无工作树数据（请检查上方环境提示或点击刷新）',
    noWorktreeTag: '未创建工作树',
    conflictTag: '冲突 ✘',
    stagedTag: '已暂存 +',
    modifiedTag: '有修改 !',
    untrackedTag: '未跟踪 ?',
    mergedTag: '已合并 ({reason})',
    mergeConflictRisk: '合并冲突风险',
    baseBranchTag: '基准分支',
    noDiff: '无差异',
    openWithTool: '用 {tool} 打开',
    toolFallback: '工具',
    oneClickMerge: '一键合并',
    removeBtn: '移除',
    fetchWorktreesFail: '获取工作树列表失败',
    logExec: '执行: {cmd}',
    openedFallback: '已打开',
    openedWorktreeToast: '已打开工作树 {branch}',
    logFail: '失败: {target}',
    mergeSuccessLog: '合并成功: {cmd}',
    mergeSuccessToast: '分支 {branch} 已成功合并',
    mergeFailLog: '合并失败: {cmd}',
    mergeFailToast: '合并失败: {msg}',
    noMergeableBranchesToast: '没有可合并的工作树分支',
    mergeAllSuccessToast: '已全部合并 {count} 个工作树分支到 {target}',
    mergeAllPartialFailToast: '已合并 {done}/{total} 个，{branch} 合并失败: {msg}',
    mergingProgressBtn: '合并中 ({done}/{total})...',
    removeSuccessLog: '移除成功: {cmd}',
    removedToast: '已移除 {branch}',
    removeFailLog: '移除失败: {cmd}',
    forceRemoveConfirm: '常规移除失败：\n{stderr}\n\n是否强制删除工作树和未合并分支 (--force -D)？',
    forceRemoveSuccessLog: '强制移除成功: {cmd}',
    forceRemovedToast: '已强制移除 {branch}',
    emptyDir: '空目录',
    gitRepoBadge: 'Git 仓库',
    importWorkspaceBtn: '导入工作区',
    selectProjectBtn: '选择项目',
    enterOrSelectPath: '请输入或选择路径',
    importedWorkspaceToast: '已导入工作区 {name} ({count} 个项目)',
    addedProjectToast: '已添加项目 {name}',
    clickToEditTool: '点击编辑此工具',
    deleteBtn: '删除',
    deletedCustomToolToast: '已删除自定义工具',
    worktreePathLog: '工作树路径: {path}',
    worktreeReadyToast: '工作树已就绪并启动工具',
    updatedToolToast: '已更新工具配置',
    addedToolToast: '已添加自定义工具',
    envCheckPassToast: '环境检测通过，Worktrunk 已就绪',
    envCheckFailToast: '仍未满足环境要求，请查看提示',
  },
  en: {
    pageTitle: 'wt-ui — Worktrunk Visual Worktree Console',
    brandSub: 'Worktrunk Visual Console',
    envChecking: 'Checking environment...',
    manageTools: 'Tools',
    langToggleLabel: 'EN',
    langToggleTitle: 'Language: English, click to switch to 中文',
    themeLightTitle: 'Theme: Light mode, click to switch to Dark mode',
    themeDarkTitle: 'Theme: Dark mode, click to switch to Light mode',
    viewInstallGuide: 'Install Guide',
    recheckEnv: 'Recheck',
    sidebarTitle: 'Projects & Workspaces',
    addBtn: '+ Add',
    emptySidebarHint: 'Click "+ Add" above to select a project folder or .code-workspace file',
    welcomeTitle: 'Welcome to wt-ui',
    welcomeDesc: 'Select a Git repository folder or a VS Code / Cursor <code>.code-workspace</code> file to visually create worktrees, launch them in CLI/GUI tools, and merge with one click.',
    chooseProjectOrWs: 'Select Project or Workspace',
    openTabsLabel: 'Open projects',
    branchNameLabel: 'Branch Name',
    branchPlaceholder: 'e.g. main_20261113102530',
    generateBtn: 'Generate',
    generateBtnTitle: 'Regenerate from base branch and current timestamp',
    baseBranchLabel: 'Base Branch (--base)',
    selectToolLabel: 'Open With Tool (CLI / GUI)',
    createNewBranchHtml: 'Create new branch (<code>-c</code>)',
    createAndOpen: 'Create & Open',
    commandLogTitle: 'Command Log',
    clearBtn: 'Clear',
    waitingAction: 'Waiting for action...',
    worktreeListTitle: 'Worktrees',
    mergeAllBtn: 'Merge All',
    showUnlinkedBranches: 'Show branches without worktree',
    refreshList: 'Refresh',
    colBranchStatus: 'Branch & Status',
    colDiffDefault: 'Diff vs Default',
    colLatestCommit: 'Latest Commit',
    colWorktreePath: 'Worktree Path',
    colActions: 'Actions',
    browserModalTitle: 'Add Project Folder or Workspace (.code-workspace)',
    parentDirBtn: 'Up',
    browsePathPlaceholder: 'Enter directory path and press Enter, or select below',
    addCurrentPathBtn: 'Add Current Path',
    pickFolderBtn: 'Choose Local Folder...',
    pickWorkspaceBtn: 'Choose .code-workspace File...',
    mergeModalTitle: 'Merge Branch',
    mergeAllModalTitle: 'Merge All Worktrees',
    mergeSummaryHtml: 'Merge branch <code id="merge-source-branch"></code> into target branch:',
    mergeTargetLabel: 'Target branch',
    mergeNoSquashHtml: 'Keep commit history (<code>--no-squash</code>)',
    mergeNoRebaseHtml: 'Skip rebase (<code>--no-rebase</code>)',
    mergeNoFfHtml: 'Create merge commit (<code>--no-ff</code>)',
    mergeNoRemoveHtml: 'Keep worktree after merge (<code>--no-remove</code>)',
    mergeNoHooksHtml: 'Skip hooks (<code>--no-hooks</code>)',
    cancelBtn: 'Cancel',
    confirmMergeBtn: 'Confirm Merge',
    toolsModalTitle: 'Developer Tools',
    toolKindLabel: 'Type',
    toolKindCliOption: 'CLI Tool',
    toolKindGuiOption: 'GUI Tool',
    toolNameLabel: 'Name',
    toolCmdLabel: 'Command',
    toolArgsLabel: 'Default Args',
    toolArgsPlaceholder: 'e.g. .',
    addToolBtn: 'Add Tool',
    saveChangesBtn: 'Save Changes',
    installModalTitle: 'Worktrunk Setup & Environment Guide',
    autoInstallBtn: 'Auto Install (CN Mirror)',
    recheckEnvModalBtn: 'Recheck Environment',
    closeBtn: 'Close',

    // Dynamic strings
    requestFailed: 'Request failed ({status})',
    autoInstallingBadge: 'Installing wt via mirror...',
    autoInstallingToast: 'Worktrunk not found, auto-installing via mirror...',
    autoInstallSuccessLog: 'Worktrunk installed successfully',
    autoInstallSuccessToast: 'Worktrunk installation completed',
    autoInstallFailLog: 'Worktrunk auto-install failed',
    autoInstallFailToast: 'Auto-install failed: {msg}',
    notInstalled: 'Not installed',
    envCheckNotice: 'Environment notice: {issues}',
    installGuideWtMissing: 'Worktrunk (<code>wt</code>) was not detected. Run any command below in your terminal, then click "Recheck Environment":',
    copyCommand: 'Copy',
    gitUpgradeTitle: 'Git upgrade required (>= 2.43.0, current {version})',
    unknown: 'unknown',
    envReadyText: 'Worktrunk and Git are ready.',
    officialDocs: 'Official Docs: ',
    copiedToClipboard: 'Copied to clipboard',
    copyManually: 'Please copy manually: {cmd}',
    cliToolsGroup: 'CLI Tools',
    guiToolsGroup: 'GUI Tools',
    removeProjectTitle: 'Remove project',
    workspacePrefix: 'Workspace: {name}',
    removeWorkspaceTitle: 'Remove workspace',
    closeTabTitle: 'Close tab',
    closeTabAria: 'Close {name}',
    mainWorktreeTag: 'Main',
    defaultBranchTag: 'Default',
    noWorktreeData: 'No worktree data (check environment notice above or click Refresh)',
    noWorktreeTag: 'No worktree',
    conflictTag: 'Conflict ✘',
    stagedTag: 'Staged +',
    modifiedTag: 'Modified !',
    untrackedTag: 'Untracked ?',
    mergedTag: 'Merged ({reason})',
    mergeConflictRisk: 'Merge conflict risk',
    baseBranchTag: 'Base branch',
    noDiff: 'No diff',
    openWithTool: 'Open in {tool}',
    toolFallback: 'Tool',
    oneClickMerge: 'Merge',
    removeBtn: 'Remove',
    fetchWorktreesFail: 'Failed to load worktree list',
    logExec: 'Run: {cmd}',
    openedFallback: 'Opened',
    openedWorktreeToast: 'Opened worktree {branch}',
    logFail: 'Failed: {target}',
    mergeSuccessLog: 'Merged: {cmd}',
    mergeSuccessToast: 'Branch {branch} merged successfully',
    mergeFailLog: 'Merge failed: {cmd}',
    mergeFailToast: 'Merge failed: {msg}',
    noMergeableBranchesToast: 'No mergeable worktree branches',
    mergeAllSuccessToast: 'Merged all {count} worktree branches into {target}',
    mergeAllPartialFailToast: 'Merged {done}/{total}, failed on {branch}: {msg}',
    mergingProgressBtn: 'Merging ({done}/{total})...',
    removeSuccessLog: 'Removed: {cmd}',
    removedToast: 'Removed {branch}',
    removeFailLog: 'Remove failed: {cmd}',
    forceRemoveConfirm: 'Normal removal failed:\n{stderr}\n\nForce remove worktree and delete unmerged branch (--force -D)?',
    forceRemoveSuccessLog: 'Force removed: {cmd}',
    forceRemovedToast: 'Force removed {branch}',
    emptyDir: 'Empty directory',
    gitRepoBadge: 'Git Repo',
    importWorkspaceBtn: 'Import Workspace',
    selectProjectBtn: 'Select Project',
    enterOrSelectPath: 'Please enter or select a path',
    importedWorkspaceToast: 'Imported workspace {name} ({count} projects)',
    addedProjectToast: 'Added project {name}',
    clickToEditTool: 'Click to edit tool',
    deleteBtn: 'Delete',
    deletedCustomToolToast: 'Deleted custom tool',
    worktreePathLog: 'Worktree path: {path}',
    worktreeReadyToast: 'Worktree ready and tool launched',
    updatedToolToast: 'Tool configuration updated',
    addedToolToast: 'Custom tool added',
    envCheckPassToast: 'Environment check passed, Worktrunk is ready',
    envCheckFailToast: 'Environment requirements still not met',
  },
};

export function detectSystemLang() {
  try {
    const raw = (navigator.language || navigator.userLanguage || '').toLowerCase();
    return raw.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function getLang() {
  const fromDom = document.documentElement.dataset.lang;
  if (fromDom === 'zh' || fromDom === 'en') return fromDom;
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // ignore storage errors
  }
  return detectSystemLang();
}

export function setLang(lang, persist = true) {
  const next = lang === 'en' ? 'en' : 'zh';
  document.documentElement.dataset.lang = next;
  document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
  if (persist) {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
  }
  applyStaticI18n();
  return next;
}

export function t(key, params = {}) {
  const lang = getLang();
  const dict = MESSAGES[lang] || MESSAGES.en;
  let str = dict[key] ?? MESSAGES.zh[key] ?? key;
  for (const [k, v] of Object.entries(params)) {
    str = str.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return str;
}

export function applyStaticI18n() {
  document.title = t('pageTitle');

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
  });

  const langBtn = document.getElementById('btn-lang-toggle');
  if (langBtn) {
    langBtn.textContent = t('langToggleLabel');
    langBtn.title = t('langToggleTitle');
    langBtn.setAttribute('aria-label', t('langToggleTitle'));
  }
}

