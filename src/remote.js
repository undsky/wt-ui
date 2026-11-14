import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { formatCommand, runWt } from './wt-resolver.js';
import { getConflictStatus } from './conflict.js';
import { samePath } from './store.js';

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the given directory and return structured output.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeout?: number, env?: Record<string, string | undefined> }} [options]
 */
export async function runGit(cwd, args, options = {}) {
  const fullArgs = cwd ? ['-C', cwd, ...args] : [...args];
  try {
    const { stdout, stderr } = await execFileAsync('git', fullArgs, {
      timeout: options.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...(options.env || {}) },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      command: formatCommand('git', fullArgs),
    };
  } catch (err) {
    return {
      ok: false,
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      command: formatCommand('git', fullArgs),
    };
  }
}

/**
 * Parse `git worktree list --porcelain` to map checked-out branches to worktree paths.
 * Skips bare repository entries since they have no working tree checkout.
 * @param {string} repoPath
 * @returns {Promise<Array<{ path: string, head: string, branch: string | null, isMain: boolean }>>}
 */
export async function listGitWorktrees(repoPath) {
  const res = await runGit(repoPath, ['worktree', 'list', '--porcelain'], { timeout: 10_000 });
  if (!res.ok) return [];

  const worktrees = [];
  const blocks = res.stdout.trim().split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let wtPath = '';
    let head = '';
    let branch = null;
    let isBare = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = resolve(line.slice('worktree '.length).trim());
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line.trim() === 'bare') {
        isBare = true;
      }
    }
    if (wtPath && !isBare) {
      worktrees.push({
        path: wtPath,
        head,
        branch,
        isMain: worktrees.length === 0,
      });
    }
  }
  return worktrees;
}

/**
 * Detect the default branch of a repository via Worktrunk state first, falling back to Git heuristics.
 * @param {string} repoPath
 * @param {string[]} localBranches
 * @param {string} [wtBin]
 */
async function detectDefaultBranch(repoPath, localBranches, wtBin = '') {
  if (wtBin) {
    const wtRes = await runWt(wtBin, repoPath, ['config', 'state', 'default-branch'], { timeout: 5_000 });
    const detected = wtRes.ok ? wtRes.stdout.trim().split(/\r?\n/)[0]?.trim() : '';
    if (detected) return detected;
  }

  const symRef = await runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5_000 });
  if (symRef.ok) {
    const cleaned = symRef.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (cleaned) return cleaned;
  }

  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    if (localBranches.includes(candidate)) return candidate;
  }

  const currentRes = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
  const current = currentRes.stdout.trim();
  if (current && current !== 'HEAD') return current;

  return localBranches[0] || 'main';
}

const GIT_OP_PATHS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['SQUASH_MSG', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry_pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];

/**
 * Detect whether a worktree currently has an active in-progress Git operation.
 * Checks `rebase-merge` / `rebase-apply` directories rather than `REBASE_HEAD` alone,
 * because Git/tools can leave a stale `REBASE_HEAD` behind after a rebase finishes.
 * @param {string} workDir
 * @returns {Promise<'rebase' | 'merge' | 'cherry_pick' | 'revert' | 'bisect' | null>}
 */
export async function getWorktreeInProgressOp(workDir) {
  if (!workDir) return null;
  const args = ['rev-parse', ...GIT_OP_PATHS.flatMap(([name]) => ['--git-path', name])];
  const res = await runGit(workDir, args, { timeout: 5_000 });
  if (!res.ok) return null;
  const relPaths = res.stdout.split(/\r?\n/).map((s) => s.trim());
  for (let i = 0; i < GIT_OP_PATHS.length; i += 1) {
    const rel = relPaths[i];
    if (rel && existsSync(resolve(workDir, rel))) {
      return GIT_OP_PATHS[i][1];
    }
  }
  return null;
}

/**
 * When a local `wt merge` fails, inspect worktrees for active conflicts or materialize the merge
 * in the target worktree if `wt merge` refused/aborted due to merge conflicts.
 * @param {string} repoPath
 * @param {{
 *   sourceBranch: string,
 *   targetBranch?: string,
 *   noFf?: boolean,
 *   noSquash?: boolean,
 *   noRebase?: boolean,
 *   wtOutput?: string,
 *   wtBin?: string,
 *   wtMergeOptions?: Record<string, any> | null,
 * }} options
 */
export async function detectOrStartLocalConflictSession(repoPath, options) {
  const worktrees = await listGitWorktrees(repoPath);
  const localRefsRes = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const localBranches = localRefsRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultBranch = await detectDefaultBranch(repoPath, localBranches, options.wtBin);
  const mainWt =
    worktrees.find((w) => w.branch === defaultBranch) ||
    worktrees.find((w) => w.isMain) ||
    worktrees[0] ||
    { path: repoPath, branch: defaultBranch };
  const targetBranch = String(options.targetBranch || defaultBranch || mainWt.branch).trim();
  const sourceBranch = String(options.sourceBranch || '').trim();

  // Prefer checking the source worktree first (where `wt merge` leaves rebase conflicts), then target.
  const sortedWts = [...worktrees].sort((a, b) => {
    const aScore = a.branch === sourceBranch ? 2 : a.branch === targetBranch ? 1 : 0;
    const bScore = b.branch === sourceBranch ? 2 : b.branch === targetBranch ? 1 : 0;
    return bScore - aScore;
  });

  // 1. Check if any worktree already has unresolved files left by wt merge
  for (const wt of sortedWts) {
    const status = await getConflictStatus(wt.path);
    if (status.unresolvedCount > 0) {
      return {
        hasConflicts: true,
        conflictSession: {
          workDir: wt.path,
          sourceBranch,
          targetBranch,
          operation: status.operation,
          wtMergeOptions: options.wtMergeOptions || null,
          autoPush: false,
          files: status.files,
          unmergedFiles: status.unmergedFiles,
        },
      };
    }
  }

  // 1b. If a git operation is already in progress (e.g. staged conflicts awaiting --continue / --abort),
  // open the conflict modal for that worktree so the user can finish or abort it directly in the UI.
  for (const wt of sortedWts) {
    const inProgressOp = await getWorktreeInProgressOp(wt.path);
    if (inProgressOp) {
      const status = await getConflictStatus(wt.path);
      return {
        hasConflicts: true,
        conflictSession: {
          workDir: wt.path,
          sourceBranch,
          targetBranch,
          operation: status.operation || inProgressOp,
          wtMergeOptions: options.wtMergeOptions || null,
          autoPush: false,
          files: status.files,
          unmergedFiles: status.unmergedFiles,
        },
      };
    }
  }

  // 2. If `wt merge` aborted/refused because of merge conflicts without leaving an open state,
  // start `git merge` in target worktree when merge commit or squash merge is allowed.
  const looksLikeConflict = /conflict|冲突|unmerged|automatic merge failed/i.test(options.wtOutput || '');
  const onlyFastForwardAllowed = Boolean(options.noRebase && options.noSquash && !options.noFf);
  if (!looksLikeConflict || !sourceBranch || onlyFastForwardAllowed) {
    return { hasConflicts: false, conflictSession: null };
  }

  const targetWt = worktrees.find((w) => w.branch === targetBranch);
  if (!targetWt || targetWt.branch !== targetBranch) {
    return { hasConflicts: false, conflictSession: null };
  }

  const mergeArgs = ['merge'];
  if (options.noFf) mergeArgs.push('--no-ff');
  else if (!options.noSquash) mergeArgs.push('--squash');
  mergeArgs.push('--no-edit', sourceBranch);

  await runGit(targetWt.path, mergeArgs, { timeout: 30_000 });
  const afterStatus = await getConflictStatus(targetWt.path);
  if (afterStatus.unresolvedCount > 0) {
    const wtMergeOptions = options.wtMergeOptions
      ? { ...options.wtMergeOptions, alreadyMergedToTarget: true }
      : null;
    return {
      hasConflicts: true,
      conflictSession: {
        workDir: targetWt.path,
        sourceBranch,
        targetBranch,
        operation: afterStatus.operation || 'merge',
        wtMergeOptions,
        autoPush: false,
        files: afterStatus.files,
        unmergedFiles: afterStatus.unmergedFiles,
      },
    };
  }

  return { hasConflicts: false, conflictSession: null };
}

/**
 * Return `--no-rebase` when Git has no pull reconciliation preference configured,
 * avoiding `fatal: Need to specify how to reconcile divergent branches.` on diverged branches.
 * @param {string} workDir
 * @param {string} currentBranch
 */
async function getPullReconcileFlag(workDir, currentBranch) {
  const checks = [
    currentBranch ? ['config', '--get', `branch.${currentBranch}.rebase`] : null,
    ['config', '--get', 'pull.rebase'],
    ['config', '--get', 'pull.ff'],
  ].filter(Boolean);

  for (const args of checks) {
    const res = await runGit(workDir, args, { timeout: 5_000 });
    if (res.ok && res.stdout.trim()) {
      return [];
    }
  }
  return ['--no-rebase'];
}

async function resolveTargetWorktree(repoPath, options = {}) {
  const worktrees = await listGitWorktrees(repoPath);
  if (options.workDir) {
    const absWorkDir = resolve(options.workDir);
    const matched = worktrees.find((w) => samePath(w.path, absWorkDir));
    return matched || { path: absWorkDir, branch: options.branch || '' };
  }
  if (options.branch) {
    return worktrees.find((w) => w.branch === options.branch) || null;
  }
  return worktrees.find((w) => w.isMain) || worktrees[0] || { path: repoPath, branch: '' };
}

/**
 * Pull remote updates into a local worktree using `git pull --autostash`,
 * and detect any resulting merge or autostash conflicts.
 * @param {string} repoPath
 * @param {{ workDir?: string, branch?: string }} [options]
 */
export async function pullWorktreeBranch(repoPath, options = {}) {
  const targetWt = await resolveTargetWorktree(repoPath, options);
  if (!targetWt) {
    return {
      ok: false,
      hasConflicts: false,
      command: '',
      stdout: '',
      stderr: `分支 ${options.branch || ''} 当前没有检出到工作树，无法执行拉取`,
      conflictSession: null,
    };
  }

  const workDir = targetWt.path;
  let currentBranch = String(options.branch || targetWt.branch || '').trim();
  if (!currentBranch) {
    const revRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    currentBranch = revRes.stdout.trim();
  }

  // Guard against pulling while a Git operation is already in progress.
  const inProgressOp = await getWorktreeInProgressOp(workDir);
  if (inProgressOp) {
    const opLabels = {
      rebase: ['变基 (rebase)', 'git rebase --continue / --abort'],
      merge: ['合并 (merge)', 'git commit / git merge --abort'],
      cherry_pick: ['拣选 (cherry-pick)', 'git cherry-pick --continue / --abort'],
      revert: ['还原 (revert)', 'git revert --continue / --abort'],
      bisect: ['二分查找 (bisect)', 'git bisect reset'],
    };
    const [opName, hintCmd] = opLabels[inProgressOp] || ['Git 操作', 'git status'];
    return {
      ok: false,
      hasConflicts: false,
      command: formatCommand('git', ['-C', workDir, 'status']),
      stdout: '',
      stderr: `当前工作树存在未完成的${opName}，无法直接拉取。请点击「解决冲突」中的完成或放弃操作收尾（或终端执行 ${hintCmd}），切勿点击「移除」。`,
      conflictSession: null,
    };
  }

  // Check if an upstream tracking branch is configured
  const [upstreamRes, reconcileFlag] = await Promise.all([
    runGit(workDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { timeout: 5_000 }),
    getPullReconcileFlag(workDir, currentBranch),
  ]);

  let pullArgs;
  let sourceBranchLabel = '';
  if (upstreamRes.ok && upstreamRes.stdout.trim()) {
    sourceBranchLabel = upstreamRes.stdout.trim();
    pullArgs = ['pull', ...reconcileFlag, '--autostash'];
  } else {
    const remoteRes = await runGit(workDir, ['remote'], { timeout: 5_000 });
    const firstRemote = remoteRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (!firstRemote) {
      return {
        ok: false,
        hasConflicts: false,
        command: remoteRes.command,
        stdout: '',
        stderr: '当前仓库未配置任何远程仓库 (remote)，无法拉取。',
        conflictSession: null,
      };
    }
    if (currentBranch) {
      const lsRes = await runGit(
        workDir,
        ['ls-remote', '--heads', firstRemote, `refs/heads/${currentBranch}`],
        { timeout: 10_000 }
      );
      if (lsRes.ok && !lsRes.stdout.trim()) {
        return {
          ok: false,
          hasConflicts: false,
          command: lsRes.command,
          stdout: '',
          stderr: `远程分支 ${firstRemote}/${currentBranch} 不存在（该本地分支尚未推送到远端），请先点击「推送」创建远程分支。`,
          conflictSession: null,
        };
      }
    }
    sourceBranchLabel = currentBranch ? `${firstRemote}/${currentBranch}` : firstRemote;
    pullArgs = currentBranch
      ? ['pull', ...reconcileFlag, '--autostash', firstRemote, currentBranch]
      : ['pull', ...reconcileFlag, '--autostash'];
  }

  const pullRes = await runGit(workDir, pullArgs, { timeout: 60_000 });
  const conflictStatus = await getConflictStatus(workDir);

  if (conflictStatus.unresolvedCount > 0) {
    return {
      ok: false,
      hasConflicts: true,
      command: pullRes.command,
      stdout: pullRes.stdout,
      stderr: pullRes.stderr,
      conflictSession: {
        workDir,
        sourceBranch: sourceBranchLabel,
        targetBranch: currentBranch || 'HEAD',
        operation: conflictStatus.operation || 'merge',
        autoPush: Boolean(options.autoPush),
        files: conflictStatus.files,
        unmergedFiles: conflictStatus.unmergedFiles,
      },
    };
  }

  return {
    ok: pullRes.ok,
    hasConflicts: false,
    command: pullRes.command,
    stdout: pullRes.stdout,
    stderr: pullRes.stderr,
    conflictSession: null,
  };
}

/**
 * Detect whether a git push failure was caused by a non-fast-forward / fetch-first rejection.
 * @param {string} [stderr]
 * @param {string} [stdout]
 * @returns {boolean}
 */
export function isNonFastForwardPushError(stderr = '', stdout = '') {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  return (
    /\[rejected\][^\n]*(?:non-fast-forward|fetch first)/i.test(combined) ||
    /updates were rejected because (?:a pushed branch tip is behind|the tip of your current branch is behind|the remote contains work)/i.test(
      combined
    )
  );
}

/**
 * Push a local worktree branch to its remote (`git push` or `git push -u <remote> <branch>`).
 * @param {string} repoPath
 * @param {{ workDir?: string, branch?: string, forceWithLease?: boolean }} [options]
 */
export async function pushWorktreeBranch(repoPath, options = {}) {
  const targetWt = await resolveTargetWorktree(repoPath, options);
  const forceWithLease = Boolean(options.forceWithLease);
  const forceArgs = forceWithLease ? ['--force-with-lease'] : [];

  if (!targetWt && options.branch) {
    const branch = String(options.branch).trim();
    const configuredRemoteRes = await runGit(repoPath, ['config', '--get', `branch.${branch}.remote`], {
      timeout: 5_000,
    });
    let remoteName = configuredRemoteRes.ok ? configuredRemoteRes.stdout.trim() : '';
    if (!remoteName) {
      const remoteRes = await runGit(repoPath, ['remote'], { timeout: 5_000 });
      remoteName =
        remoteRes.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) || 'origin';
    }
    const trackingArgs = configuredRemoteRes.ok ? [] : ['-u'];
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const pushRes = await runGit(repoPath, ['push', ...forceArgs, ...trackingArgs, remoteName, refspec], {
      timeout: 60_000,
    });
    return {
      ...pushRes,
      workDir: repoPath,
      branch,
      forceWithLease,
      nonFastForward: !pushRes.ok && isNonFastForwardPushError(pushRes.stderr, pushRes.stdout),
    };
  }

  const workDir = targetWt.path;
  const headRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
  const headBranch = headRes.ok ? headRes.stdout.trim() : '';
  const currentBranch = String(options.branch || targetWt.branch || headBranch || '').trim();

  const upstreamRes = await runGit(
    workDir,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { timeout: 5_000 }
  );

  let pushArgs;
  if (upstreamRes.ok && upstreamRes.stdout.trim()) {
    const [remoteCfg, mergeCfg] =
      headBranch && headBranch !== 'HEAD'
        ? await Promise.all([
            runGit(workDir, ['config', '--get', `branch.${headBranch}.remote`], { timeout: 5_000 }),
            runGit(workDir, ['config', '--get', `branch.${headBranch}.merge`], { timeout: 5_000 }),
          ])
        : [{ ok: false, stdout: '' }, { ok: false, stdout: '' }];
    const upstreamRemote = remoteCfg.ok ? remoteCfg.stdout.trim() : '';
    const upstreamMerge = mergeCfg.ok ? mergeCfg.stdout.trim() : '';
    const upstreamShort = upstreamMerge.replace(/^refs\/heads\//, '');
    if (upstreamRemote && upstreamMerge && upstreamShort && upstreamShort !== headBranch) {
      pushArgs = ['push', ...forceArgs, upstreamRemote, `HEAD:${upstreamMerge}`];
    } else {
      pushArgs = ['push', ...forceArgs];
    }
  } else {
    const remoteRes = await runGit(workDir, ['remote'], { timeout: 5_000 });
    const firstRemote =
      remoteRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) || 'origin';
    const pushBranch = headBranch && headBranch !== 'HEAD' ? headBranch : currentBranch;
    pushArgs = pushBranch
      ? ['push', ...forceArgs, '-u', firstRemote, pushBranch]
      : ['push', ...forceArgs];
  }

  const pushRes = await runGit(workDir, pushArgs, { timeout: 60_000 });
  return {
    ...pushRes,
    workDir,
    branch: currentBranch,
    forceWithLease,
    nonFastForward: !pushRes.ok && isNonFastForwardPushError(pushRes.stderr, pushRes.stdout),
  };
}

