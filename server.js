#!/usr/bin/env node
/**
 * dsh-chatops-mcp — one stdio MCP server, three surfaces.
 *
 *   node server.js dingtalk   # DingTalk, wrapping the dws CLI (reuses ~/.dws login)
 *   node server.js feishu     # Feishu, wrapping the lark-cli CLI (reuses ~/.lark-cli login)
 *
 * Feishu Project (Meego) is not here: the bundle mounts the official
 * @lark-project/mcp server for that surface.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdio (MCP 2024-11-05 … 2025-11-25).
 * Nothing is ever written to stdout except JSON-RPC frames; diagnostics go to stderr.
 */

import { runCli, debug } from './cli.js';
import {
  discoverDingTalk,
  discoverFeishu,
  selectEntries,
  buildToolDescriptor,
  buildDynamicArgv,
  catalogSummary,
  catalogProducts,
  findEntry,
  schemaDetail,
  selectedProducts,
} from './discovery.js';

const SERVER_VERSION = '1.7.1';
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const FALLBACK_PROTOCOL = '2025-03-26';
const MAX_TEXT = 80000;

function cliFailure(kind, result, argv) {
  const detail = result.stderr || result.text || '(no output)';
  return errorResult(`${kind} command failed (code=${result.code})\ncommand: ${kind} ${argv.join(' ')}\n\n${detail}`);
}

/* ------------------------------------------------------------------ *
 * Tool result helpers
 * ------------------------------------------------------------------ */

function textResult(payload, { isError = false } = {}) {
  let text;
  if (typeof payload === 'string') {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload, null, 2);
    } catch {
      text = String(payload);
    }
  }
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} chars]`;
  }
  return { content: [{ type: 'text', text }], isError: isError || undefined };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** DingTalk success envelopes can still carry a non-zero errorCode. */
function dwsResult(kind, result, argv) {
  if (!result.ok) return cliFailure(kind, result, argv);
  if (result.json === undefined) {
    return textResult(result.text || '(empty output)');
  }
  const envelope = result.json;
  const errorCode = envelope && typeof envelope === 'object' ? envelope.errorCode : undefined;
  if (errorCode !== undefined && errorCode !== null && errorCode !== 0 && errorCode !== '0') {
    return textResult(envelope, { isError: true });
  }
  return textResult(envelope);
}

/** lark-cli writes its error object to stderr; stdout stays empty on failure. */
function larkResult(result, argv) {
  if (!result.ok) return cliFailure('lark-cli', result, argv);
  if (result.json === undefined) return textResult(result.text || '(empty output)');
  if (result.json && typeof result.json === 'object' && result.json.ok === false) {
    return textResult(result.json, { isError: true });
  }
  return textResult(result.json);
}

function need(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null || value === '') {
    throw new Error(`missing required argument "${name}"`);
  }
  return value;
}

function opt(args, name) {
  const value = args?.[name];
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function str(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

/* ------------------------------------------------------------------ *
 * Surface: DingTalk (dws)
 * ------------------------------------------------------------------ */

const DINGTALK_TOOLS = [
  {
    name: 'dingtalk_whoami',
    description: 'Show the DingTalk identity this MCP server is authenticated as (corp, user, departments, email).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['contact', 'user', 'get-self'],
  },
  {
    name: 'dingtalk_user_search',
    description: 'Search DingTalk directory users by name, nickname, or phone keyword.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search keyword' } },
      required: ['query'],
      additionalProperties: false,
    },
    argv: (args) => ['contact', 'user', 'search', '--query', str(need(args, 'query'))],
  },
  {
    name: 'dingtalk_user_get',
    description: 'Fetch DingTalk user profiles by userId list.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'DingTalk userId values' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
    argv: (args) => ['contact', 'user', 'get', '--ids', str(need(args, 'ids'))],
  },
  {
    name: 'dingtalk_dept_members',
    description: 'List members of one or more DingTalk departments.',
    inputSchema: {
      type: 'object',
      properties: {
        depts: { type: 'array', items: { type: 'string' }, description: 'Department ids' },
      },
      required: ['depts'],
      additionalProperties: false,
    },
    argv: (args) => ['contact', 'dept', 'list-members', '--depts', str(need(args, 'depts'))],
  },
  {
    name: 'dingtalk_send_message',
    description:
      'Send a DingTalk message to a group conversation, a user, or an open conversation id. Exactly one target is required.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'openConversationId of the group' },
        user: { type: 'string', description: 'userId of the recipient' },
        openDingtalkId: { type: 'string', description: 'Encrypted openDingTalkId' },
        text: { type: 'string', description: 'Message body' },
        title: { type: 'string', description: 'Optional card title' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    argv: (args) => {
      const target = ['group', 'user', 'openDingtalkId'].filter((key) => opt(args, key));
      if (target.length !== 1) throw new Error('provide exactly one of "group", "user", "openDingtalkId"');
      const argv = ['chat', 'message', 'send'];
      if (opt(args, 'group')) argv.push('--group', str(args.group));
      if (opt(args, 'user')) argv.push('--user', str(args.user));
      if (opt(args, 'openDingtalkId')) argv.push('--open-dingtalk-id', str(args.openDingtalkId));
      argv.push('--text', str(need(args, 'text')));
      if (opt(args, 'title')) argv.push('--title', str(args.title));
      return argv;
    },
  },
  {
    name: 'dingtalk_list_messages',
    description:
      'List messages of a DingTalk conversation around a reference time. --time is required by dws ("yyyy-MM-dd HH:mm:ss").',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string' },
        user: { type: 'string' },
        openDingtalkId: { type: 'string' },
        time: { type: 'string', description: 'Reference timestamp, "yyyy-MM-dd HH:mm:ss"' },
        direction: { type: 'string', enum: ['older', 'newer'], description: 'Page direction relative to time' },
        limit: { type: 'number', description: 'Max messages' },
      },
      required: ['time'],
      additionalProperties: false,
    },
    argv: (args) => {
      const target = ['group', 'user', 'openDingtalkId'].filter((key) => opt(args, key));
      if (target.length !== 1) throw new Error('provide exactly one of "group", "user", "openDingtalkId"');
      const argv = ['chat', 'message', 'list'];
      if (opt(args, 'group')) argv.push('--group', str(args.group));
      if (opt(args, 'user')) argv.push('--user', str(args.user));
      if (opt(args, 'openDingtalkId')) argv.push('--open-dingtalk-id', str(args.openDingtalkId));
      argv.push('--time', str(need(args, 'time')));
      if (opt(args, 'direction')) argv.push('--direction', str(args.direction));
      if (opt(args, 'limit')) argv.push('--limit', String(args.limit));
      return argv;
    },
  },
  {
    name: 'dingtalk_list_groups',
    description: 'List DingTalk group conversations the current user belongs to.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        role: { type: 'string', enum: ['OWNER', 'ADMIN'], description: 'Filter by the caller role' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['chat', 'group', 'list-my-groups'];
      if (opt(args, 'limit')) argv.push('--limit', String(args.limit));
      if (opt(args, 'role')) argv.push('--role', str(args.role));
      return argv;
    },
  },
  {
    name: 'dingtalk_calendar_events',
    description: 'List DingTalk calendar events in a time window. Timestamps are ISO-8601 (e.g. 2026-11-02T00:00:00+08:00).',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        limit: { type: 'number' },
        calendarId: { type: 'string', description: 'Defaults to "primary"' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['calendar', 'event', 'list', '--start', str(need(args, 'start')), '--end', str(need(args, 'end'))];
      if (opt(args, 'limit')) argv.push('--limit', String(args.limit));
      if (opt(args, 'calendarId')) argv.push('--calendar-id', str(args.calendarId));
      return argv;
    },
  },
  {
    name: 'dingtalk_calendar_create',
    description: 'Create a DingTalk calendar event. start/end are ISO-8601 with an explicit offset.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'DingTalk userId values' },
        location: { type: 'string' },
      },
      required: ['title', 'start', 'end'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = [
        'calendar',
        'event',
        'create',
        '--title',
        str(need(args, 'title')),
        '--start',
        str(need(args, 'start')),
        '--end',
        str(need(args, 'end')),
      ];
      if (opt(args, 'description')) argv.push('--desc', str(args.description));
      if (opt(args, 'attendees')) argv.push('--attendees', str(args.attendees));
      if (opt(args, 'location')) argv.push('--location', str(args.location));
      return argv;
    },
  },
  {
    name: 'dingtalk_todo_list',
    description: 'List DingTalk todo tasks for the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number' },
        size: { type: 'number', description: 'Default 20' },
        status: { type: 'boolean', description: 'Completion status filter' },
        roleTypes: { type: 'string', description: 'Comma-separated role types' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['todo', 'task', 'list'];
      if (opt(args, 'page')) argv.push('--page', String(args.page));
      if (opt(args, 'size')) argv.push('--size', String(args.size));
      if (args?.status !== undefined) argv.push('--status', String(Boolean(args.status)));
      if (opt(args, 'roleTypes')) argv.push('--role-types', str(args.roleTypes));
      return argv;
    },
  },
  {
    name: 'dingtalk_todo_create',
    description: 'Create a DingTalk todo task and assign it to executors.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        executors: { type: 'array', items: { type: 'string' }, description: 'DingTalk userId values' },
        due: { type: 'string', description: 'ISO-8601 due timestamp' },
        priority: { type: 'number', enum: [10, 20, 30, 40] },
      },
      required: ['title', 'executors'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['todo', 'task', 'create', '--title', str(need(args, 'title')), '--executors', str(need(args, 'executors'))];
      if (opt(args, 'due')) argv.push('--due', str(args.due));
      if (opt(args, 'priority')) argv.push('--priority', String(args.priority));
      return argv;
    },
  },
  {
    name: 'dingtalk_approval_pending',
    description: 'List DingTalk OA approval instances waiting for the current user.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO-8601 window start' },
        end: { type: 'string', description: 'ISO-8601 window end' },
        limit: { type: 'number' },
        query: { type: 'string' },
      },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = [
        'oa',
        'approval',
        'list-pending',
        '--start',
        str(need(args, 'start')),
        '--end',
        str(need(args, 'end')),
      ];
      if (opt(args, 'limit')) argv.push('--limit', String(args.limit));
      if (opt(args, 'query')) argv.push('--query', str(args.query));
      return argv;
    },
  },
  {
    name: 'dingtalk_approval_detail',
    description: 'Fetch one DingTalk OA approval instance by instanceId.',
    inputSchema: {
      type: 'object',
      properties: { instanceId: { type: 'string' } },
      required: ['instanceId'],
      additionalProperties: false,
    },
    argv: (args) => ['oa', 'approval', 'detail', '--instance-id', str(need(args, 'instanceId'))],
  },
  {
    name: 'dingtalk_drive_list',
    description: 'List entries of a DingTalk drive folder (workspace/folder node).',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder node id' },
        workspace: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 50' },
        pattern: { type: 'string', description: 'Glob-ish name filter' },
        depth: { type: 'number', description: 'Default 1, max 5' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['drive', 'list'];
      if (opt(args, 'folder')) argv.push('--folder', str(args.folder));
      if (opt(args, 'workspace')) argv.push('--workspace', str(args.workspace));
      if (opt(args, 'limit')) argv.push('--limit', String(args.limit));
      if (opt(args, 'pattern')) argv.push('--pattern', str(args.pattern));
      if (opt(args, 'depth')) argv.push('--depth', String(args.depth));
      return argv;
    },
  },
  {
    name: 'dingtalk_cli',
    description:
      'Escape hatch: run an arbitrary dws subcommand and return its JSON output. Pass the argv array without the binary name, ' +
      'e.g. ["contact","dept","get-info","--dept-id","123"]. Output is always requested as --format json.',
    inputSchema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'dws arguments' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    raw: true,
  },
];

/* ------------------------------------------------------------------ *
 * Surface: Feishu (lark-cli)
 * ------------------------------------------------------------------ */

const FEISHU_TOOLS = [
  {
    name: 'feishu_whoami',
    description: 'Show the Lark/Feishu identity this MCP server acts as (appId, brand, identity, token status).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['whoami'],
  },
  {
    name: 'feishu_user_search',
    description:
      'Search Feishu users by keyword or resolve known ids. Runs as the logged-in user identity, which is why --as user is implied.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword (name, email, …)' },
        queries: { type: 'string', description: 'Comma-separated multi-keyword fanout' },
        userIds: { type: 'string', description: 'Comma-separated open_ids, or "me"' },
        hasChatted: { type: 'boolean' },
        excludeExternalUsers: { type: 'boolean' },
        pageSize: { type: 'number', description: '1-30, default 20' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['contact', '+search-user', '--as', 'user'];
      if (opt(args, 'query')) argv.push('--query', str(args.query));
      if (opt(args, 'queries')) argv.push('--queries', str(args.queries));
      if (opt(args, 'userIds')) argv.push('--user-ids', str(args.userIds));
      if (args?.hasChatted) argv.push('--has-chatted');
      if (args?.excludeExternalUsers) argv.push('--exclude-external-users');
      if (opt(args, 'pageSize')) argv.push('--page-size', String(args.pageSize));
      return argv;
    },
  },
  {
    name: 'feishu_user_get',
    description: 'Fetch one Feishu user profile by id (omit the id to get yourself).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        userIdType: { type: 'string', enum: ['open_id', 'union_id', 'user_id'] },
        as: { type: 'string', enum: ['user', 'bot'] },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['contact', '+get-user'];
      if (opt(args, 'userId')) argv.push('--user-id', str(args.userId));
      if (opt(args, 'userIdType')) argv.push('--user-id-type', str(args.userIdType));
      if (opt(args, 'as')) argv.push('--as', str(args.as));
      return argv;
    },
  },
  {
    name: 'feishu_chat_list',
    description: 'List Feishu chats the caller belongs to (groups by default; pass types "group,p2p" for both).',
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'string', description: 'Comma-separated: group,p2p' },
        pageSize: { type: 'number', description: '1-100, default 20' },
        pageAll: { type: 'boolean' },
        sort: { type: 'string', enum: ['create_time', 'active_time'] },
        excludeMuted: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['im', '+chat-list'];
      if (opt(args, 'types')) argv.push('--types', str(args.types));
      if (opt(args, 'pageSize')) argv.push('--page-size', String(args.pageSize));
      if (args?.pageAll) argv.push('--page-all');
      if (opt(args, 'sort')) argv.push('--sort', str(args.sort));
      if (args?.excludeMuted) argv.push('--exclude-muted');
      return argv;
    },
  },
  {
    name: 'feishu_messages_list',
    description: 'List messages in one Feishu chat or p2p conversation, optionally within a time window.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'oc_… (mutually exclusive with userId)' },
        userId: { type: 'string', description: 'ou_… p2p peer' },
        start: { type: 'string', description: 'ISO-8601 window start' },
        end: { type: 'string', description: 'ISO-8601 window end' },
        order: { type: 'string', enum: ['asc', 'desc'] },
        pageSize: { type: 'number', description: '1-50, default 50' },
        pageAll: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const chatId = opt(args, 'chatId');
      const userId = opt(args, 'userId');
      if (!chatId && !userId) throw new Error('provide "chatId" or "userId"');
      if (chatId && userId) throw new Error('"chatId" and "userId" are mutually exclusive');
      const argv = ['im', '+chat-messages-list'];
      if (chatId) argv.push('--chat-id', str(chatId));
      if (userId) argv.push('--user-id', str(userId));
      if (opt(args, 'start')) argv.push('--start', str(args.start));
      if (opt(args, 'end')) argv.push('--end', str(args.end));
      if (opt(args, 'order')) argv.push('--order', str(args.order));
      if (opt(args, 'pageSize')) argv.push('--page-size', String(args.pageSize));
      if (args?.pageAll) argv.push('--page-all');
      return argv;
    },
  },
  {
    name: 'feishu_message_search',
    description: 'Search Feishu messages by keyword, optionally scoped to chats, senders, and a time window.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        chatId: { type: 'string', description: 'Comma-separated chat ids' },
        chatType: { type: 'string', enum: ['group', 'p2p'] },
        sender: { type: 'string', description: 'Comma-separated open_ids' },
        start: { type: 'string', description: 'ISO-8601 window start' },
        end: { type: 'string', description: 'ISO-8601 window end' },
        isAtMe: { type: 'boolean' },
        pageSize: { type: 'number', description: '1-50, default 20' },
        pageAll: { type: 'boolean' },
        pageLimit: { type: 'number', description: 'Max pages when pageAll, default 20' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['im', '+messages-search'];
      if (opt(args, 'query')) argv.push('--query', str(args.query));
      if (opt(args, 'chatId')) argv.push('--chat-id', str(args.chatId));
      if (opt(args, 'chatType')) argv.push('--chat-type', str(args.chatType));
      if (opt(args, 'sender')) argv.push('--sender', str(args.sender));
      if (opt(args, 'start')) argv.push('--start', str(args.start));
      if (opt(args, 'end')) argv.push('--end', str(args.end));
      if (args?.isAtMe) argv.push('--is-at-me');
      if (opt(args, 'pageSize')) argv.push('--page-size', String(args.pageSize));
      if (args?.pageAll) argv.push('--page-all');
      if (opt(args, 'pageLimit')) argv.push('--page-limit', String(args.pageLimit));
      return argv;
    },
  },
  {
    name: 'feishu_send_message',
    description: 'Send a Feishu text or markdown message to a chat or a p2p peer. Exactly one target is required.',
    inputSchema: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'oc_…' },
        userId: { type: 'string', description: 'ou_…' },
        text: { type: 'string', description: 'Plain text body' },
        markdown: { type: 'string', description: 'Markdown body (alternative to text)' },
        as: { type: 'string', enum: ['user', 'bot'] },
        idempotencyKey: { type: 'string' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const chatId = opt(args, 'chatId');
      const userId = opt(args, 'userId');
      if (!chatId && !userId) throw new Error('provide "chatId" or "userId"');
      if (chatId && userId) throw new Error('"chatId" and "userId" are mutually exclusive');
      if (!opt(args, 'text') && !opt(args, 'markdown')) throw new Error('provide "text" or "markdown"');
      const argv = ['im', '+messages-send'];
      if (chatId) argv.push('--chat-id', str(chatId));
      if (userId) argv.push('--user-id', str(userId));
      if (opt(args, 'text')) argv.push('--text', str(args.text));
      if (opt(args, 'markdown')) argv.push('--markdown', str(args.markdown));
      if (opt(args, 'as')) argv.push('--as', str(args.as));
      if (opt(args, 'idempotencyKey')) argv.push('--idempotency-key', str(args.idempotencyKey));
      return argv;
    },
  },
  {
    name: 'feishu_calendar_agenda',
    description: 'List the current user agenda for a time window (calendar +agenda).',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO-8601 or date; defaults to today 00:00' },
        end: { type: 'string', description: 'ISO-8601 or date; defaults to end of the start day' },
        calendarId: { type: 'string', description: 'Defaults to "primary"' },
      },
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['calendar', '+agenda'];
      if (opt(args, 'start')) argv.push('--start', str(args.start));
      if (opt(args, 'end')) argv.push('--end', str(args.end));
      if (opt(args, 'calendarId')) argv.push('--calendar-id', str(args.calendarId));
      return argv;
    },
  },
  {
    name: 'feishu_task_create',
    description: 'Create a Feishu task (待办).',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Task title' },
        description: { type: 'string' },
        due: { type: 'string', description: 'ISO-8601, date:YYYY-MM-DD, relative:+2d, or ms timestamp' },
        assignee: { type: 'string', description: 'open_id or app id' },
        follower: { type: 'string', description: 'Comma-separated open_ids' },
        tasklistId: { type: 'string' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['task', '+create', '--summary', str(need(args, 'summary'))];
      if (opt(args, 'description')) argv.push('--description', str(args.description));
      if (opt(args, 'due')) argv.push('--due', str(args.due));
      if (opt(args, 'assignee')) argv.push('--assignee', str(args.assignee));
      if (opt(args, 'follower')) argv.push('--follower', str(args.follower));
      if (opt(args, 'tasklistId')) argv.push('--tasklist-id', str(args.tasklistId));
      return argv;
    },
  },
  {
    name: 'feishu_my_tasks',
    description: 'List Feishu tasks assigned to or followed by the current user.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    argv: () => ['task', '+get-my-tasks'],
  },
  {
    name: 'feishu_doc_fetch',
    description: 'Fetch the content of a Feishu doc/docx/wiki node by URL or token.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'URL or document token' },
        docFormat: { type: 'string', enum: ['xml', 'markdown', 'im-markdown'] },
        scope: { type: 'string', enum: ['full', 'outline', 'range', 'keyword', 'section'] },
        keyword: { type: 'string' },
        detail: { type: 'string', enum: ['simple', 'with-ids', 'full'] },
      },
      required: ['doc'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['docs', '+fetch', '--doc', str(need(args, 'doc'))];
      if (opt(args, 'docFormat')) argv.push('--doc-format', str(args.docFormat));
      if (opt(args, 'scope')) argv.push('--scope', str(args.scope));
      if (opt(args, 'keyword')) argv.push('--keyword', str(args.keyword));
      if (opt(args, 'detail')) argv.push('--detail', str(args.detail));
      return argv;
    },
  },
  {
    name: 'feishu_drive_search',
    description: 'Search Feishu cloud drive / docs by title keyword (max 30 characters per the API).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        docTypes: { type: 'string', description: 'e.g. docx,sheet,bitable,wiki' },
        pageSize: { type: 'number', description: '1-20, default 15' },
        mine: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    argv: (args) => {
      const argv = ['drive', '+search', '--query', str(need(args, 'query'))];
      if (opt(args, 'docTypes')) argv.push('--doc-types', str(args.docTypes));
      if (opt(args, 'pageSize')) argv.push('--page-size', String(args.pageSize));
      if (args?.mine) argv.push('--mine');
      return argv;
    },
  },
  {
    name: 'feishu_cli',
    description:
      'Escape hatch: run an arbitrary lark-cli command and return its JSON output. Pass the argv array without the binary name, ' +
      'e.g. ["calendar","+agenda","--start","2026-11-02"]. Output is appended as --format json.',
    inputSchema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'lark-cli arguments' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
    raw: true,
  },
];

/* ------------------------------------------------------------------ *
 * Catalog meta tools (always present, even when no product is enabled)
 * ------------------------------------------------------------------ */

function metaTools(label, prefix) {
  return [
    {
      name: `${prefix}_catalog`,
      description:
        `List what the ${label} CLI can do right now, straight from the CLI's own catalog. ` +
        'Pass no filters to get per-product counts, then narrow with product / query / effect. ' +
        'This is the discovery entry point: if a command exists here it can be run through ' +
        `${prefix}_cli or ${prefix}_schema, even when it is not materialised as its own tool.`,
      inputSchema: {
        type: 'object',
        properties: {
          product: { type: 'string', description: 'Product/service id, or a comma-separated list (e.g. "contact,calendar")' },
          query: { type: 'string', description: 'Substring matched against command path, name and summary' },
          effect: { type: 'string', enum: ['read', 'write'], description: 'Only read-only or only write commands' },
          limit: { type: 'number', description: 'Max rows to return (default 60, max 400)' },
          refresh: { type: 'boolean', description: 'Re-read the CLI catalog instead of using the cached copy' },
        },
        additionalProperties: false,
      },
      meta: { kind: 'catalog' },
    },
    {
      name: `${prefix}_schema`,
      description:
        `Show the full parameter schema of one ${label} command: every CLI flag, its type, whether it is ` +
        'required, plus the command description and examples. Use it before running an unfamiliar or ' +
        'write command so you send the right flags.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Tool name, CLI path or canonical path — e.g. "contact user get" or "contact_user_get"',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      meta: { kind: 'schema' },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Surface dispatch
 * ------------------------------------------------------------------ */

// Feishu Project (Meego) is deliberately absent: the official @lark-project/mcp
// server covers it with 48 tools and needs only one MCP user token, so this bundle
// mounts it directly (see cordis.patch.yml) instead of re-implementing the Open API.
const SURFACES = {
  dingtalk: {
    label: 'DingTalk',
    prefix: 'dingtalk',
    tools: DINGTALK_TOOLS,
    cli: 'dws',
    discover: discoverDingTalk,
  },
  feishu: {
    label: 'Feishu',
    prefix: 'feishu',
    tools: FEISHU_TOOLS,
    cli: 'lark-cli',
    discover: discoverFeishu,
  },
};

/**
 * Append the output-format flag only where every subcommand accepts it.
 * dws exposes --format globally; lark-cli already defaults to json but rejects
 * --format on a few management commands (e.g. `whoami`), so we leave it off.
 */
function withFormatFlag(kind, argv) {
  return kind === 'dws' ? [...argv, '--format', 'json'] : argv;
}

async function callCliTool(surface, tool, args) {
  let argv;
  if (tool.raw) {
    argv = Array.isArray(args?.argv) ? args.argv.map((item) => String(item)) : null;
    if (!argv || argv.length === 0) return errorResult('"argv" must be a non-empty array of strings');
  } else if (tool.dynamic) {
    try {
      argv = buildDynamicArgv(tool, args || {});
    } catch (err) {
      return errorResult(`${err.message}\n\nRun ${surface.prefix}_schema with "${tool.dynamic.cliPath}" for the full flag list.`);
    }
  } else {
    try {
      argv = tool.argv(args || {});
    } catch (err) {
      return errorResult(err.message);
    }
  }
  const finalArgv = withFormatFlag(surface.cli, argv);
  const result = await runCli(surface.cli, finalArgv);
  return surface.cli === 'dws' ? dwsResult('dws', result, finalArgv) : larkResult(result, finalArgv);
}

/* ------------------------------------------------------------------ *
 * Catalog-backed tools
 * ------------------------------------------------------------------ */

/** Cached catalog slots live in discovery.js; this keeps the per-surface tool list in sync. */
async function loadCatalog(surface, { refresh = false } = {}) {
  return surface.discover(runCli, { force: refresh });
}

function staticToolNames(surface) {
  const names = new Set(surface.tools.map((tool) => tool.name));
  for (const tool of metaTools(surface.label, surface.prefix)) names.add(tool.name);
  return names;
}

/**
 * The full tool list for this surface: hand-written convenience tools + catalog meta
 * tools + one dynamic tool per catalog entry that passes the product/effect/cap filter.
 * Rebuilt whenever the catalog is (re)loaded, so a CLI upgrade shows up without code edits.
 */
let dynamicTools = [];
let dynamicNote = '';

function rebuildDynamicTools(surface, entries) {
  const reserved = staticToolNames(surface);
  const { entries: picked, reason } = selectEntries(surfaceName, entries, { reserved });
  dynamicTools = picked.map((entry) => buildToolDescriptor(entry, { surfaceLabel: surface.label }));
  const products = selectedProducts(surfaceName);
  dynamicNote =
    products.length === 0
      ? 'no product enabled (set CHATOPS_TOOL_PRODUCTS to "auto" or a product list)'
      : `${dynamicTools.length} catalog tool(s) from: ${products.join(', ')}${reason ? ` — ${reason}` : ''}`;
  debug('dynamic tools', dynamicTools.length, 'catalog entries', entries.length, reason || '');
}

/** Rebuild the dynamic tool list and tell the client only when the surface actually changed. */
function applyCatalog(surface, entries) {
  rebuildDynamicTools(surface, entries);
  const signature = dynamicTools.map((tool) => tool.name).sort().join(',');
  if (signature === dynamicSignature) return;
  dynamicSignature = signature;
  notifyListChanged();
}

function allTools() {
  return [...metaTools(surface.label, surface.prefix), ...surface.tools, ...dynamicTools];
}

async function callMetaTool(surface, tool, args) {
  const slot = await loadCatalog(surface, { refresh: Boolean(args?.refresh) });
  if (args?.refresh) applyCatalog(surface, slot.entries);

  if (tool.meta.kind === 'catalog') {
    if (!args || (!args.product && !args.query && !args.effect && args.limit === undefined)) {
      return textResult({
        surface: surfaceName,
        cli: surface.cli,
        catalogSize: slot.entries.length,
        fetchedAt: slot.fetchedAt ? new Date(slot.fetchedAt).toISOString() : null,
        error: slot.error || undefined,
        materialised: dynamicNote,
        products: catalogProducts(slot.entries),
        hint: 'Narrow with product/query/effect, or run *_cli with the CLI path shown here.',
      });
    }
    return textResult(catalogSummary(slot.entries, args || {}));
  }

  const entry = findEntry(slot.entries, args?.command);
  if (!entry) {
    return errorResult(
      `No catalog entry matches "${args?.command}". Run ${surface.prefix}_catalog first to see what exists.`,
    );
  }
  return textResult(schemaDetail(entry));
}

/* ------------------------------------------------------------------ *
 * JSON-RPC over stdio
 * ------------------------------------------------------------------ */

function surfaceFromArgv() {
  const argv = process.argv.slice(2);
  const flagIndex = argv.findIndex((item) => item === '--surface' || item === '-s');
  const candidate =
    (flagIndex >= 0 ? argv[flagIndex + 1] : undefined) ||
    argv.find((item) => !item.startsWith('-')) ||
    process.env.CHATOPS_SURFACE ||
    'dingtalk';
  return String(candidate).toLowerCase();
}

const surfaceName = surfaceFromArgv();
const surface = SURFACES[surfaceName];

if (!surface) {
  process.stderr.write(
    `dsh-chatops-mcp: unknown surface "${surfaceName}". Expected one of: ${Object.keys(SURFACES).join(', ')}\n`,
  );
  process.exit(2);
}

const SERVER_INFO = { name: `chatops-${surfaceName}`, version: SERVER_VERSION };
debug('surface', surfaceName, 'tools', surface.tools.length);

/**
 * Warm the catalog in the background. The first start on a cold cache has to run the
 * CLI's own schema command (dws ~6s, lark-cli ~13s); later starts read the disk cache
 * in milliseconds. `initialize` waits for this so the very first tools/list already
 * carries the dynamic tools, but it never waits longer than WARM_TIMEOUT_MS — if the
 * warm-up outlives that budget, tools/list_changed tells the client to re-sync.
 */
const WARM_TIMEOUT_MS = Number(process.env.CHATOPS_WARM_TIMEOUT_MS || 30000);
let warmSettled = false;
let initialised = false;
let dynamicSignature = '';
/** Signature of the tool names last handed to the client — null until the first tools/list. */
let servedSignature = null;

const warm = loadCatalog(surface)
  .then((slot) => {
    applyCatalog(surface, slot.entries);
    warmSettled = true;
    return slot;
  })
  .catch((err) => {
    process.stderr.write(`[chatops-mcp] catalog warm-up failed: ${err?.message || err}\n`);
    warmSettled = true;
    return null;
  });

function warmWithTimeout() {
  if (warmSettled) return Promise.resolve();
  return Promise.race([
    warm,
    new Promise((resolve) => {
      const timer = setTimeout(resolve, WARM_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * dsh's MCP client registers `listChanged.tools.onChanged` and re-runs tools/list when it
 * arrives, so a catalog that finishes loading after the first tools/list still shows up as
 * tools. Nothing is announced before a list has been served — that list already reflects
 * whatever the warm-up managed to load, and an early notification would only force a
 * pointless re-sync.
 */
function notifyListChanged() {
  if (!initialised) return;
  if (servedSignature === null) return;
  if (servedSignature === dynamicSignature) return;
  send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function instructions() {
  const label = surface.label;
  return [
    `${label} tools backed by the ${surface.cli} CLI and the existing local login.`,
    'Tools act as the logged-in user; write tools change real data on the tenant.',
    '',
    'The tool list is generated from the CLI own catalog, so it follows CLI upgrades automatically:',
    `- ${surface.prefix}_catalog  one call lists every ${surface.cli} command that exists right now (filter by product/query/effect).`,
    `- ${surface.prefix}_schema   full flag list, types and required flags for one command.`,
    `- ${surface.prefix}_cli      raw escape hatch: {"argv": ["..."]} runs any ${surface.cli} subcommand verbatim.`,
    '',
    `Only a subset is materialised as individual tools (${dynamicNote}). If a command is not in the tool list,`,
    `discover it with ${surface.prefix}_catalog and run it through ${surface.prefix}_schema / ${surface.prefix}_cli.`,
  ].join('\n');
}

async function handleRequest(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : FALLBACK_PROTOCOL;
      await warmWithTimeout();
      initialised = true;
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
        instructions: instructions(),
      });
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list': {
      await warmWithTimeout();
      const tools = allTools();
      sendResult(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      servedSignature = tools.map((tool) => tool.name).sort().join(',');
      return;
    }
    case 'tools/call': {
      const name = params?.name;
      // A pipelined client can send tools/call before initialize settles; wait for the
      // catalog so dynamic tools are resolvable rather than reported as unknown.
      await warmWithTimeout();
      const tool = allTools().find((item) => item.name === name);
      if (!tool) {
        sendError(
          id,
          -32602,
          `Unknown tool: ${name}. Run ${surface.prefix}_catalog to discover what this surface offers, or ${surface.prefix}_cli for anything else.`,
        );
        return;
      }
      const args = params?.arguments || {};
      try {
        const result = tool.meta
          ? await callMetaTool(surface, tool, args)
          : await callCliTool(surface, tool, args);
        sendResult(id, result);
      } catch (err) {
        sendResult(id, errorResult(`${err.name || 'Error'}: ${err.message}`));
      }
      return;
    }
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

let inFlight = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && inFlight === 0) process.exit(0);
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  const isNotification = !('id' in message) || message.id === null || message.id === undefined;
  if (typeof message.method !== 'string') {
    if (!isNotification) sendError(message.id, -32600, 'Invalid request');
    return;
  }
  if (isNotification) {
    debug('notification', message.method);
    return; // notifications/initialized, notifications/cancelled, … need no reply
  }
  inFlight += 1;
  handleRequest(message)
    .catch((err) => {
      sendError(message.id, -32603, `Internal error: ${err.message}`);
    })
    .finally(() => {
      inFlight -= 1;
      maybeExit();
    });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      continue;
    }
    handleMessage(message);
  }
});

process.stdin.on('end', () => {
  stdinClosed = true;
  maybeExit();
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[chatops-mcp] uncaught: ${err.stack || err.message}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[chatops-mcp] unhandled rejection: ${err?.stack || err}\n`);
});
