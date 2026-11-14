import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getWorktreeInProgressOp, pushWorktreeBranch, runGit } from './remote.js';

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
 *   autoPush?: boolean,
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
  const [inProgressOp, statusPorcelain] = await Promise.all([
    getWorktreeInProgressOp(workDir),
    runGit(workDir, ['status', '--porcelain'], { timeout: 5_000 }),
  ]);

  if (inProgressOp === 'rebase') {
    const rebaseCont = recordStep(
      await runGit(workDir, ['-c', 'core.editor=true', 'rebase', '--continue'], { timeout: 30_000 })
    );
    if (!rebaseCont.ok) {
      return buildStepsResult(false, steps);
    }
  } else if (inProgressOp === 'merge' || statusPorcelain.stdout.trim()) {
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

  let targetBranch = String(options.targetBranch || '').trim();
  if (!targetBranch) {
    const revRes = await runGit(workDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5_000 });
    targetBranch = revRes.stdout.trim();
  }

  if (options.autoPush && targetBranch) {
    const pushRes = recordStep(
      await pushWorktreeBranch(workDir, { workDir, branch: targetBranch })
    );
    if (!pushRes.ok) {
      return buildStepsResult(false, steps);
    }
  }

  return buildStepsResult(true, steps);
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
  const trimmed = String(rawUrl || '').trim().replace(/\/+$/, '');
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
  return { trimmed, parsed, pathname };
}

/**
 * Normalize a user-configured AI base URL or full endpoint URL.
 * @param {string} rawUrl
 * @returns {{ endpoint: string, isAnthropic: boolean }}
 */
export function buildAiChatEndpoint(rawUrl) {
  const { trimmed, pathname } = parseAiBaseUrl(rawUrl);
  if (pathname.endsWith('/messages')) {
    return { endpoint: trimmed, isAnthropic: true };
  }
  if (pathname.endsWith('/chat/completions')) {
    return { endpoint: trimmed, isAnthropic: false };
  }
  if (/\/v\d+(?:beta)?(?:\/openai)?$/i.test(pathname)) {
    return { endpoint: `${trimmed}/chat/completions`, isAnthropic: false };
  }
  return { endpoint: `${trimmed}/v1/chat/completions`, isAnthropic: false };
}

/**
 * Derive the models listing endpoint from a user-configured AI base/endpoint URL.
 * @param {string} rawUrl
 * @returns {{ endpoint: string, isAnthropic: boolean }}
 */
export function buildAiModelsEndpoint(rawUrl) {
  const { trimmed, parsed, pathname } = parseAiBaseUrl(rawUrl);
  const isAnthropicHost = /(?:^|\.)anthropic\.com$/i.test(parsed.hostname);
  if (pathname.endsWith('/models')) {
    return { endpoint: trimmed, isAnthropic: isAnthropicHost };
  }
  if (pathname.endsWith('/messages')) {
    return { endpoint: `${trimmed.slice(0, -'/messages'.length)}/models`, isAnthropic: true };
  }
  if (pathname.endsWith('/chat/completions')) {
    return { endpoint: `${trimmed.slice(0, -'/chat/completions'.length)}/models`, isAnthropic: isAnthropicHost };
  }
  if (/\/v\d+(?:beta)?(?:\/openai)?$/i.test(pathname)) {
    return { endpoint: `${trimmed}/models`, isAnthropic: isAnthropicHost };
  }
  return { endpoint: `${trimmed}/v1/models`, isAnthropic: isAnthropicHost };
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
      headers.Authorization = `Bearer ${key}`;
      if (isAnthropic) {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
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
  const fenceMatch = cleaned.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
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
      Authorization: `Bearer ${key}`,
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
  if (isAnthropic && Array.isArray(data?.content)) {
    extracted = data.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  } else {
    const msgContent = data?.choices?.[0]?.message?.content;
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

  const remaining = parseConflictHunks(resolvedContent).hunkCount;
  if (remaining > 0 || /^<{7}\s|^={7}\s*$|^>{7}\s/m.test(resolvedContent)) {
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
    if (details.hunkCount > 0 || /^<{7}\s|^={7}\s*$|^>{7}\s/m.test(details.content)) {
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
  });

  const finalStatus = await getConflictStatus(workDir, initialStatus.files.map((f) => f.path));
  return {
    ...completeRes,
    resolvedFiles,
    aiModel: aiConfig.model,
    status: finalStatus,
  };
}

