#!/usr/bin/env node
/**
 * Launcher for the official Feishu Project (Meego) MCP server.
 *
 * The official package is a stdio proxy to https://project.feishu.cn/mcp_server/v1 and
 * needs exactly one secret: MCP_USER_TOKEN. We do not want that secret pasted into
 * cordis.patch.yml (it ends up in a tracked file, in chat transcripts and in backups),
 * so the token is resolved at start-up instead:
 *
 *   1. process.env.MCP_USER_TOKEN      ← dsh can forward it from the host env
 *   2. <credential file>               ← CHATOPS_MEEGO_ENV_FILE, else %USERPROFILE%\.dsh\chatops\meego\.env
 *   3. <cwd>/.env                      ← whatever the official package would have read anyway
 *
 * Write the credential file once (PowerShell):
 *
 *   $dir = "$env:USERPROFILE\.dsh\chatops\meego"; New-Item -ItemType Directory -Force $dir
 *   Set-Content "$dir\.env" 'MCP_USER_TOKEN=m-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
 *
 * Rotating the token is then a one-line file edit — no bundle reinstall, no patch edit.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { resolveGlobalFile } from './cli.js';

/** 官方包相对 node_modules 的位置；实际位置靠推导，不写死盘符。 */
const OFFICIAL_RELATIVE = join('@lark-project', 'mcp', 'dist', 'index.js');

const OFFICIAL_BIN =
  process.env.CHATOPS_MEEGO_BIN || resolveGlobalFile(OFFICIAL_RELATIVE) || '';

function envFileCandidates() {
  const explicit = process.env.CHATOPS_MEEGO_ENV_FILE;
  if (explicit) return [explicit];
  return [join(homedir(), '.dsh', 'chatops', 'meego', '.env'), join(process.cwd(), '.env')];
}

/** Minimal dotenv parser: KEY=VALUE, `#` comments, single/double quoted values. */
function parseEnvFile(file) {
  const out = {};
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function resolveToken() {
  if (process.env.MCP_USER_TOKEN) {
    return { token: process.env.MCP_USER_TOKEN, source: 'environment' };
  }
  for (const file of envFileCandidates()) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(file);
    // Accept the official name plus the historical aliases people tend to write.
    const token = parsed.MCP_USER_TOKEN || parsed.MEEGO_MCP_USER_TOKEN || parsed.MCP_TOKEN;
    if (token) return { token, source: file };
  }
  return { token: null, source: null };
}

const { token, source } = resolveToken();

if (!token) {
  process.stderr.write(
    [
      'dsh-chatops-mcp: no Feishu Project MCP token.',
      '',
      'Provide one of:',
      '  - env MCP_USER_TOKEN forwarded by cordis.patch.yml, or',
      `  - a credential file at ${join(homedir(), '.dsh', 'chatops', 'meego', '.env')} containing`,
      '      MCP_USER_TOKEN=m-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      '',
      'Get the token from the Feishu Project open platform (MCP user token).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// The official CLI reads MCP_USER_TOKEN at module load, so set it before importing.
process.env.MCP_USER_TOKEN = token;

if (!OFFICIAL_BIN || !existsSync(OFFICIAL_BIN)) {
  process.stderr.write(
    [
      `dsh-chatops-mcp: @lark-project/mcp not found${OFFICIAL_BIN ? ` at ${OFFICIAL_BIN}` : ''}.`,
      'Install it with: npm install -g @lark-project/mcp',
      'Or point CHATOPS_MEEGO_BIN at its dist/index.js.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

if (process.env.CHATOPS_DEBUG === '1') {
  process.stderr.write(`dsh-chatops-mcp: meego token from ${source}\n`);
}

// The official commander setup treats any bare positional as "too many arguments"
// (it has zero positional params), so never inject one. With MCP_USER_TOKEN already
// in env it runs on defaults, which is exactly the proxy mode we want.
if (process.env.CHATOPS_MEEGO_DOMAIN && !process.argv.includes('--domain')) {
  process.argv.push('--domain', process.env.CHATOPS_MEEGO_DOMAIN);
}

await import(pathToFileURL(OFFICIAL_BIN).href);
