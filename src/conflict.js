import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { getWorktreeInProgressOp, pushWorktreeBranch, runGit } from './remote.js';
import { buildWtMergeArgs, runWt } from './wt-resolver.js';

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
  const normRel = rel.replace(/\\/g, '/');
  if (!normRel || normRel === '..' || normRel.startsWith('../') || isAbsolute(rel)) {
    throw new Error(`非法的文件路径: ${relPath}`);
  }
  return { root, full, rel: normRel };
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

function pickHunkLines(hunk, choice) {
  if (choice === 'ours') return hunk.oursLines;
  if (choice === 'theirs') return hunk.theirsLines;
  if (choice === 'both') return [...hunk.oursLines, ...hunk.theirsLines];
  if (choice === 'both_reverse') return [...hunk.theirsLines, ...hunk.oursLines];
  throw new Error(`未知的冲突解决方式: ${choice}`);
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
        outLines.push(...pickHunkLines(h, choice));
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
 * Resolve all conflict hunks in a single pass with the given choice.
 * @param {string} content
 * @param {'ours' | 'theirs' | 'both' | 'both_reverse'} choice
 */
export function resolveAllConflictHunks(content, choice) {
  const parsed = parseConflictHunks(content);
  if (parsed.hunkCount === 0) return String(content ?? '');
  const outLines = [];
  for (const seg of parsed.segments) {
    if (seg.type === 'normal') {
      outLines.push(...seg.lines);
    } else if (seg.type === 'conflict') {
      outLines.push(...pickHunkLines(seg.hunk, choice));
    }
  }
  return outLines.join(parsed.lineEnding);
}

/**
 * Inspect unmerged/conflicted files in a worktree directory.
 * @param {string} workDir
 * @param {string[]} [trackedFiles] Optional list of files from the initial conflict to keep showing even after resolved
 */
export async function getConflictStatus(workDir, trackedFiles = []) {
  const [unmergedRes, operation] = await Promise.all([
    runGit(workDir, ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U'], {
      timeout: 10_000,
    }),
    getWorktreeInProgressOp(workDir),
  ]);
  const unmergedFiles = unmergedRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unmergedSet = new Set(unmergedFiles);

  const allFileNames = Array.from(new Set([...trackedFiles, ...unmergedFiles]));
  const files = await Promise.all(
    allFileNames.map(async (relPath) => {
      const isUnmerged = unmergedSet.has(relPath);
      let hunkCount = 0;
      try {
        const { full } = resolveSafeRepoFile(workDir, relPath);
        const raw = await readFile(full, 'utf8');
        if (raw.includes('<<<<<<<')) {
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
    })
  );

  return {
    workDir: resolve(workDir),
    operation,
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
  const unmergedRes = await runGit(
    workDir,
    ['-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U', '--', rel],
    {
      timeout: 5_000,
    }
  );
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
    let removed = false;
    if (!coRes.ok) {
      // Handle modify/delete conflict when the chosen side deleted the file
      if (/does not have (?:our|their) version/i.test(coRes.stderr || '')) {
        const rmRes = await runGit(workDir, ['rm', '-f', '--', rel], { timeout: 10_000 });
        if (!rmRes.ok) {
          throw new Error(rmRes.stderr || coRes.stderr || `无法删除文件: ${rel}`);
        }
        removed = true;
      } else if (existsSync(full)) {
        // Fallback: if stage #2/#3 does not exist (e.g. already staged once), resolve via hunks in file
        const text = resolveAllConflictHunks(readFileSync(full, 'utf8'), options.strategy);
        writeFileSync(full, text, 'utf8');
      } else {
        throw new Error(coRes.stderr || `无法检出 ${flag}: ${rel}`);
      }
    }
    if (!removed) {
      const addRes = await runGit(workDir, ['add', '--', rel], { timeout: 10_000 });
      if (!addRes.ok) {
        throw new Error(addRes.stderr || `git add 失败: ${rel}`);
      }
    }
  } else if (typeof options.hunkIndex === 'number' && options.hunkChoice) {
    const current = existsSync(full) ? readFileSync(full, 'utf8') : '';
    const updated = applyHunkResolution(current, options.hunkIndex, options.hunkChoice);
    writeFileSync(full, updated, 'utf8');
    const remaining = parseConflictHunks(updated).hunkCount;
    if (remaining === 0 && options.stage !== false) {
      const addRes = await runGit(workDir, ['add', '--', rel], { timeout: 10_000 });
      if (!addRes.ok) {
        throw new Error(addRes.stderr || `git add 失败: ${rel}`);
      }
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

const ABORT_ARGS_BY_OP = {
  rebase: ['rebase', '--abort'],
  merge: ['merge', '--abort'],
  cherry_pick: ['cherry-pick', '--abort'],
  revert: ['revert', '--abort'],
  bisect: ['bisect', 'reset'],
};

const CONTINUE_ARGS_BY_OP = {
  rebase: ['-c', 'core.editor=true', 'rebase', '--continue'],
  cherry_pick: ['-c', 'core.editor=true', 'cherry-pick', '--continue'],
  revert: ['-c', 'core.editor=true', 'revert', '--continue'],
};

/**
 * Abort an in-progress rebase, merge, cherry-pick, revert, or bisect in `workDir`.
 * @param {string} workDir
 */
export async function abortConflictMerge(workDir) {
  const op = await getWorktreeInProgressOp(workDir);
  if (op && ABORT_ARGS_BY_OP[op]) {
    const opAbort = await runGit(workDir, ABORT_ARGS_BY_OP[op], { timeout: 15_000 });
    if (opAbort.ok) return { ...opAbort, operation: op };
  }

  const mergeAbort = await runGit(workDir, ['merge', '--abort'], { timeout: 15_000 });
  if (mergeAbort.ok) return { ...mergeAbort, operation: op || 'merge' };

  const rebaseAbort = await runGit(workDir, ['rebase', '--abort'], { timeout: 15_000 });
  if (rebaseAbort.ok) return { ...rebaseAbort, operation: op || 'rebase' };

  const resetMerge = await runGit(workDir, ['reset', '--merge'], { timeout: 15_000 });
  return { ...resetMerge, operation: op || null };
}

/**
 * Complete an in-progress conflict operation after conflicts have been resolved and staged.
 * When originating from `wt merge` (`options.wtMergeOptions`), resumes the `wt merge` pipeline
 * (hooks, fast-forward merge, worktree cleanup) after the source rebase finishes.
 * @param {string} workDir
 * @param {{
 *   sourceBranch?: string,
 *   targetBranch?: string,
 *   autoPush?: boolean,
 *   wtBin?: string,
 *   repoPath?: string,
 *   wtMergeOptions?: Record<string, any> | null,
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

  // Check if rebase, cherry-pick, revert, merge, or staged changes need to be finalized
  const [inProgressOp, statusPorcelain] = await Promise.all([
    getWorktreeInProgressOp(workDir),
    runGit(workDir, ['-c', 'core.quotepath=false', 'status', '--porcelain'], { timeout: 5_000 }),
  ]);

  const hasStagedChanges = statusPorcelain.stdout
    .split(/\r?\n/)
    .some((line) => line.length >= 2 && line[0] !== ' ' && line[0] !== '?');

  if (inProgressOp && CONTINUE_ARGS_BY_OP[inProgressOp]) {
    const contRes = recordStep(
      await runGit(workDir, CONTINUE_ARGS_BY_OP[inProgressOp], {
        timeout: 30_000,
        env: { GIT_EDITOR: 'true' },
      })
    );
    if (!contRes.ok) {
      const nextStatus = await getConflictStatus(workDir);
      return buildStepsResult(false, steps, {
        hasMoreConflicts: nextStatus.unresolvedCount > 0,
        status: nextStatus,
      });
    }
  } else if (inProgressOp === 'merge' || hasStagedChanges) {
    const commitMsg = options.sourceBranch
      ? `Merge branch '${options.sourceBranch}' into ${options.targetBranch || 'HEAD'}`
      : 'Merge branch (resolved conflicts in wtui)';

    let commitRes = await runGit(workDir, ['commit', '--no-edit'], { timeout: 30_000 });
    if (!commitRes.ok) {
      commitRes = await runGit(workDir, ['commit', '-m', commitMsg], { timeout: 30_000 });
    }
    recordStep(commitRes);
    if (!commitRes.ok) {
      return buildStepsResult(false, steps);
    }
  }

  // After source rebase finishes, resume `wt merge` unless conflicts were already merged directly on targetBranch
  const wtMergeOpts = options.wtMergeOptions;
  let didWtMerge = false;
  if (options.wtBin && options.repoPath && wtMergeOpts?.branch && !wtMergeOpts.alreadyMergedToTarget) {
    const remainingOp = await getWorktreeInProgressOp(workDir);
    if (remainingOp) {
      const nextStatus = await getConflictStatus(workDir);
      return buildStepsResult(false, steps, {
        hasMoreConflicts: true,
        status: nextStatus,
      });
    }
    const wtRes = recordStep(
      await runWt(options.wtBin, options.repoPath, buildWtMergeArgs(wtMergeOpts, { includeYes: true }), {
        timeout: 120_000,
      })
    );
    if (!wtRes.ok) {
      return buildStepsResult(false, steps);
    }
    didWtMerge = true;
  }

  let targetBranch = String(options.targetBranch || wtMergeOpts?.target || '').trim();
  if (!targetBranch) {
    const revRes = await runGit(didWtMerge && options.repoPath ? options.repoPath : workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    targetBranch = revRes.stdout.trim();
  }

  if (options.autoPush && targetBranch) {
    const pushRepo = didWtMerge && options.repoPath ? options.repoPath : workDir;
    const pushRes = recordStep(
      await pushWorktreeBranch(pushRepo, {
        ...(didWtMerge ? {} : { workDir }),
        branch: targetBranch,
      })
    );
    if (!pushRes.ok) {
      return buildStepsResult(false, steps, {
        pushFailed: {
          workDir: pushRes.workDir || pushRepo,
          branch: pushRes.branch || targetBranch,
          nonFastForward: Boolean(pushRes.nonFastForward),
          command: pushRes.command,
          stdout: pushRes.stdout,
          stderr: pushRes.stderr,
        },
      });
    }
  }

  return buildStepsResult(true, steps, { resumedWtMerge: didWtMerge });
}

function buildStepsResult(ok, steps, extra = {}) {
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
    ...extra,
  };
}

/**
 * Parse and validate an AI base/endpoint URL.
 * @param {string} rawUrl
 * @returns {{ trimmed: string, parsed: URL, pathname: string }}
 */
function parseAiBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    throw new Error('未配置 AI URL');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`无效的 AI URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的 AI URL 协议: ${parsed.protocol}`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const isAnthropicHost = /(?:^|\.)anthropic\.com$/i.test(parsed.hostname);
  return { parsed, pathname, isAnthropicHost };
}

function buildUrlWithPath(parsed, nextPathname) {
  const next = new URL(parsed.toString());
  next.pathname = nextPathname;
  return next.toString();
}

/**
 * Check whether text contains real conflict marker blocks (avoiding false positives on standalone `=======` in Markdown).
 * @param {string} text
 * @returns {boolean}
 */
export function hasConflictMarkers(text) {
  const src = String(text ?? '');
  if (!src.includes('<<<<<<<')) return false;
  if (parseConflictHunks(src).hunkCount > 0) return true;
  const hasStart = /^<{7}(?:\s|$)/m.test(src);
  if (!hasStart) return false;
  return /^={7}\s*$/m.test(src) || /^>{7}(?:\s|$)/m.test(src);
}

/**
 * Normalize a user-configured AI base URL or full endpoint URL.
 * @param {string} rawUrl
 * @returns {{ endpoint: string, isAnthropic: boolean }}
 */
export function buildAiChatEndpoint(rawUrl) {
  const { parsed, pathname, isAnthropicHost } = parseAiBaseUrl(rawUrl);
  if (pathname.endsWith('/messages')) {
    return { endpoint: buildUrlWithPath(parsed, pathname), isAnthropic: true };
  }
  if (pathname.endsWith('/chat/completions')) {
    return { endpoint: buildUrlWithPath(parsed, pathname), isAnthropic: false };
  }
  if (isAnthropicHost) {
    const nextPath = /\/v\d+(?:beta)?$/i.test(pathname) ? `${pathname}/messages` : `${pathname}/v1/messages`;
    return { endpoint: buildUrlWithPath(parsed, nextPath), isAnthropic: true };
  }
  if (/\/v\d+(?:beta)?(?:\/openai)?$/i.test(pathname)) {
    return { endpoint: buildUrlWithPath(parsed, `${pathname}/chat/completions`), isAnthropic: false };
  }
  return { endpoint: buildUrlWithPath(parsed, `${pathname}/v1/chat/completions`), isAnthropic: false };
}

/**
 * Derive the models listing endpoint from a user-configured AI base/endpoint URL.
 * @param {string} rawUrl
 * @returns {{ endpoint: string, isAnthropic: boolean }}
 */
export function buildAiModelsEndpoint(rawUrl) {
  const { parsed, pathname, isAnthropicHost } = parseAiBaseUrl(rawUrl);
  if (pathname.endsWith('/models')) {
    return { endpoint: buildUrlWithPath(parsed, pathname), isAnthropic: isAnthropicHost };
  }
  if (pathname.endsWith('/messages')) {
    return {
      endpoint: buildUrlWithPath(parsed, `${pathname.slice(0, -'/messages'.length)}/models`),
      isAnthropic: true,
    };
  }
  if (pathname.endsWith('/chat/completions')) {
    return {
      endpoint: buildUrlWithPath(parsed, `${pathname.slice(0, -'/chat/completions'.length)}/models`),
      isAnthropic: isAnthropicHost,
    };
  }
  if (/\/v\d+(?:beta)?(?:\/openai)?$/i.test(pathname)) {
    return { endpoint: buildUrlWithPath(parsed, `${pathname}/models`), isAnthropic: isAnthropicHost };
  }
  return { endpoint: buildUrlWithPath(parsed, `${pathname}/v1/models`), isAnthropic: isAnthropicHost };
}

/**
 * Fetch available model IDs from the configured OpenAI- or Anthropic-compatible `/models` endpoint.
 * @param {{ url: string, key?: string }} options
 * @returns {Promise<string[]>}
 */
export async function fetchAiModels(options = {}) {
  const url = String(options.url || '').trim();
  const key = String(options.key || '').trim();
  if (!url) {
    throw new Error('请先填写 AI URL');
  }

  const { endpoint, isAnthropic } = buildAiModelsEndpoint(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('获取模型列表超时 (30s)')), 30_000);

  let res;
  try {
    const headers = {};
    if (key) {
      if (isAnthropic) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    res = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`获取模型列表失败: ${err?.message || String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    // handled below
  }

  if (!res.ok) {
    const apiErr =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : '') ||
      rawBody.slice(0, 240) ||
      `HTTP ${res.status}`;
    throw new Error(`获取模型列表失败 (${res.status}): ${apiErr}`);
  }

  const rawList = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];

  const seen = new Set();
  const models = [];
  for (const item of rawList) {
    const id = String(
      typeof item === 'string' ? item : item?.id || item?.name || item?.model || ''
    ).trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      models.push(id);
    }
  }

  if (models.length === 0) {
    throw new Error('接口未返回任何可用模型');
  }

  return models;
}

/**
 * Strip a single outer Markdown code fence (` ```lang ... ``` `) if the model wrapped the file content.
 * @param {string} rawText
 * @param {string} originalContent
 */
export function stripMarkdownCodeFence(rawText, originalContent = '') {
  let cleaned = String(rawText ?? '').trim();
  const origTrimmed = String(originalContent ?? '').trim();
  const origWrappedInFences = origTrimmed.startsWith('```') && origTrimmed.endsWith('```');
  const fenceMatch = !origWrappedInFences && cleaned.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }
  const endsWithNewline = /\r?\n$/.test(originalContent);
  if (endsWithNewline && !/\r?\n$/.test(cleaned)) {
    const le = originalContent.includes('\r\n') ? '\r\n' : '\n';
    cleaned += le;
  }
  return cleaned;
}

/**
 * Call the configured AI API to resolve all conflict hunks in a single file.
 * @param {string} fileContent
 * @param {{
 *   filePath: string,
 *   sourceBranch?: string,
 *   targetBranch?: string,
 *   aiConfig: { url: string, key: string, model: string },
 * }} options
 */
export async function resolveFileWithAi(fileContent, options) {
  const aiConfig = options.aiConfig || {};
  const url = String(aiConfig.url || '').trim();
  const key = String(aiConfig.key || '').trim();
  const model = String(aiConfig.model || '').trim();

  if (!url || !key || !model) {
    throw new Error('请先在「设置 → AI」中完整填写 URL、Key 和 Model');
  }

  const { endpoint, isAnthropic } = buildAiChatEndpoint(url);
  const systemPrompt = [
    'You are an expert Git merge conflict resolver.',
    'Resolve all Git conflict markers (<<<<<<<, |||||||, =======, >>>>>>>) in the provided file.',
    'Preserve code correctness, syntax validity, formatting, and combine both branches sensibly when appropriate.',
    'Output ONLY the final resolved file content. Do NOT wrap the output in markdown code fences and do NOT include any explanations.',
  ].join(' ');

  const userPrompt = [
    `File path: ${options.filePath}`,
    `Target branch (Ours / HEAD): ${options.targetBranch || 'HEAD'}`,
    `Incoming branch (Theirs): ${options.sourceBranch || 'incoming'}`,
    '',
    'File content with conflict markers:',
    fileContent,
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI 请求超时 (90s)')), 90_000);

  let res;
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    let bodyPayload;
    if (isAnthropic) {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      bodyPayload = {
        model,
        max_tokens: 8192,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      };
    } else {
      headers.Authorization = `Bearer ${key}`;
      bodyPayload = {
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      };
    }

    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`AI 接口请求失败 (${ options.filePath }): ${err?.message || String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const rawBody = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawBody);
  } catch {
    // handle non-json error response below
  }

  if (!res.ok) {
    const apiErr =
      data?.error?.message ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : '') ||
      rawBody.slice(0, 240) ||
      `HTTP ${res.status}`;
    throw new Error(`AI 接口返回错误 (${res.status}): ${apiErr}`);
  }

  let extracted = '';
  if (isAnthropic) {
    if (data?.stop_reason === 'max_tokens') {
      throw new Error(`AI 输出超出 max_tokens 上限被截断，已拒绝覆盖文件: ${options.filePath}`);
    }
    if (Array.isArray(data?.content)) {
      extracted = data.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
    }
  } else {
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error(`AI 输出被截断 (finish_reason=length)，已拒绝覆盖文件: ${options.filePath}`);
    }
    const msgContent = choice?.message?.content;
    if (typeof msgContent === 'string') {
      extracted = msgContent;
    } else if (Array.isArray(msgContent)) {
      extracted = msgContent
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join('');
    }
  }

  const resolvedContent = stripMarkdownCodeFence(extracted, fileContent);
  if (!resolvedContent.trim() && fileContent.trim()) {
    throw new Error(`AI 返回了空内容，未能解决冲突文件: ${options.filePath}`);
  }

  if (hasConflictMarkers(resolvedContent)) {
    throw new Error(`AI 返回的内容仍包含未解决的冲突标记: ${options.filePath}`);
  }

  return resolvedContent;
}

/**
 * Automatically resolve all conflicted files in `workDir` using the configured AI and complete the merge commit.
 * @param {string} workDir
 * @param {{
 *   sourceBranch?: string,
 *   targetBranch?: string,
 *   autoPush?: boolean,
 *   wtBin?: string,
 *   repoPath?: string,
 *   wtMergeOptions?: Record<string, any> | null,
 *   trackedFiles?: string[],
 *   aiConfig?: { url: string, key: string, model: string },
 *   onProgress?: (event: Record<string, any>) => void,
 * }} options
 */
export async function aiResolveAndCompleteConflictMerge(workDir, options = {}) {
  const aiConfig = options.aiConfig || {};
  const emit = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  if (!aiConfig.url || !aiConfig.key || !aiConfig.model) {
    throw new Error('请先在「设置 → AI」中完整填写 URL、Key 和 Model');
  }

  const trackedFiles = Array.isArray(options.trackedFiles) ? options.trackedFiles : [];
  const initialStatus = await getConflictStatus(workDir, trackedFiles);
  const unresolvedFiles = initialStatus.files.filter((f) => !f.resolved || f.unmerged || f.hunkCount > 0);
  const resolvedFiles = [];
  const totalFiles = unresolvedFiles.length;

  emit({
    type: 'start',
    model: aiConfig.model,
    totalFiles,
    files: unresolvedFiles.map((f) => f.path),
    sourceBranch: options.sourceBranch || '',
    targetBranch: options.targetBranch || '',
  });

  for (let i = 0; i < totalFiles; i += 1) {
    const fileItem = unresolvedFiles[i];
    const index = i + 1;
    const details = await readConflictFileDetails(workDir, fileItem.path);
    emit({
      type: 'file_start',
      index,
      total: totalFiles,
      file: fileItem.path,
      hunkCount: details.hunkCount,
    });

    let nextContent = details.content;
    if (details.hunkCount > 0 || hasConflictMarkers(details.content)) {
      const startedAt = Date.now();
      nextContent = await resolveFileWithAi(details.content, {
        filePath: fileItem.path,
        sourceBranch: options.sourceBranch,
        targetBranch: options.targetBranch,
        aiConfig,
      });
      emit({
        type: 'file_ai_done',
        index,
        total: totalFiles,
        file: fileItem.path,
        elapsedMs: Date.now() - startedAt,
      });
    }
    await resolveConflictFile(workDir, {
      filePath: fileItem.path,
      content: nextContent,
      stage: true,
      trackedFiles: initialStatus.files.map((f) => f.path),
    });
    resolvedFiles.push(fileItem.path);
    emit({
      type: 'file_done',
      index,
      total: totalFiles,
      file: fileItem.path,
    });
  }

  emit({
    type: 'commit_start',
    totalFiles,
  });

  const completeRes = await completeConflictMerge(workDir, {
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    autoPush: options.autoPush,
    wtBin: options.wtBin,
    repoPath: options.repoPath,
    wtMergeOptions: options.wtMergeOptions,
  });

  const finalStatus =
    completeRes.status ||
    (existsSync(workDir)
      ? await getConflictStatus(workDir, initialStatus.files.map((f) => f.path))
      : { workDir, operation: null, unresolvedCount: 0, unmergedFiles: [], files: [] });
  return {
    ...completeRes,
    resolvedFiles,
    aiModel: aiConfig.model,
    status: finalStatus,
  };
}

