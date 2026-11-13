import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGit } from './remote.js';

/**
 * Ensure a relative file path stays strictly inside `workDir`.
 * @param {string} workDir
 * @param {string} relPath
 */
export function resolveSafeRepoFile(workDir, relPath) {
  const root = resolve(workDir);
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  if (!cleaned) {
    throw new Error('文件路径不能为空');
  }
  const full = resolve(root, cleaned);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (!full.startsWith(root + sep) && full !== root)) {
    throw new Error(`非法的文件路径: ${relPath}`);
  }
  return { root, full, rel: rel.replace(/\\/g, '/') };
}

/**
 * Parse a file's text into normal segments and conflict hunks.
 * Supports standard 2-way (`<<<<<<<`, `=======`, `>>>>>>>`) and diff3 (`|||||||`) conflict markers.
 * @param {string} content
 */
export function parseConflictHunks(content) {
  const text = String(content ?? '');
  const lines = text.split(/\r?\n/);
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';

  const segments = [];
  const hunks = [];
  let normalBuffer = [];
  let normalStartLine = 1;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('<<<<<<<')) {
      const startIdx = i;
      const oursLabel = line.slice(7).trim();
      const oursLines = [];
      const baseLines = [];
      const theirsLines = [];
      let baseLabel = '';
      let theirsLabel = '';
      let state = 'ours'; // 'ours' | 'base' | 'theirs'
      let foundSep = false;
      let foundEnd = false;

      let j = i + 1;
      while (j < lines.length) {
        const cur = lines[j];
        if (state === 'ours' && cur.startsWith('|||||||')) {
          state = 'base';
          baseLabel = cur.slice(7).trim();
        } else if ((state === 'ours' || state === 'base') && cur.startsWith('=======')) {
          state = 'theirs';
          foundSep = true;
        } else if (state === 'theirs' && cur.startsWith('>>>>>>>')) {
          theirsLabel = cur.slice(7).trim();
          foundEnd = true;
          break;
        } else if (state === 'ours') {
          oursLines.push(cur);
        } else if (state === 'base') {
          baseLines.push(cur);
        } else {
          theirsLines.push(cur);
        }
        j += 1;
      }

      if (foundSep && foundEnd) {
        if (normalBuffer.length > 0) {
          segments.push({
            type: 'normal',
            startLine: normalStartLine,
            endLine: startIdx,
            lines: normalBuffer,
            text: normalBuffer.join(lineEnding),
          });
          normalBuffer = [];
        }

        const hunkId = hunks.length;
        const hunk = {
          id: hunkId,
          startLine: startIdx + 1,
          endLine: j + 1,
          oursLabel: oursLabel || 'HEAD',
          baseLabel,
          theirsLabel: theirsLabel || 'Incoming',
          oursLines,
          baseLines,
          theirsLines,
          oursText: oursLines.join(lineEnding),
          baseText: baseLines.join(lineEnding),
          theirsText: theirsLines.join(lineEnding),
          rawText: lines.slice(startIdx, j + 1).join(lineEnding),
        };
        hunks.push(hunk);
        segments.push({
          type: 'conflict',
          hunk,
        });

        i = j + 1;
        normalStartLine = i + 1;
        continue;
      }
    }

    if (normalBuffer.length === 0) {
      normalStartLine = i + 1;
    }
    normalBuffer.push(line);
    i += 1;
  }

  if (normalBuffer.length > 0) {
    segments.push({
      type: 'normal',
      startLine: normalStartLine,
      endLine: lines.length,
      lines: normalBuffer,
      text: normalBuffer.join(lineEnding),
    });
  }

  return {
    lineEnding,
    hunkCount: hunks.length,
    hunks,
    segments,
  };
}

/**
 * Apply a resolution choice to a specific conflict hunk index and return the updated file content.
 * @param {string} content
 * @param {number} hunkIndex
 * @param {'ours' | 'theirs' | 'both' | 'both_reverse'} choice
 */
export function applyHunkResolution(content, hunkIndex, choice) {
  const parsed = parseConflictHunks(content);
  const le = parsed.lineEnding;
  let targetFound = false;

  const outLines = [];
  for (const seg of parsed.segments) {
    if (seg.type === 'normal') {
      outLines.push(...seg.lines);
    } else if (seg.type === 'conflict') {
      const h = seg.hunk;
      if (h.id === hunkIndex) {
        targetFound = true;
        if (choice === 'ours') {
          outLines.push(...h.oursLines);
        } else if (choice === 'theirs') {
          outLines.push(...h.theirsLines);
        } else if (choice === 'both') {
          outLines.push(...h.oursLines, ...h.theirsLines);
        } else if (choice === 'both_reverse') {
          outLines.push(...h.theirsLines, ...h.oursLines);
        } else {
          throw new Error(`未知的冲突解决方式: ${choice}`);
        }
      } else {
        outLines.push(...h.rawText.split(/\r?\n/));
      }
    }
  }

  if (!targetFound) {
    throw new Error(`未找到第 ${hunkIndex + 1} 处冲突块`);
  }

  return outLines.join(le);
}

/**
 * Inspect unmerged/conflicted files in a worktree directory.
 * @param {string} workDir
 * @param {string[]} [trackedFiles] Optional list of files from the initial conflict to keep showing even after resolved
 */
export async function getConflictStatus(workDir, trackedFiles = []) {
  const unmergedRes = await runGit(workDir, ['diff', '--name-only', '--diff-filter=U'], { timeout: 10_000 });
  const unmergedFiles = unmergedRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const allFileNames = Array.from(new Set([...trackedFiles, ...unmergedFiles]));
  const files = allFileNames.map((relPath) => {
    const isUnmerged = unmergedFiles.includes(relPath);
    let hunkCount = 0;
    try {
      const { full } = resolveSafeRepoFile(workDir, relPath);
      if (existsSync(full)) {
        const raw = readFileSync(full, 'utf8');
        hunkCount = parseConflictHunks(raw).hunkCount;
      }
    } catch {
      // Ignore read errors for binary or deleted files
    }
    return {
      path: relPath,
      resolved: !isUnmerged && hunkCount === 0,
      unmerged: isUnmerged,
      hunkCount,
    };
  });

  return {
    workDir: resolve(workDir),
    unresolvedCount: unmergedFiles.length,
    unmergedFiles,
    files,
  };
}

/**
 * Read a conflicted file and parse its conflict hunks.
 * @param {string} workDir
 * @param {string} filePath
 */
export async function readConflictFileDetails(workDir, filePath) {
  const { full, rel } = resolveSafeRepoFile(workDir, filePath);
  const content = existsSync(full) ? readFileSync(full, 'utf8') : '';
  const parsed = parseConflictHunks(content);
  const unmergedRes = await runGit(workDir, ['diff', '--name-only', '--diff-filter=U', '--', rel], {
    timeout: 5_000,
  });
  const isUnmerged = Boolean(unmergedRes.stdout.trim());

  return {
    path: rel,
    content,
    isUnmerged,
    resolved: !isUnmerged && parsed.hunkCount === 0,
    hunkCount: parsed.hunkCount,
    hunks: parsed.hunks,
    segments: parsed.segments,
  };
}

/**
 * Save resolved content (or apply a hunk/whole-file resolution) and stage the file when no conflict markers remain.
 * @param {string} workDir
 * @param {{
 *   filePath: string,
 *   content?: string,
 *   strategy?: 'ours' | 'theirs' | 'manual',
 *   hunkIndex?: number,
 *   hunkChoice?: 'ours' | 'theirs' | 'both' | 'both_reverse',
 *   stage?: boolean,
 *   trackedFiles?: string[],
 * }} options
 */
export async function resolveConflictFile(workDir, options) {
  const { full, rel } = resolveSafeRepoFile(workDir, options.filePath);

  if (options.strategy === 'ours' || options.strategy === 'theirs') {
    const flag = options.strategy === 'ours' ? '--ours' : '--theirs';
    const coRes = await runGit(workDir, ['checkout', flag, '--', rel], { timeout: 10_000 });
    if (!coRes.ok) {
      // Fallback: if stage #2/#3 does not exist (e.g. already staged once), resolve via hunks in file
      if (existsSync(full)) {
        let text = readFileSync(full, 'utf8');
        while (parseConflictHunks(text).hunkCount > 0) {
          text = applyHunkResolution(text, 0, options.strategy);
        }
        writeFileSync(full, text, 'utf8');
      } else {
        throw new Error(coRes.stderr || `无法检出 ${flag}: ${rel}`);
      }
    }
    const addRes = await runGit(workDir, ['add', '--', rel], { timeout: 10_000 });
    if (!addRes.ok) {
      throw new Error(addRes.stderr || `git add 失败: ${rel}`);
    }
  } else if (typeof options.hunkIndex === 'number' && options.hunkChoice) {
    const current = existsSync(full) ? readFileSync(full, 'utf8') : '';
    const updated = applyHunkResolution(current, options.hunkIndex, options.hunkChoice);
    writeFileSync(full, updated, 'utf8');
    const remaining = parseConflictHunks(updated).hunkCount;
    if (remaining === 0 && options.stage !== false) {
      await runGit(workDir, ['add', '--', rel], { timeout: 10_000 });
    }
  } else if (typeof options.content === 'string') {
    writeFileSync(full, options.content, 'utf8');
    const remaining = parseConflictHunks(options.content).hunkCount;
    if (options.stage !== false && remaining === 0) {
      const addRes = await runGit(workDir, ['add', '--', rel], { timeout: 10_000 });
      if (!addRes.ok) {
        throw new Error(addRes.stderr || `git add 失败: ${rel}`);
      }
    }
  } else {
    throw new Error('请提供解决策略或文件内容');
  }

  const fileDetails = await readConflictFileDetails(workDir, rel);
  const status = await getConflictStatus(workDir, options.trackedFiles || [rel]);
  return {
    ok: true,
    file: fileDetails,
    status,
  };
}

/**
 * Abort an in-progress merge, rebase, or squash merge in `workDir`.
 * @param {string} workDir
 */
export async function abortConflictMerge(workDir) {
  const mergeAbort = await runGit(workDir, ['merge', '--abort'], { timeout: 15_000 });
  if (mergeAbort.ok) return mergeAbort;

  const rebaseAbort = await runGit(workDir, ['rebase', '--abort'], { timeout: 15_000 });
  if (rebaseAbort.ok) return rebaseAbort;

  const resetMerge = await runGit(workDir, ['reset', '--merge'], { timeout: 15_000 });
  return resetMerge;
}

/**
 * Complete an in-progress merge after all conflicts have been resolved and staged.
 * @param {string} workDir
 * @param {{
 *   sourceBranch?: string,
 *   targetBranch?: string,
 *   isRemote?: boolean,
 *   autoPush?: boolean,
 *   deleteRemote?: boolean,
 * }} [options]
 */
export async function completeConflictMerge(workDir, options = {}) {
  const status = await getConflictStatus(workDir);
  if (status.unresolvedCount > 0) {
    throw new Error(`仍有 ${status.unresolvedCount} 个冲突文件未解决: ${status.unmergedFiles.join(', ')}`);
  }

  const steps = [];
  const recordStep = (res) => {
    steps.push(res);
    return res;
  };

  // Check if rebase, merge, or staged changes need to be finalized
  const rebaseHeadRes = await runGit(workDir, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'], { timeout: 5_000 });
  const mergeHeadRes = await runGit(workDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { timeout: 5_000 });
  const statusPorcelain = await runGit(workDir, ['status', '--porcelain'], { timeout: 5_000 });

  if (rebaseHeadRes.ok) {
    const rebaseCont = recordStep(
      await runGit(workDir, ['-c', 'core.editor=true', 'rebase', '--continue'], { timeout: 30_000 })
    );
    if (!rebaseCont.ok) {
      return buildStepsResult(false, steps);
    }
  } else if (mergeHeadRes.ok || statusPorcelain.stdout.trim()) {
    const commitMsg = options.sourceBranch
      ? `Merge branch '${options.sourceBranch}' into ${options.targetBranch || 'HEAD'}`
      : 'Merge branch (resolved conflicts in wt-ui)';

    let commitRes = await runGit(workDir, ['commit', '--no-edit'], { timeout: 30_000 });
    if (!commitRes.ok) {
      commitRes = await runGit(workDir, ['commit', '-m', commitMsg], { timeout: 30_000 });
    }
    recordStep(commitRes);
    if (!commitRes.ok) {
      return buildStepsResult(false, steps);
    }
  }

  const sourceRef = String(options.sourceBranch || '').trim();
  const slashIdx = sourceRef.indexOf('/');
  const remoteName = slashIdx > 0 ? sourceRef.slice(0, slashIdx) : 'origin';
  const shortBranch = slashIdx > 0 ? sourceRef.slice(slashIdx + 1) : sourceRef;
  let targetBranch = String(options.targetBranch || '').trim();
  if (!targetBranch) {
    const revRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    targetBranch = revRes.stdout.trim();
  }

  const shouldPush = options.isRemote ? options.autoPush !== false : Boolean(options.autoPush);
  if (shouldPush && targetBranch) {
    const pushRes = recordStep(
      await runGit(workDir, ['push', remoteName, targetBranch], { timeout: 60_000 })
    );
    if (!pushRes.ok) {
      return buildStepsResult(false, steps);
    }
  }

  if (options.isRemote && options.deleteRemote && shortBranch && shortBranch !== targetBranch) {
    const delRes = recordStep(
      await runGit(workDir, ['push', remoteName, '--delete', shortBranch], { timeout: 45_000 })
    );
    if (!delRes.ok) {
      return buildStepsResult(false, steps);
    }
  }

  return buildStepsResult(true, steps);
}

function buildStepsResult(ok, steps) {
  return {
    ok,
    command: steps.map((s) => s.command).join(' && ') || 'git commit',
    stdout: steps
      .map((s) => (s.stdout || '').trim())
      .filter(Boolean)
      .join('\n'),
    stderr: steps
      .map((s) => (s.stderr || '').trim())
      .filter(Boolean)
      .join('\n'),
    steps,
  };
}

