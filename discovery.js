/**
 * Catalog discovery for the DingTalk (dws) and Feishu (lark-cli) surfaces.
 *
 * Why this file exists: a hand-written tool array goes stale the moment the CLI
 * ships a new command. Both CLIs can describe themselves, so we read their own
 * catalogs and derive the MCP tool surface from them. Nothing here hard-codes a
 * command name, so `dws upgrade` / `lark-cli update` is enough to pick up new
 * commands — no edit to this bundle.
 *
 *   dws schema --all --compact   → 27 products, ~1100 tools, params included  (5.7s / 2.4MB)
 *   lark-cli schema              → ~250 raw API methods, flags included       (13s  / 1.5MB)
 *
 * Both dumps are expensive, so they are cached on disk and refreshed lazily.
 * The full catalogs are also the reason we do NOT materialise every command as
 * an MCP tool: 1300+ tools would be ~400k tokens of tool definitions on every
 * request. Instead each surface always exposes `*_catalog` + `*_schema` +
 * `*_cli`, and materialises real tools only for the products you opt into.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = process.env.CHATOPS_CACHE_DIR || join(homedir(), '.dsh', 'chatops', 'cache');
const CACHE_TTL_MS = Number(process.env.CHATOPS_CACHE_TTL_MS || 8 * 60 * 60 * 1000);

/** Products materialised when CHATOPS_TOOL_PRODUCTS=auto. Ordered by how often they get asked for. */
export const DEFAULT_PRODUCTS = {
  dingtalk: ['contact', 'calendar', 'chat', 'todo', 'oa', 'drive', 'aisearch', 'doc'],
  feishu: ['im', 'calendar', 'task', 'contact', 'drive', 'approval', 'wiki', 'docs'],
};

function cachePath(name) {
  return join(CACHE_DIR, `${name}.json`);
}

function readCache(name) {
  try {
    const file = cachePath(name);
    if (!existsSync(file)) return null;
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    if (!payload || typeof payload !== 'object') return null;
    const age = Date.now() - Number(payload.fetchedAt || 0);
    return { ...payload, stale: !(age >= 0 && age < CACHE_TTL_MS) };
  } catch {
    return null;
  }
}

function writeCache(name, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(name), JSON.stringify({ fetchedAt: Date.now(), data }, null, 0), 'utf8');
  } catch {
    // A read-only profile still works — we just pay the discover cost every start.
  }
}

/* ------------------------------------------------------------------ *
 * Normalised catalog entry
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} CatalogEntry
 * @property {string} surface        'dingtalk' | 'feishu'
 * @property {string} product        dws product id / lark service
 * @property {string} name           stable short name, e.g. 'contact_user_get'
 * @property {string} cliPath        argv prefix, e.g. 'contact user get'
 * @property {string} summary        one-line description
 * @property {string} description    long description (already trimmed)
 * @property {'read'|'write'} effect
 * @property {string} risk
 * @property {{flag: string, type: string, required: boolean, description?: string, default?: string}[]} params
 * @property {string[]} examples
 */

function trim(text, max = 600) {
  if (!text) return '';
  const flat = String(text).replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function normaliseType(type) {
  switch (type) {
    case 'boolean':
      return 'boolean';
    case 'number':
    case 'integer':
    case 'float':
      return 'number';
    case 'array':
      return 'array';
    default:
      return 'string';
  }
}

function toParamName(name) {
  return String(name)
    .replace(/^--/, '')
    .trim();
}

/** MCP tool names must match [A-Za-z0-9_-]+; CLI paths contain `+`, `.`, and spaces. */
function toToolName(cliPath) {
  return String(cliPath)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * DingTalk: dws schema --all --compact
 * ------------------------------------------------------------------ */

function parseDws(raw) {
  const products = Array.isArray(raw?.products) ? raw.products : [];
  const entries = [];
  for (const product of products) {
    const productId = String(product?.id || '').trim();
    if (!productId) continue;
    for (const tool of product?.tools || []) {
      const cliPath = String(tool?.cli_path || '').trim();
      if (!cliPath) continue;
      const params = [];
      for (const [flag, meta] of Object.entries(tool?.parameters || {})) {
        params.push({
          flag: toParamName(flag),
          type: normaliseType(meta?.type),
          required: Boolean(meta?.required),
          description: trim(meta?.description, 300),
          default: meta?.default === undefined || meta?.default === null ? undefined : String(meta.default),
        });
      }
      const cliName = String(tool?.cli_name || tool?.name || cliPath.split(' ').pop() || '').trim();
      entries.push({
        surface: 'dingtalk',
        product: productId,
        name: toToolName(cliPath),
        cliPath,
        title: trim(tool?.title, 120),
        summary: trim(tool?.agent_summary || tool?.title || cliPath, 240),
        description: trim(tool?.description, 1200),
        // dws uses three effect values: read / write / destructive. Treating anything that
        // is not explicitly `read` as read-only would drop `calendar +cancel-event`
        // (effect: destructive, risk: high, confirmation: user_required) into the read-only
        // tool surface, so the whitelist is inverted: read stays read, everything else writes.
        effect: tool?.effect === 'read' ? 'read' : 'write',
        destructive: tool?.effect === 'destructive' || tool?.confirmation === 'user_required',
        risk: String(tool?.risk || 'low'),
        idempotency: String(tool?.idempotency || ''),
        params,
        examples: Array.isArray(tool?.examples) ? tool.examples.slice(0, 3).map((e) => trim(e, 240)) : [],
        canonicalPath: String(tool?.canonical_path || ''),
        cliName,
      });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Feishu: lark-cli schema
 * ------------------------------------------------------------------ */

function parseLark(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.methods) ? raw.methods : [];
  const entries = [];
  for (const item of list) {
    const fullName = String(item?.name || '').trim();
    if (!fullName) continue;
    const segments = fullName.split(/\s+/);
    if (segments.length < 2) continue;
    const service = segments[0];
    const properties = item?.inputSchema?.properties || {};
    const params = [];

    const paramsBlock = properties.params;
    if (paramsBlock?.properties && typeof paramsBlock.properties === 'object') {
      const requiredSet = new Set(Array.isArray(paramsBlock.required) ? paramsBlock.required : []);
      for (const [key, meta] of Object.entries(paramsBlock.properties)) {
        params.push({
          flag: toParamName(meta?.flag || key),
          type: normaliseType(meta?.type),
          required: requiredSet.has(key),
          description: trim(meta?.description, 300),
          enum: Array.isArray(meta?.enum) ? meta.enum.slice(0, 40) : undefined,
        });
      }
    }

    // `data` / `file` are object carriers passed as one JSON flag (--data / --file).
    for (const carrier of ['data', 'file']) {
      const block = properties[carrier];
      if (!block || typeof block !== 'object') continue;
      const flag = toParamName(block.carrier || `--${carrier}`);
      const requiredSet = new Set(Array.isArray(block.required) ? block.required : []);
      const children = block.properties && typeof block.properties === 'object' ? block.properties : {};
      params.push({
        flag,
        type: 'object',
        required: Array.isArray(item?.inputSchema?.required) && item.inputSchema.required.includes(carrier),
        description: trim(block.description || `${carrier} object`, 300),
        fields: Object.entries(children).map(([key, meta]) => ({
          name: key,
          type: normaliseType(meta?.type),
          required: requiredSet.has(key),
          description: trim(meta?.description, 200),
        })),
      });
    }

    const risk = String(item?._meta?.risk || 'write');
    entries.push({
      surface: 'feishu',
      product: service,
      name: toToolName(fullName),
      cliPath: fullName,
      title: '',
      summary: trim(item?.description || fullName, 240),
      description: trim(item?.description, 1200),
      effect: risk === 'read' ? 'read' : 'write',
      destructive: risk === 'high-risk-write',
      risk,
      idempotency: '',
      params,
      examples: [],
      canonicalPath: fullName,
      scopes: Array.isArray(item?._meta?.scopes) ? item._meta.scopes.slice(0, 6) : [],
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Discovery orchestration
 * ------------------------------------------------------------------ */

const state = {
  dingtalk: { entries: null, error: null, fetchedAt: 0 },
  feishu: { entries: null, error: null, fetchedAt: 0 },
};

async function discoverOne(surface, runner, parser, { force = false } = {}) {
  const slot = state[surface];
  if (slot.entries && !force) return slot;

  if (!force) {
    const cached = readCache(surface);
    if (cached && !cached.stale) {
      slot.entries = parser(cached.data);
      slot.fetchedAt = cached.fetchedAt;
      slot.error = null;
      return slot;
    }
  }

  const result = await runner();
  if (result.ok && result.json !== undefined) {
    slot.entries = parser(result.json);
    slot.fetchedAt = Date.now();
    slot.error = null;
    writeCache(surface, result.json);
    return slot;
  }

  // Refresh failed (CLI missing / offline / logged out): a stale cache beats nothing.
  const cached = readCache(surface);
  if (cached) {
    slot.entries = parser(cached.data);
    slot.fetchedAt = cached.fetchedAt;
    slot.error = `refresh failed, serving cache from ${new Date(cached.fetchedAt).toISOString()}`;
    return slot;
  }

  slot.entries = [];
  slot.error = (result.stderr || result.text || 'no output').slice(0, 800);
  return slot;
}

export async function discoverDingTalk(runCli, options) {
  return discoverOne('dingtalk', () => runCli('dws', ['schema', '--all', '--compact', '--format', 'json'], { timeoutMs: 180000 }), parseDws, options);
}

export async function discoverFeishu(runCli, options) {
  return discoverOne('feishu', () => runCli('lark-cli', ['schema'], { timeoutMs: 180000 }), parseLark, options);
}

/* ------------------------------------------------------------------ *
 * Tool selection + descriptor building
 * ------------------------------------------------------------------ */

/** `CHATOPS_TOOL_PRODUCTS`: '' / 'none' | 'auto' | comma list of product ids */
export function selectedProducts(surface) {
  return productsFor(surface, process.env.CHATOPS_TOOL_PRODUCTS);
}

/**
 * Resolve a product spec into the product ids to materialise.
 * `undefined` means "not configured" (nothing materialised, meta tools only);
 * `auto` means the curated default list for that surface.
 */
export function productsFor(surface, spec) {
  if (spec === undefined) return [];
  const value = String(spec).trim().toLowerCase();
  if (!value || value === 'none' || value === 'off') return [];
  if (value === 'auto') return DEFAULT_PRODUCTS[surface] || [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function maxTools() {
  // 30 keeps the two surfaces' combined tool payload near 20k tokens; a much larger cap
  // costs context on every request and buys little, since *_catalog already exposes all.
  const raw = Number(process.env.CHATOPS_MAX_TOOLS || 30);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

export function effectFilter() {
  // Default matches what the built-in connectors put in the child's env (v1.6.1: 'all').
  // Keeping the two in sync matters because the panel previews with this process's env,
  // which never sees the MCP row's CHATOPS_TOOL_* values.
  const raw = String(process.env.CHATOPS_TOOL_EFFECT || 'all').toLowerCase();
  return raw === 'all' || raw === 'any' ? null : raw;
}

/** The configuration the MCP child was launched with, as far as the Host can tell. */
export function effectiveConfig(overrides = {}) {
  const products = overrides.products ?? process.env.CHATOPS_TOOL_PRODUCTS ?? 'auto';
  const effect = overrides.effect ?? process.env.CHATOPS_TOOL_EFFECT ?? 'all';
  const max = overrides.max ?? maxTools();
  return {
    products,
    effect,
    max,
    effectFilter: String(effect).toLowerCase() === 'all' || String(effect).toLowerCase() === 'any' ? null : effect,
  };
}

function stableOrder(entry) {
  return `${entry.product}\u0000${entry.cliPath}`;
}

/**
 * Rank entries inside one product.
 *
 * Two signals, in order:
 *  1. Semantic priority — which nouns the command is about. A CLI's schema is flat, so
 *     without this the budget goes to whatever is shortest, which promotes trivia
 *     (`im pins list`, `im reactions list`) over the thing people actually ask for
 *     (`im messages mget`).
 *  2. Shorter paths first — CLIs grow specialised sub-commands by appending words
 *     (`contact user profile fields`), so the shorter path is usually the general one.
 *
 * Override with CHATOPS_TOOL_PRIORITY="message,event,task,...".
 */
const DEFAULT_PRIORITY = [
  'message', 'messages', 'event', 'events', 'todo', 'task', 'tasks', 'approval',
  'doc', 'docs', 'document', 'file', 'files', 'node', 'nodes', 'space', 'spaces',
  'workitem', 'workitems', 'record', 'records', 'calendar', 'user', 'users',
  'contact', 'dept', 'group', 'chat', 'drive', 'search', 'list',
];

function priorityList() {
  const raw = process.env.CHATOPS_TOOL_PRIORITY;
  if (!raw) return DEFAULT_PRIORITY;
  const list = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_PRIORITY;
}

function priorityRank(entry, priority) {
  const tokens = entry.cliPath.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let best = priority.length;
  for (const token of tokens) {
    const index = priority.indexOf(token);
    if (index >= 0 && index < best) best = index;
  }
  return best;
}

function productOrder(priority) {
  return (a, b) => {
    const byPriority = priorityRank(a, priority) - priorityRank(b, priority);
    if (byPriority !== 0) return byPriority;
    const byLength = a.cliPath.length - b.cliPath.length;
    if (byLength !== 0) return byLength;
    return a.cliPath < b.cliPath ? -1 : 1;
  };
}

/**
 * Collapse key for "is this the same command?" checks.
 *
 * A CLI often exposes the same operation twice — a `+shortcut` and the raw API path, e.g.
 * `chat +bot-find` vs `chat bot find`. Both survive `toToolName` because `-` and `_` are
 * legal in MCP tool names, so they land as `chat_bot-find` and `chat_bot_find` and would
 * otherwise occupy two slots in the budget for one capability.
 */
function sameCommandKey(name) {
  return name.replace(/[-_]+/g, '').toLowerCase();
}

/**
 * Pick the entries that should become real MCP tools, honouring product/effect/cap filters.
 * `products` / `effect` / `max` default to the env-derived values; the Host panel passes
 * explicit values so it can preview a configuration without restarting the MCP child.
 */
export function selectEntries(
  surface,
  entries,
  { reserved = new Set(), products, effect: effectOverride, max } = {},
) {
  const wantedProducts = products === undefined ? selectedProducts(surface) : productsFor(surface, products);
  if (wantedProducts.length === 0) return { entries: [], reason: 'disabled' };
  const wanted = new Set(wantedProducts);
  let effect;
  if (effectOverride === undefined) {
    effect = effectFilter();
  } else {
    const value = String(effectOverride).toLowerCase();
    effect = value === 'all' || value === 'any' ? null : value;
  }
  // Distinct products can expose the same CLI path (dws ships `doc list` under both
  // `doc` and `devdoc`), so collapse by tool name — MCP requires unique names and the
  // command behind the duplicate is identical.
  const seen = new Set();
  const reservedKeys = new Set([...reserved].map(sameCommandKey));
  const byProduct = new Map();
  for (const entry of entries) {
    if (!wanted.has(entry.product)) continue;
    if (effect && entry.effect !== effect) continue;
    const key = sameCommandKey(entry.name);
    if (reservedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    if (!byProduct.has(entry.product)) byProduct.set(entry.product, []);
    byProduct.get(entry.product).push(entry);
  }
  // Take one slot per product in whitelist order, then the next round, and so on. Plain
  // alphabetical truncation would hand the whole budget to whichever product sorts first
  // (aisearch + calendar alone filled 30), leaving later products with zero tools.
  const rank = productOrder(priorityList());
  for (const list of byProduct.values()) list.sort(rank);
  const order = wantedProducts.filter((product) => byProduct.has(product));
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : maxTools();
  const total = [...byProduct.values()].reduce((sum, list) => sum + list.length, 0);
  const picked = [];
  for (let round = 0; picked.length < cap; round += 1) {
    let progressed = false;
    for (const product of order) {
      const list = byProduct.get(product);
      if (round >= list.length) continue;
      progressed = true;
      picked.push(list[round]);
      if (picked.length >= cap) break;
    }
    if (!progressed) break;
  }
  const got = new Map();
  for (const entry of picked) got.set(entry.product, (got.get(entry.product) || 0) + 1);
  const spread = order
    .map((product) => `${product}:${got.get(product) || 0}/${byProduct.get(product).length}`)
    .join(' ');
  return {
    entries: picked,
    reason: picked.length < total ? `capped at ${cap} of ${total} (${spread})` : spread,
  };
}

function paramSchema(param) {
  const base = {};
  const description = param.description || undefined;
  if (param.type === 'boolean') {
    base.type = 'boolean';
    if (description) base.description = description;
    return base;
  }
  if (param.type === 'number') {
    base.type = 'number';
    if (description) base.description = description;
    return base;
  }
  if (param.type === 'array') {
    base.type = 'array';
    base.items = { type: 'string' };
    if (description) base.description = description;
    return base;
  }
  if (param.type === 'object') {
    base.type = 'object';
    if (description) base.description = description;
    if (Array.isArray(param.fields) && param.fields.length > 0) {
      base.properties = {};
      for (const field of param.fields) {
        base.properties[field.name] = { type: field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string' };
        if (field.description) base.properties[field.name].description = field.description;
      }
      const requiredFields = param.fields.filter((field) => field.required).map((field) => field.name);
      if (requiredFields.length > 0) base.required = requiredFields;
    }
    base.additionalProperties = true;
    return base;
  }
  base.type = 'string';
  if (description) base.description = description;
  if (Array.isArray(param.enum) && param.enum.length > 0) base.enum = param.enum;
  return base;
}

/** Turn a catalog entry into an MCP tool descriptor. */
export function buildToolDescriptor(entry, { surfaceLabel }) {
  const properties = {};
  const required = [];
  for (const param of entry.params) {
    if (!param.flag) continue;
    properties[param.flag] = paramSchema(param);
    if (param.required) required.push(param.flag);
    else if (param.default !== undefined && properties[param.flag].description === undefined) {
      properties[param.flag].description = `default: ${param.default}`;
    }
  }
  const inputSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) inputSchema.required = required;

  const signature = entry.params
    .map((param) => `${param.required ? '' : '['}--${param.flag}${param.required ? '' : ']'}`)
    .join(' ');

  const description = [
    entry.summary || entry.cliPath,
    `${surfaceLabel} CLI: ${entry.cliPath}${signature ? ` ${signature}` : ''}`,
    entry.destructive
      ? 'Effect: DESTRUCTIVE (deletes or cancels remote state; confirm the target exists first).'
      : entry.effect === 'write'
        ? 'Effect: write (changes remote state).'
        : 'Effect: read.',
    entry.description && entry.description !== entry.summary ? entry.description : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: entry.name,
    description: trim(description, 3000),
    inputSchema,
    dynamic: { surface: entry.surface, cliPath: entry.cliPath, params: entry.params },
  };
}

/* ------------------------------------------------------------------ *
 * argv building for dynamic tools
 * ------------------------------------------------------------------ */

function lookupArg(args, flag) {
  if (!args || typeof args !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(args, flag)) return args[flag];
  const snake = flag.replace(/-/g, '_');
  if (Object.prototype.hasOwnProperty.call(args, snake)) return args[snake];
  const camel = flag.replace(/[-_](\w)/g, (_, char) => char.toUpperCase());
  if (Object.prototype.hasOwnProperty.call(args, camel)) return args[camel];
  return undefined;
}

export function buildDynamicArgv(tool, args) {
  const argv = String(tool.dynamic.cliPath).split(/\s+/).filter(Boolean);
  const missing = [];
  for (const param of tool.dynamic.params) {
    const value = lookupArg(args, param.flag);
    if (value === undefined || value === null || value === '') {
      if (param.required) missing.push(param.flag);
      continue;
    }
    const flag = `--${param.flag}`;
    if (param.type === 'boolean') {
      if (value === true || value === 'true') argv.push(flag);
      continue;
    }
    if (param.type === 'object') {
      argv.push(flag, typeof value === 'string' ? value : JSON.stringify(value));
      continue;
    }
    if (param.type === 'array') {
      const list = Array.isArray(value) ? value : String(value).split(',');
      argv.push(flag, list.map((item) => String(item)).join(','));
      continue;
    }
    argv.push(flag, String(value));
  }
  if (missing.length > 0) {
    throw new Error(`missing required argument(s): ${missing.map((flag) => `"--${flag}"`).join(', ')}`);
  }
  return argv;
}

/* ------------------------------------------------------------------ *
 * Catalog / schema query helpers (the always-available meta tools)
 * ------------------------------------------------------------------ */

export function catalogSummary(entries, { query, product, effect, limit = 60 } = {}) {
  let rows = entries;
  if (product) {
    const wanted = new Set(String(product).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
    rows = rows.filter((entry) => wanted.has(entry.product));
  }
  if (effect === 'read' || effect === 'write') {
    rows = rows.filter((entry) => entry.effect === effect);
  }
  if (query) {
    const needle = String(query).toLowerCase();
    rows = rows.filter(
      (entry) =>
        entry.cliPath.toLowerCase().includes(needle) ||
        entry.name.toLowerCase().includes(needle) ||
        (entry.summary || '').toLowerCase().includes(needle) ||
        (entry.title || '').toLowerCase().includes(needle),
    );
  }
  const total = rows.length;
  const cap = Math.min(Number(limit) || 60, 400);
  const shown = rows.slice(0, cap).map((entry) => ({
    name: entry.name,
    cli: entry.cliPath,
    product: entry.product,
    effect: entry.effect,
    ...(entry.destructive ? { destructive: true } : {}),
    summary: entry.summary,
    params: entry.params.map((param) => `${param.required ? '' : '['}--${param.flag}${param.required ? '' : ']'}`).join(' '),
  }));
  return { total, shown: shown.length, tools: shown };
}

/** Parse a raw CLI schema dump into catalog entries. Used by the Host panel routes. */
export function parseCatalog(surface, raw) {
  return surface === 'feishu' ? parseLark(raw) : parseDws(raw);
}

/**
 * Inspect the on-disk catalog without touching the network or the CLI.
 * The Host panel wants a fast first paint, so it reads whatever the MCP child cached.
 */
export function peekCache(surface) {
  const cached = readCache(surface);
  if (!cached) return { fetchedAt: 0, stale: true, entries: [] };
  return { fetchedAt: cached.fetchedAt, stale: cached.stale, entries: parseCatalog(surface, cached.data) };
}

export function cacheDirPath() {
  return CACHE_DIR;
}

export function cacheTtlMs() {
  return CACHE_TTL_MS;
}

export function catalogProducts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const slot = counts.get(entry.product) || { product: entry.product, total: 0, read: 0, write: 0 };
    slot.total += 1;
    if (entry.effect === 'read') slot.read += 1;
    else slot.write += 1;
    counts.set(entry.product, slot);
  }
  return [...counts.values()].sort((a, b) => a.product.localeCompare(b.product));
}

export function findEntry(entries, key) {
  if (!key) return null;
  const needle = String(key).trim().toLowerCase();
  return (
    entries.find((entry) => entry.name.toLowerCase() === needle) ||
    entries.find((entry) => entry.cliPath.toLowerCase() === needle) ||
    entries.find((entry) => entry.canonicalPath && entry.canonicalPath.toLowerCase() === needle) ||
    entries.find((entry) => entry.name.toLowerCase().includes(needle)) ||
    null
  );
}

export function schemaDetail(entry) {
  return {
    name: entry.name,
    cli: entry.cliPath,
    product: entry.product,
    effect: entry.effect,
    destructive: Boolean(entry.destructive),
    risk: entry.risk,
    idempotency: entry.idempotency,
    summary: entry.summary,
    description: entry.description,
    parameters: entry.params,
    examples: entry.examples,
    canonicalPath: entry.canonicalPath,
  };
}
