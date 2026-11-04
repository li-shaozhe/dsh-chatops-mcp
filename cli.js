/**
 * Shared CLI plumbing: locate and run `dws` / `lark-cli`.
 *
 * Split out of server.js so the Host-side panel routes (index.js) can probe the
 * same CLIs without importing the stdio MCP server, which starts reading stdin
 * the moment it is loaded.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CLI_TIMEOUT_MS = Number(process.env.CHATOPS_CLI_TIMEOUT_MS || 60000);

export const DEBUG = process.env.CHATOPS_DEBUG === '1' || process.env.CHATOPS_DEBUG === 'true';
export function debug(...parts) {
  if (DEBUG) process.stderr.write(`[chatops-mcp] ${parts.join(' ')}\n`);
}

/**
 * 这个包要能被别人装，所以**不能写死任何本机绝对路径**。
 *
 * 解析顺序：
 *   1. `CHATOPS_DWS_BIN` / `CHATOPS_LARK_BIN` 显式覆盖
 *   2. 从 node 的位置推全局 npm 前缀（纯路径推算，不跑 npm），再往下找包内可执行文件
 *   3. PATH 里直接找（Unix 是符号链接，Windows 是 .cmd）
 *
 * 原生 exe 优先、JS shim 兜底：两个 shim（`bin/dws.js`、`scripts/run.js`）内部只是
 * `spawnSync` / `execFileSync` 包一层，**都不传 `windowsHide`**；dsh 跑在无控制台进程里，
 * console 子系统的孙进程会被 Windows 分配一个新控制台窗口 —— 就是那个每两分钟闪一次的黑窗口。
 * `CREATE_NO_WINDOW` 只作用于直接子进程、无法沿进程树继承，所以只能绕开 shim 自己 spawn。
 * 顺带快 2–8 倍（实测 `schema --all --compact` 6.0 s → 4.4 s，lark `schema` 13 s → 1.7 s）。
 */
const DWS_PKG = join('node_modules', 'dingtalk-workspace-cli');
const LARK_PKG = join('node_modules', '@larksuite', 'cli');

/**
 * 「npm 前缀」候选：能从中拼出 `<prefix>/node_modules/<pkg>` 的目录。
 *
 * PATH 是最可靠的线索：npm 把 shim（dws.cmd / dws）放在前缀根目录，
 * 所以每个 PATH 目录本身、以及它的上一级 / `../lib`（Unix 布局）都是前缀候选。
 * 另外补上 node 自身所在的目录（node 常与前缀同级）。
 */
function prefixRoots() {
  const roots = [];
  const push = (value) => {
    if (!value) return;
    const normalized = value.replace(/[\\/]+$/, '');
    if (normalized && !roots.includes(normalized)) roots.push(normalized);
  };

  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of pathDirs) {
    if (!dir) continue;
    push(dir);
    push(join(dir, '..'));
    push(join(dir, '..', 'lib'));
  }

  const execDir = dirname(process.execPath);
  push(execDir);
  push(join(execDir, '..'));
  push(join(execDir, '..', 'lib'));

  if (process.env.APPDATA) push(join(process.env.APPDATA, 'npm'));
  if (process.env.NVM_SYMLINK) push(process.env.NVM_SYMLINK);
  return roots;
}

/** PATH 里按平台的扩展名找可执行文件。 */
const PATH_EXTS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

function findOnPath(bins) {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const bin of bins) {
      for (const ext of PATH_EXTS) {
        const candidate = join(dir, bin + ext);
        try {
          if (existsSync(candidate)) return candidate;
        } catch {
          /* 权限问题跳过 */
        }
      }
    }
  }
  return null;
}

export function resolveCli(kind) {
  const envKey = kind === 'dws' ? 'CHATOPS_DWS_BIN' : 'CHATOPS_LARK_BIN';
  const fromEnv = process.env[envKey];
  const pkg = kind === 'dws' ? DWS_PKG : LARK_PKG;
  // 原生 exe 优先，shim 兜底；两个平台的可执行文件名都试一遍。
  const exeRel =
    kind === 'dws'
      ? [join('vendor', 'dws.exe'), join('vendor', 'dws')]
      : [join('bin', 'lark-cli.exe'), join('bin', 'lark-cli')];
  const shimRel = kind === 'dws' ? join('bin', 'dws.js') : join('scripts', 'run.js');

  const candidates = [];
  if (fromEnv) candidates.push(fromEnv);
  for (const root of prefixRoots()) {
    const pkgRoot = join(root, pkg);
    for (const rel of exeRel) candidates.push(join(pkgRoot, rel));
    candidates.push(join(pkgRoot, shimRel));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // 'script' runs through the real node binary; anything else is spawned directly.
    return { mode: /\.(c|m)?js$/i.test(candidate) ? 'script' : 'exe', path: candidate };
  }

  // PATH 兜底。
  const found = findOnPath(kind === 'dws' ? ['dws'] : ['lark-cli']);
  if (found) return { mode: /\.(c|m)?js$/i.test(found) ? 'script' : 'exe', path: found };
  return { mode: 'path', path: kind === 'dws' ? 'dws' : 'lark-cli' };
}

/**
 * 找一个全局安装的包内文件，不写死任何本机路径。
 *
 * `relative` 是相对 `node_modules` 的写法，例如
 * `@lark-project/mcp/dist/index.js`。候选目录同时覆盖 Windows
 * （`<prefix>/node_modules`）与 Unix（`<prefix>/lib/node_modules`）。
 * 找不到返回 `null`，由调用方决定报什么错。
 */
export function resolveGlobalFile(relative) {
  const normalized = relative.replace(/^[\\/]+/, '');
  const candidates = [];
  for (const root of prefixRoots()) {
    candidates.push(join(root, 'node_modules', normalized));
    candidates.push(join(root, 'lib', 'node_modules', normalized));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 权限问题跳过 */
    }
  }
  return null;
}

/**
 * 真正的 node 可执行文件。
 *
 * 不能用 `process.execPath`：宿主跑在 Electron 里时它是 `DeepSeek Harness.exe`，
 * 拿它去跑 JS 会直接失败；把它写进 mcp-client 行的 `command` 更糟 —— 重启后起不来。
 * 顺序：CHATOPS_NODE_BIN → PATH 里的 node → 非 Electron 时的 process.execPath。
 */
export function nodeCommand() {
  const override = process.env.CHATOPS_NODE_BIN;
  if (override && existsSync(override)) return override;
  const fromPath = findOnPath(['node']);
  if (fromPath) return fromPath;
  if (!process.versions.electron) return process.execPath;
  return 'node';
}

/**
 * Run a CLI and return { ok, text, json, stderr, code }.
 * Feishu writes API errors to stderr as JSON; DingTalk prints a banner there.
 */
export function runCli(kind, argv, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  const cli = resolveCli(kind);
  const args = cli.mode === 'script' ? [cli.path, ...argv] : argv;
  const command = cli.mode === 'script' ? nodeCommand() : cli.path;

  debug('exec', cli.mode, command, args.join(' '));

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Keep this true: without CREATE_NO_WINDOW a console-subsystem child of a
      // console-less parent gets its own console window. This is the actual fix
      // for the flashing black window, and it only works because resolveCli now
      // returns the native exe rather than the spawnSync-based JS shim.
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        code: 'timeout',
        text: '',
        stderr: `CLI timed out after ${timeoutMs}ms: ${kind} ${argv.join(' ')}`,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'spawn', text: '', stderr: `Cannot start ${kind} CLI: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let json;
      let parseError;
      if (trimmed) {
        try {
          json = JSON.parse(trimmed);
        } catch (err) {
          parseError = err.message;
        }
      }
      const ok = code === 0 && (json !== undefined || Boolean(trimmed));
      resolve({
        ok,
        code,
        text: trimmed,
        json,
        parseError,
        stderr: stderr.trim(),
      });
    });
  });
}
