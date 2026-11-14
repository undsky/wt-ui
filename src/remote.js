import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { formatCommand } from './wt-resolver.js';
import { getConflictStatus } from './conflict.js';
import { samePath } from './store.js';

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the given directory and return structured output.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeout?: number }} [options]
 */
export async function runGit(cwd, args, options = {}) {
  const fullArgs = cwd ? ['-C', cwd, ...args] : [...args];
  try {
    const { stdout, stderr } = await execFileAsync('git', fullArgs, {
      timeout: options.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
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
 * Parse `git worktree list --porcelain` to map local branches to worktree paths.
 * @param {string} repoPath
 * @returns {Promise<Array<{ path: string, head: string, branch: string | null, isMain: boolean }>>}
 */
export async function listGitWorktrees(repoPath) {
  const res = await runGit(repoPath, ['worktree', 'list', '--porcelain'], { timeout: 10_000 });
  if (!res.ok) return [];

  const worktrees = [];
  const blocks = res.stdout.trim().split(/\r?\n\r?\n/);
  blocks.forEach((block, idx) => {
    const lines = block.split(/\r?\n/);
    let wtPath = '';
    let head = '';
    let branch = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = resolve(line.slice('worktree '.length).trim());
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      }
    }
    if (wtPath) {
      worktrees.push({
        path: wtPath,
        head,
        branch,
        isMain: idx === 0,
      });
    }
  });
  return worktrees;
}

/**
 * Detect the default branch of a repository (e.g. main or master).
 * @param {string} repoPath
 * @param {string[]} localBranches
 * @param {Array<{ remote: string, name: string }>} remoteBranches
 */
async function detectDefaultBranch(repoPath, localBranches, remoteBranches) {
  const symRef = await runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'], { timeout: 5_000 });
  if (symRef.ok) {
    const cleaned = symRef.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (cleaned) return cleaned;
  }

  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    if (localBranches.includes(candidate)) return candidate;
    if (remoteBranches.some((r) => r.name === candidate)) return candidate;
  }

  const currentRes = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
  const current = currentRes.stdout.trim();
  if (current && current !== 'HEAD') return current;

  return localBranches[0] || remoteBranches[0]?.name || 'main';
}

/**
 * Parse `git diff --shortstat` output into added and deleted line counts.
 * @param {string} text
 */
function parseShortStat(text) {
  if (!text) return { filesChanged: 0, added: 0, deleted: 0 };
  const filesMatch = text.match(/(\d+)\s+files?\s+changed/i);
  const addMatch = text.match(/(\d+)\s+insertions?\(\+\)/i);
  const delMatch = text.match(/(\d+)\s+deletions?\(-\)/i);
  return {
    filesChanged: filesMatch ? Number(filesMatch[1]) : 0,
    added: addMatch ? Number(addMatch[1]) : 0,
    deleted: delMatch ? Number(delMatch[1]) : 0,
  };
}

/**
 * List remote branches (`refs/remotes/*`) and compare each against the target/default branch.
 * @param {string} repoPath
 * @param {{ fetch?: boolean, targetBranch?: string }} [options]
 */
export async function listRemoteBranches(repoPath, options = {}) {
  let fetchResult = null;
  if (options.fetch) {
    fetchResult = await runGit(repoPath, ['fetch', '--all', '--prune'], { timeout: 45_000 });
  }

  const [remotesRes, localRefsRes, remoteRefsRes, worktrees] = await Promise.all([
    runGit(repoPath, ['remote'], { timeout: 5_000 }),
    runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { timeout: 5_000 }),
    runGit(
      repoPath,
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)\t%(objectname:short)\t%(contents:subject)\t%(authorname)\t%(committerdate:iso8601)',
        'refs/remotes',
      ],
      { timeout: 10_000 }
    ),
    listGitWorktrees(repoPath),
  ]);

  const remotes = remotesRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const localBranches = localRefsRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const rawRemoteEntries = [];
  for (const line of remoteRefsRes.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [fullRef, shortSha = '', subject = '', author = '', committedAt = ''] = line.split('\t');
    if (!fullRef || !fullRef.includes('/')) continue;
    const slashIdx = fullRef.indexOf('/');
    const remote = fullRef.slice(0, slashIdx);
    const name = fullRef.slice(slashIdx + 1);
    if (!name || name === 'HEAD') continue;
    rawRemoteEntries.push({
      fullRef,
      remote,
      name,
      shortSha,
      subject,
      author,
      committedAt,
    });
  }

  const defaultBranch = await detectDefaultBranch(repoPath, localBranches, rawRemoteEntries);
  const mainWorktree = worktrees.find((w) => w.isMain) || worktrees[0] || null;
  const targetBranch = options.targetBranch || mainWorktree?.branch || defaultBranch;

  // Determine the git ref to compare against for targetBranch
  let compareRef = targetBranch;
  const checkTargetLocal = await runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${targetBranch}`], {
    timeout: 4_000,
  });
  if (!checkTargetLocal.ok) {
    const remoteTarget = rawRemoteEntries.find((r) => r.name === targetBranch);
    if (remoteTarget) compareRef = remoteTarget.fullRef;
  }

  const items = await Promise.all(
    rawRemoteEntries.map(async (entry) => {
      const isDefault = entry.name === defaultBranch;
      const isTarget = entry.name === targetBranch;
      const linkedWorktree = worktrees.find((w) => w.branch === entry.name) || null;
      const hasLocalBranch = localBranches.includes(entry.name);

      let ahead = 0;
      let behind = 0;
      let diff = { filesChanged: 0, added: 0, deleted: 0 };

      if (compareRef && entry.fullRef !== compareRef) {
        const countRes = await runGit(
          repoPath,
          ['rev-list', '--left-right', '--count', `${compareRef}...${entry.fullRef}`],
          { timeout: 6_000 }
        );
        if (countRes.ok) {
          const parts = countRes.stdout.trim().split(/\s+/);
          if (parts.length >= 2) {
            behind = Number(parts[0]) || 0;
            ahead = Number(parts[1]) || 0;
          }
        }

        if (ahead > 0) {
          const statRes = await runGit(
            repoPath,
            ['diff', '--shortstat', `${compareRef}...${entry.fullRef}`],
            { timeout: 6_000 }
          );
          if (statRes.ok) {
            diff = parseShortStat(statRes.stdout);
          }
        }
      }

      return {
        fullRef: entry.fullRef,
        remote: entry.remote,
        branch: entry.name,
        isDefault,
        isTarget,
        hasLocalBranch,
        worktreePath: linkedWorktree?.path || null,
        ahead,
        behind,
        merged: !isDefault && !isTarget && ahead === 0,
        diff,
        head: {
          short_sha: entry.shortSha,
          subject: entry.subject,
          author: entry.author,
          committed_at: entry.committedAt,
        },
      };
    })
  );

  return {
    ok: true,
    fetched: Boolean(options.fetch),
    fetchOk: fetchResult ? fetchResult.ok : true,
    fetchCommand: fetchResult?.command || null,
    fetchStdout: fetchResult?.stdout || '',
    fetchStderr: fetchResult?.stderr || '',
    remotes,
    defaultBranch,
    targetBranch,
    localBranches,
    items,
  };
}

/**
 * Merge a remote branch (e.g. `origin/feat-x`) into a local target branch and optionally push to remote.
 * @param {string} repoPath
 * @param {{
 *   remoteBranch: string,
 *   targetBranch?: string,
 *   squash?: boolean,
 *   noFf?: boolean,
 *   autoPush?: boolean,
 *   deleteRemote?: boolean,
 * }} options
 */
export async function mergeRemoteBranch(repoPath, options) {
  const remoteBranch = String(options.remoteBranch || '').trim();
  if (!remoteBranch) {
    throw new Error('请指定要合并的远程分支');
  }

  const slashIdx = remoteBranch.indexOf('/');
  const remoteName = slashIdx > 0 ? remoteBranch.slice(0, slashIdx) : 'origin';
  const shortBranch = slashIdx > 0 ? remoteBranch.slice(slashIdx + 1) : remoteBranch;
  const fullRemoteRef = slashIdx > 0 ? remoteBranch : `${remoteName}/${remoteBranch}`;

  const worktrees = await listGitWorktrees(repoPath);
  const localRefsRes = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const localBranches = localRefsRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const defaultBranch = await detectDefaultBranch(repoPath, localBranches, []);
  const mainWorktree = worktrees.find((w) => w.isMain) || worktrees[0] || { path: repoPath, branch: defaultBranch };
  const targetBranch = String(options.targetBranch || mainWorktree.branch || defaultBranch).trim();

  if (shortBranch === targetBranch && fullRemoteRef === `${remoteName}/${targetBranch}`) {
    // Allow fast-forward / pull of targetBranch from its own remote ref if requested,
    // or normally merge another remote branch into targetBranch.
  }

  const steps = [];
  const recordStep = (res) => {
    steps.push(res);
    return res;
  };

  // Find which worktree has targetBranch checked out; if none, use repoPath and checkout targetBranch.
  const targetWt = worktrees.find((w) => w.branch === targetBranch);
  const workDir = targetWt ? targetWt.path : repoPath;

  if (!targetWt) {
    const hasLocalTarget = localBranches.includes(targetBranch);
    const checkoutArgs = hasLocalTarget
      ? ['checkout', targetBranch]
      : ['checkout', '-b', targetBranch, `${remoteName}/${targetBranch}`];
    const coRes = recordStep(await runGit(workDir, checkoutArgs, { timeout: 20_000 }));
    if (!coRes.ok) {
      return buildMergeResponse(false, steps);
    }
  }

  const shouldPush = options.autoPush !== false;

  // Merge the remote ref into targetBranch
  if (options.squash) {
    const sqRes = recordStep(await runGit(workDir, ['merge', '--squash', fullRemoteRef], { timeout: 60_000 }));
    if (!sqRes.ok) {
      const conflictStatus = await getConflictStatus(workDir);
      if (conflictStatus.unresolvedCount > 0) {
        return buildMergeResponse(false, steps, {
          hasConflicts: true,
          conflictSession: {
            workDir,
            sourceBranch: fullRemoteRef,
            targetBranch,
            isRemote: true,
            autoPush: shouldPush,
            deleteRemote: Boolean(options.deleteRemote),
            files: conflictStatus.files,
            unmergedFiles: conflictStatus.unmergedFiles,
          },
        });
      }
      await runGit(workDir, ['reset', '--merge'], { timeout: 10_000 });
      return buildMergeResponse(false, steps);
    }
    const statusRes = await runGit(workDir, ['status', '--porcelain'], { timeout: 10_000 });
    if (statusRes.stdout.trim()) {
      const commitMsg = `Merge remote-tracking branch '${fullRemoteRef}' into ${targetBranch}`;
      const commitRes = recordStep(await runGit(workDir, ['commit', '-m', commitMsg], { timeout: 30_000 }));
      if (!commitRes.ok) {
        return buildMergeResponse(false, steps);
      }
    }
  } else {
    const mergeArgs = ['merge'];
    if (options.noFf) mergeArgs.push('--no-ff');
    mergeArgs.push('--no-edit', fullRemoteRef);
    const mergeRes = recordStep(await runGit(workDir, mergeArgs, { timeout: 60_000 }));
    if (!mergeRes.ok) {
      const conflictStatus = await getConflictStatus(workDir);
      if (conflictStatus.unresolvedCount > 0) {
        return buildMergeResponse(false, steps, {
          hasConflicts: true,
          conflictSession: {
            workDir,
            sourceBranch: fullRemoteRef,
            targetBranch,
            isRemote: true,
            autoPush: shouldPush,
            deleteRemote: Boolean(options.deleteRemote),
            files: conflictStatus.files,
            unmergedFiles: conflictStatus.unmergedFiles,
          },
        });
      }
      // Abort non-conflict failed merge so the target worktree stays clean
      await runGit(workDir, ['merge', '--abort'], { timeout: 10_000 });
      return buildMergeResponse(false, steps);
    }
  }

  // Push target branch to remote if autoPush is enabled (default true)
  if (shouldPush) {
    const pushRes = recordStep(await runGit(workDir, ['push', remoteName, targetBranch], { timeout: 60_000 }));
    if (!pushRes.ok) {
      return buildMergeResponse(false, steps);
    }
  }

  // Optionally delete the merged remote branch
  if (options.deleteRemote && shortBranch !== targetBranch && shortBranch !== defaultBranch) {
    const delRes = recordStep(
      await runGit(workDir, ['push', remoteName, '--delete', shortBranch], { timeout: 45_000 })
    );
    if (!delRes.ok) {
      return buildMergeResponse(false, steps);
    }
  }

  return buildMergeResponse(true, steps);
}

/**
 * Delete a remote branch via `git push <remote> --delete <branch>`.
 * @param {string} repoPath
 * @param {string} remoteBranch
 */
export async function deleteRemoteBranch(repoPath, remoteBranch) {
  const ref = String(remoteBranch || '').trim();
  const slashIdx = ref.indexOf('/');
  if (slashIdx <= 0) {
    throw new Error(`无效的远程分支引用: ${ref}`);
  }
  const remoteName = ref.slice(0, slashIdx);
  const shortBranch = ref.slice(slashIdx + 1);
  if (!shortBranch || shortBranch === 'HEAD') {
    throw new Error(`不可删除该远程引用: ${ref}`);
  }
  return runGit(repoPath, ['push', remoteName, '--delete', shortBranch], { timeout: 45_000 });
}

/**
 * Detect whether a worktree currently has an active in-progress rebase or merge operation.
 * Checks `rebase-merge` / `rebase-apply` directories rather than `REBASE_HEAD` alone,
 * because Git/tools can leave a stale `REBASE_HEAD` behind after a rebase finishes.
 * @param {string} workDir
 * @returns {Promise<'rebase' | 'merge' | null>}
 */
export async function getWorktreeInProgressOp(workDir) {
  if (!workDir) return null;
  const res = await runGit(
    workDir,
    ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'MERGE_HEAD'],
    { timeout: 5_000 }
  );
  if (!res.ok) return null;
  const [rebaseMergeRel, rebaseApplyRel, mergeHeadRel] = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim());
  if ((rebaseMergeRel && existsSync(resolve(workDir, rebaseMergeRel))) || (rebaseApplyRel && existsSync(resolve(workDir, rebaseApplyRel)))) {
    return 'rebase';
  }
  if (mergeHeadRel && existsSync(resolve(workDir, mergeHeadRel))) {
    return 'merge';
  }
  return null;
}

/**
 * When a local `wt merge` fails, inspect worktrees for active conflicts or materialize the merge
 * in the target worktree if `wt merge` refused/aborted due to merge conflicts.
 * @param {string} repoPath
 * @param {{ sourceBranch: string, targetBranch?: string, noFf?: boolean, noSquash?: boolean, wtOutput?: string }} options
 */
export async function detectOrStartLocalConflictSession(repoPath, options) {
  const worktrees = await listGitWorktrees(repoPath);
  const localRefsRes = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const localBranches = localRefsRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultBranch = await detectDefaultBranch(repoPath, localBranches, []);
  const mainWt = worktrees.find((w) => w.isMain) || worktrees[0] || { path: repoPath, branch: defaultBranch };
  const targetBranch = String(options.targetBranch || mainWt.branch || defaultBranch).trim();
  const sourceBranch = String(options.sourceBranch || '').trim();

  // 1. Check if any worktree already has unresolved files left by wt merge
  for (const wt of worktrees) {
    const status = await getConflictStatus(wt.path);
    if (status.unresolvedCount > 0) {
      return {
        hasConflicts: true,
        conflictSession: {
          workDir: wt.path,
          sourceBranch,
          targetBranch: wt.branch || targetBranch,
          isRemote: false,
          autoPush: false,
          deleteRemote: false,
          files: status.files,
          unmergedFiles: status.unmergedFiles,
        },
      };
    }
  }

  // 1b. If a git rebase/merge is already in progress (e.g. staged conflicts awaiting --continue / --abort),
  // open the conflict modal for that worktree so the user can finish or abort it directly in the UI.
  const sortedWts = [...worktrees].sort((a, b) => {
    const aScore = a.branch === sourceBranch ? 2 : a.branch === targetBranch ? 1 : 0;
    const bScore = b.branch === sourceBranch ? 2 : b.branch === targetBranch ? 1 : 0;
    return bScore - aScore;
  });
  for (const wt of sortedWts) {
    const inProgressOp = await getWorktreeInProgressOp(wt.path);
    if (inProgressOp) {
      const status = await getConflictStatus(wt.path);
      return {
        hasConflicts: true,
        conflictSession: {
          workDir: wt.path,
          sourceBranch,
          targetBranch: wt.branch || targetBranch,
          isRemote: false,
          autoPush: false,
          deleteRemote: false,
          files: status.files,
          unmergedFiles: status.unmergedFiles,
        },
      };
    }
  }

  // 2. If wt merge aborted/refused because of conflicts, start `git merge` in target worktree so user can resolve visually
  const looksLikeConflict = /conflict|冲突|unmerged|automatic merge failed/i.test(options.wtOutput || '');
  if (!looksLikeConflict || !sourceBranch) {
    return { hasConflicts: false, conflictSession: null };
  }

  const targetWt = worktrees.find((w) => w.branch === targetBranch) || mainWt;
  const mergeArgs = ['merge'];
  if (options.noFf) mergeArgs.push('--no-ff');
  else if (!options.noSquash) mergeArgs.push('--squash');
  mergeArgs.push('--no-edit', sourceBranch);

  await runGit(targetWt.path, mergeArgs, { timeout: 30_000 });
  const afterStatus = await getConflictStatus(targetWt.path);
  if (afterStatus.unresolvedCount > 0) {
    return {
      hasConflicts: true,
      conflictSession: {
        workDir: targetWt.path,
        sourceBranch,
        targetBranch,
        isRemote: false,
        autoPush: false,
        deleteRemote: false,
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

/**
 * Pull remote updates into a local worktree using `git pull --autostash`,
 * and detect any resulting merge or autostash conflicts.
 * @param {string} repoPath
 * @param {{ workDir?: string, branch?: string }} [options]
 */
export async function pullWorktreeBranch(repoPath, options = {}) {
  const worktrees = await listGitWorktrees(repoPath);
  const targetWt =
    (options.workDir && worktrees.find((w) => samePath(w.path, resolve(options.workDir)))) ||
    (options.branch && worktrees.find((w) => w.branch === options.branch)) ||
    worktrees.find((w) => w.isMain) ||
    { path: repoPath, branch: options.branch || '' };

  const workDir = targetWt.path;
  let currentBranch = String(options.branch || targetWt.branch || '').trim();
  if (!currentBranch) {
    const revRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    currentBranch = revRes.stdout.trim();
  }

  // Guard against pulling while a rebase or merge is already in progress (which detaches HEAD).
  const inProgressOp = await getWorktreeInProgressOp(workDir);
  if (inProgressOp) {
    const opName = inProgressOp === 'rebase' ? '变基 (rebase)' : '合并 (merge)';
    const hintCmd = inProgressOp === 'rebase' ? 'git rebase --continue / --abort' : 'git commit / git merge --abort';
    return {
      ok: false,
      hasConflicts: false,
      command: formatCommand('git', ['-C', workDir, 'status']),
      stdout: '',
      stderr: `当前工作树存在未完成的${opName}，无法直接拉取。请点击「解决冲突」中的「完成合并并提交」或「放弃合并」完成收尾（或终端执行 ${hintCmd}），切勿点击「移除」。`,
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
        isRemote: false,
        autoPush: false,
        deleteRemote: false,
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
 * Push a local worktree branch to its remote (`git push` or `git push -u <remote> <branch>`).
 * @param {string} repoPath
 * @param {{ workDir?: string, branch?: string }} [options]
 */
export async function pushWorktreeBranch(repoPath, options = {}) {
  const worktrees = await listGitWorktrees(repoPath);
  const targetWt =
    (options.workDir && worktrees.find((w) => samePath(w.path, resolve(options.workDir)))) ||
    (options.branch && worktrees.find((w) => w.branch === options.branch)) ||
    worktrees.find((w) => w.isMain) ||
    { path: repoPath, branch: options.branch || '' };

  const workDir = targetWt.path;
  let currentBranch = String(options.branch || targetWt.branch || '').trim();
  if (!currentBranch) {
    const revRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    currentBranch = revRes.stdout.trim();
  }

  const upstreamRes = await runGit(
    workDir,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { timeout: 5_000 }
  );

  let pushArgs;
  if (upstreamRes.ok && upstreamRes.stdout.trim()) {
    pushArgs = ['push'];
  } else {
    const remoteRes = await runGit(workDir, ['remote'], { timeout: 5_000 });
    const firstRemote =
      remoteRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean) || 'origin';
    pushArgs = currentBranch ? ['push', '-u', firstRemote, currentBranch] : ['push'];
  }

  return runGit(workDir, pushArgs, { timeout: 60_000 });
}

function buildMergeResponse(ok, steps, extra = {}) {
  const commands = steps.map((s) => s.command).join(' && ');
  const stdout = steps
    .map((s) => (s.stdout || '').trim())
    .filter(Boolean)
    .join('\n');
  const stderr = steps
    .map((s) => (s.stderr || '').trim())
    .filter(Boolean)
    .join('\n');
  return {
    ok,
    command: commands,
    stdout,
    stderr,
    steps,
    ...extra,
  };
}

