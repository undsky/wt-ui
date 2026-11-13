#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnvironment } from '../src/wt-resolver.js';
import { autoInstallWorktrunk } from '../src/wt-installer.js';
import { createAppServer } from '../src/server.js';
import { openBrowser } from '../src/tools.js';
import { inspectGitRepo, parseCodeWorkspace } from '../src/workspace.js';
import { addStandaloneProject, importWorkspaceProjects, loadStore, saveStore } from '../src/store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

function printHelp() {
  console.log(`wt-ui v${pkg.version} — Worktrunk 可视化操作平台

用法:
  wt-ui start [path] [options]   启动 Web 可视化平台并打开浏览器
  wt-ui doctor [--wt-bin <path>] 检查 Worktrunk (wt) 与 Git 环境
  wt-ui --help                   显示帮助信息
  wt-ui --version                显示版本号

选项 (start):
  -p, --port <port>              指定端口 (默认 4173)
  -H, --host <host>              监听地址 (默认 127.0.0.1)
      --wt-bin <path>            指定 Worktrunk wt 可执行文件路径
      --no-open                  启动后不自动打开浏览器
      --no-auto-install          未检测到 wt 时不自动安装
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '-v' || arg === '--version') flags.version = true;
    else if (arg === '--no-open') flags.noOpen = true;
    else if (arg === '--no-auto-install') flags.noAutoInstall = true;
    else if (arg === '-p' || arg === '--port') flags.port = Number(argv[++i]);
    else if (arg === '-H' || arg === '--host') flags.host = argv[++i];
    else if (arg === '--wt-bin') flags.wtBin = argv[++i];
    else if (!arg.startsWith('-')) positionals.push(arg);
  }
  return { positionals, flags };
}

function printInstallGuide(env) {
  if (!env.wtBin && env.installGuide) {
    console.log('\n安装 Worktrunk 引导:');
    for (const opt of env.installGuide.wtOptions) {
      console.log(`  - ${opt.label}: ${opt.command}`);
    }
    console.log(`  文档: ${env.installGuide.docsUrl}`);
  }
  if (!env.gitSupported && env.installGuide) {
    console.log(`\n升级 Git (>= 2.43.0): ${env.installGuide.gitUpgradeCommand}`);
  }
}

async function runDoctor(wtBin) {
  const env = await checkEnvironment({ wtBin });
  console.log('wt-ui 环境检查:');
  console.log(`  Node.js : ${process.version}`);
  console.log(`  Worktrunk (wt): ${env.wtBin ? `${env.wtVersion || 'found'} (${env.wtBin})` : '未找到'}`);
  console.log(`  Git     : ${env.gitVersion || '未找到'} (${env.gitSupported ? '满足 >= 2.43.0' : '不满足 >= 2.43.0'})`);
  if (env.issues.length > 0) {
    console.log('\n发现以下问题:');
    for (const issue of env.issues) {
      console.log(`  ✗ ${issue}`);
    }
    printInstallGuide(env);
    process.exitCode = 1;
  } else {
    console.log('\n✓ 环境就绪');
  }
}

async function preloadTarget(targetPath) {
  const abs = resolve(targetPath);
  if (!existsSync(abs)) {
    console.warn(`⚠ 指定路径不存在，已忽略: ${abs}`);
    return;
  }
  const store = loadStore();
  const stat = statSync(abs);
  if (stat.isFile() && abs.toLowerCase().endsWith('.code-workspace')) {
    const wsData = await parseCodeWorkspace(abs);
    const imported = importWorkspaceProjects(store, wsData);
    saveStore(store);
    console.log(`✓ 已导入工作区 ${imported.workspace.name} (${imported.projects.length} 个 Git 仓库)`);
  } else if (stat.isDirectory()) {
    const gitInfo = await inspectGitRepo(abs);
    if (gitInfo.isGitRepo) {
      const proj = addStandaloneProject(store, { path: gitInfo.rootPath || abs });
      saveStore(store);
      console.log(`✓ 已加载项目 ${proj.name} (${proj.path})`);
    } else {
      console.warn(`⚠ 该目录不是 Git 仓库，已忽略: ${abs}`);
    }
  }
}

async function listenWithFallback(server, host, preferredPort, allowFallback) {
  let port = preferredPort;
  const maxAttempts = allowFallback ? 15 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (err) => {
          server.off('listening', onListen);
          rejectPromise(err);
        };
        const onListen = () => {
          server.off('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, host);
      });
      return port;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE' && allowFallback) {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`No available port starting from ${preferredPort}`);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0] || 'start';

  if (flags.help || command === 'help') {
    printHelp();
    return;
  }
  if (flags.version || command === 'version') {
    console.log(pkg.version);
    return;
  }
  if (command === 'doctor') {
    await runDoctor(flags.wtBin);
    return;
  }

  const targetPath = command === 'start' ? positionals[1] : positionals[0];
  if (targetPath) {
    await preloadTarget(targetPath);
  }

  let env = await checkEnvironment({ wtBin: flags.wtBin });
  if (!env.wtBin && !flags.noAutoInstall) {
    console.log('未检测到 Worktrunk (wt)，正在通过国内源自动安装...');
    const installRes = await autoInstallWorktrunk({
      onLog: (msg) => console.log(`  ${msg}`),
    });
    if (installRes.ok) {
      env = await checkEnvironment({ wtBin: flags.wtBin });
    } else {
      console.warn(`⚠ 自动安装未成功: ${installRes.error}`);
    }
  }
  const host = flags.host || '127.0.0.1';
  const hasExplicitPort = Number.isInteger(flags.port) && flags.port > 0;
  const preferredPort = hasExplicitPort ? flags.port : 4173;

  const server = createAppServer({ wtBin: flags.wtBin });
  const actualPort = await listenWithFallback(server, host, preferredPort, !hasExplicitPort);
  const url = `http://${host}:${actualPort}`;

  console.log(`\nwt-ui v${pkg.version} 已启动: ${url}`);
  if (env.wtBin) {
    console.log(`Worktrunk: ${env.wtVersion || ''} (${env.wtBin})`);
  } else {
    console.log('⚠ 未检测到 Worktrunk (wt)，网页中已提供安装引导。');
  }
  if (!env.ok) {
    printInstallGuide(env);
  }
  console.log('按 Ctrl+C 停止服务\n');

  if (!flags.noOpen) {
    openBrowser(url);
  }
}

main().catch((err) => {
  console.error(`启动失败: ${err.message}`);
  process.exit(1);
});

