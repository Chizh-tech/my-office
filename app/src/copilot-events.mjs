import { createHash } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'SubagentStart', 'SubagentStop', 'Stop'];
export const CLI_EVENTS = {
  sessionStart: 'SessionStart', userPromptSubmitted: 'UserPromptSubmit',
  preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', preCompact: 'PreCompact',
  subagentStart: 'SubagentStart', subagentStop: 'SubagentStop', agentStop: 'Stop', sessionEnd: 'SessionEnd',
  postToolUseFailure: 'PostToolUseFailure', errorOccurred: 'ErrorOccurred',
};
export const PROVIDERS = ['vscode-copilot', 'copilot-cli'];
export const BRIDGE_SCOPES = ['workspace', 'all-local'];
export const OBSERVED_WORKSTREAMS = ['engineering', 'reports', 'knowledge', 'automation'];
export const STALE_MS = 5 * 60 * 1000;
const MAX_INSTANCES = 100;
const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\x00-\x1f]/.test(value);
const pathKey = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const CLI_ONLY_EVENTS = ['SessionEnd', 'PostToolUseFailure', 'ErrorOccurred'];
const EVENT_RANK = Object.fromEntries([...HOOK_EVENTS, ...CLI_ONLY_EVENTS].map((event, index) => [event, index]));
const canonicalEvent = name => CLI_EVENTS[name] ?? name;
const validProjectName = name => typeof name === 'string' && name.length > 0 && name.length <= 128
  && name === name.trim() && !/[\\/\x00-\x1f\x7f]/.test(name);
const CLASSIFICATION_RULES = [
  ['reports', /(?:周报|月报|weekly\s+report|monthly\s+report|status\s+report|工作汇报|进展汇报)/iu],
  ['engineering', /(?:\bDM\b|工程|CPK|DOE|TDM|CT300|waviness|波纹|量测|测量|相关性|correlation|root\s*cause|根因|样件|良率|制程|工艺)/iu],
  ['knowledge', /(?:知识|归档|沉淀|笔记|纪要|obsidian|knowledge|复盘|经验总结|会议记录|workspace-capture|knowledge-capture)/iu],
  ['automation', /(?:代码|脚本|自动化|编程|开发|测试|构建|部署|修复|重构|code|script|automation|debug|test|build|deploy|refactor)/iu],
];

export function recommendWorkstream(prompt) {
  if (typeof prompt !== 'string') return 'automation';
  return CLASSIFICATION_RULES.find(([, pattern]) => pattern.test(prompt))?.[0] ?? 'automation';
}

function localPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !isAbsolute(value)
    || /^[\\/]{2}/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
  return pathKey(value);
}

export function normalizeHook(input, eventName, workspaceRoot, { provider = 'vscode-copilot', scope = 'workspace', version = 2 } = {}) {
  const expectedEvent = canonicalEvent(eventName);
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(EVENT_RANK, expectedEvent)
    || !PROVIDERS.includes(provider) || !BRIDGE_SCOPES.includes(scope) || ![1, 2].includes(version)) return null;
  if (version === 1 && (provider !== 'vscode-copilot' || !HOOK_EVENTS.includes(expectedEvent))) return null;
  if (CLI_ONLY_EVENTS.includes(expectedEvent) && provider !== 'copilot-cli') return null;
  if (input.hook_event_name && canonicalEvent(input.hook_event_name) !== expectedEvent) return null;
  const cwd = localPath(input.cwd);
  if (!cwd || (scope === 'workspace' && cwd !== localPath(workspaceRoot))) return null;
  for (const [snake, camel] of [['session_id', 'sessionId'], ['agent_id', 'agentId'], ['tool_name', 'toolName'], ['tool_use_id', 'toolUseId']]) {
    if (input[snake] !== undefined && input[camel] !== undefined && input[snake] !== input[camel]) return null;
  }
  const session = input.session_id ?? input.sessionId;
  if (!validId(session)) return null;
  const numericTime = provider === 'copilot-cli' && Number.isSafeInteger(input.timestamp);
  if (!numericTime && (typeof input.timestamp !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(input.timestamp))) return null;
  const timestamp = numericTime ? input.timestamp : Date.parse(input.timestamp);
  if (!Number.isFinite(new Date(timestamp).getTime())) return null;
  const agent = input.agent_id ?? input.agentId;
  if (expectedEvent.startsWith('Subagent') && !validId(agent)
    && !(provider === 'copilot-cli' && expectedEvent === 'SubagentStart' && agent === undefined)) return null;
  if (agent !== undefined && !validId(agent)) return null;
  const workspaceId = hash(cwd);
  // Keep existing VS Code identities (and local character notes) stable across the upgrade.
  const sessionId = hash(provider === 'copilot-cli' ? JSON.stringify([workspaceId, provider, session]) : `${workspaceId}:${session}`);
  const projectName = basename(resolve(input.cwd)).trim().slice(0, 128) || cwd.replace(/[\\/]/g, '');
  if (!validProjectName(projectName)) return null;
  const tool = input.tool_name ?? input.toolName;
  const event = {
    version,
    ...(version === 2 ? { provider, workspaceName: projectName } : {}),
    workspaceId,
    sessionId,
    agentId: agent ? hash(`${sessionId}:${agent}`) : null,
    event: expectedEvent,
    at: new Date(timestamp).toISOString(),
    tool: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(expectedEvent) && typeof tool === 'string' && /^[\w./:-]{1,100}$/.test(tool) ? tool : null,
  };
  if (version === 2 && expectedEvent === 'UserPromptSubmit') event.recommendedWorkstream = recommendWorkstream(input.prompt);
  const toolId = input.tool_use_id ?? input.toolUseId;
  return { ...event, eventId: hash(JSON.stringify(event) + (validId(toolId) ? toolId : '')) };
}

export function workspaceIdentity(root) { return hash(pathKey(root)); }

export function validateHookEvent(event, workspaceId, now, scope = 'workspace') {
  const fields = ['version', 'provider', 'workspaceName', 'workspaceId', 'sessionId', 'agentId', 'event', 'at', 'tool', 'eventId'];
  if (!event || typeof event !== 'object' || Array.isArray(event) || fields.some(field => !Object.hasOwn(event, field))
    || Object.keys(event).some(field => ![...fields, 'recommendedWorkstream'].includes(field))) throw new Error('Invalid bridge event');
  if (!BRIDGE_SCOPES.includes(scope) || event.version !== 2 || !PROVIDERS.includes(event.provider) || !validProjectName(event.workspaceName)
    || !opaque(event.workspaceId) || (scope === 'workspace' && event.workspaceId !== workspaceId)
    || !opaque(event.sessionId) || !opaque(event.eventId) || (event.agentId !== null && !opaque(event.agentId))) throw new Error('Invalid bridge identity');
  if (!Object.hasOwn(EVENT_RANK, event.event) || (event.event.startsWith('Subagent') && !event.agentId
    && !(event.provider === 'copilot-cli' && event.event === 'SubagentStart'))
    || (CLI_ONLY_EVENTS.includes(event.event) && event.provider !== 'copilot-cli')) throw new Error('Invalid hook event type');
  if (event.tool !== null && (typeof event.tool !== 'string' || !/^[\w./:-]{1,100}$/.test(event.tool))) throw new Error('Invalid tool name');
  if (Object.hasOwn(event, 'recommendedWorkstream')
    && (event.event !== 'UserPromptSubmit' || !OBSERVED_WORKSTREAMS.includes(event.recommendedWorkstream))) throw new Error('Invalid workstream recommendation');
  const timestamp = Date.parse(event.at);
  if (typeof event.at !== 'string' || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== event.at || timestamp > now + 60000 || timestamp < now - STALE_MS) throw new Error('Hook timestamp outside accepted window');
  return event;
}

const NOTES = {
  SessionStart: '已观测到会话开始；任务内容未采集。',
  UserPromptSubmit: '已收到新请求。',
  PreToolUse: '工具即将执行；不代表权限已批准。',
  PostToolUse: '工具已返回；结果内容未采集。',
  PreCompact: '正在压缩上下文。',
  SubagentStart: '子 Agent 开始执行。',
  SubagentStop: '子 Agent 本轮执行结束；不代表业务任务完成。',
  Stop: '本轮执行结束；不代表业务任务完成或会话关闭。',
  SessionEnd: 'CLI 会话已结束；不代表业务任务完成。',
  PostToolUseFailure: '收到工具失败事件；错误正文未采集，不代表整个业务任务失败。',
  ErrorOccurred: '收到客户端错误事件；错误正文未采集，不代表业务任务失败。',
};

export class CopilotSessions {
  constructor({ workspaceRoot, alias = 'My Office', testMode = false, scope = 'workspace', workstreamOverrides = new Map() }, clock = () => Date.now()) {
    if (!BRIDGE_SCOPES.includes(scope) || !localPath(workspaceRoot)) throw new Error('Invalid bridge scope or workspace root');
    this.workspaceId = workspaceIdentity(workspaceRoot);
    this.scope = scope;
    this.alias = alias;
    this.testMode = testMode;
    this.clock = clock;
    this.instances = new Map();
    this.workstreamOverrides = workstreamOverrides;
    this.seen = new Set();
    this.lastReceivedAt = null;
  }

  makeRoomForInstance() {
    if (this.instances.size < MAX_INSTANCES) return;
    const now = this.clock();
    const entries = [...this.instances.entries()]
      .sort((left, right) => Date.parse(left[1].task.updatedAt) - Date.parse(right[1].task.updatedAt));
    for (const [id, entry] of entries) {
      if (now - Date.parse(entry.task.updatedAt) <= STALE_MS) continue;
      if (entry.task.parentId) {
        this.instances.delete(id);
        return;
      }
      const sessionEntries = entries.filter(([, candidate]) => candidate.task.sessionId === entry.task.sessionId);
      if (sessionEntries.some(([, candidate]) => now - Date.parse(candidate.task.updatedAt) <= STALE_MS)) continue;
      for (const [sessionEntryId] of sessionEntries) this.instances.delete(sessionEntryId);
      return;
    }
  }

  receive(input) {
    const event = validateHookEvent(input, this.workspaceId, this.clock(), this.scope);
    if (this.seen.has(event.eventId)) return null;
    const id = `copilot-${event.sessionId}-${event.agentId ?? 'main'}`;
    const previous = this.instances.get(id);
    const occurredAt = Date.parse(event.at);
    if (previous && occurredAt < previous.occurredAt) return null;
    if (!previous) this.makeRoomForInstance();
    if (!previous && this.instances.size >= MAX_INSTANCES) throw new Error('Bridge session limit reached');
    this.seen.add(event.eventId);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    const ended = ['Stop', 'SubagentStop', 'SessionEnd'].includes(event.event);
    const receivedAt = new Date(this.clock()).toISOString();
    const client = event.provider === 'copilot-cli' ? 'Copilot CLI' : 'VS Code';
    const parent = event.agentId ? this.instances.get(`copilot-${event.sessionId}-main`)?.task : null;
    const recommendation = event.event === 'UserPromptSubmit'
      ? event.recommendedWorkstream ?? 'automation'
      : previous?.task.workstreamRecommendation ?? parent?.workstreamRecommendation ?? 'automation';
    const override = this.workstreamOverrides.get(event.sessionId);
    const task = {
      id, source: this.testMode ? 'bridge_test' : 'observed', provider: event.provider,
      workspaceId: event.workspaceId, workspaceName: event.workspaceName, privacy: 'metadata-only',
      sessionId: event.sessionId, parentId: event.agentId ? `copilot-${event.sessionId}-main` : null,
      agent: event.agentId ? `${client} 子 Agent ${event.agentId.slice(0, 6)}` : `${client} ${event.sessionId.slice(0, 6)}`,
      title: `${event.workspaceName} · ${client} · ${event.agentId ? '子 Agent' : '会话'} ${(event.agentId ?? event.sessionId).slice(0, 6)}`,
      workstream: override?.workstream ?? recommendation,
      workstreamRecommendation: recommendation,
      workstreamSource: override ? 'manual' : 'recommended',
      status: ended ? 'turn_ended' : 'in_progress',
      milestones: [], doneCount: 0,
      note: (event.event === 'SubagentStart' && !event.agentId ? '观测到子 Agent 启动；缺少独立标识，不新建人物。' : NOTES[event.event]) + (event.tool ? ` 工具：${event.tool}` : ''),
      createdAt: previous?.task.createdAt ?? receivedAt, updatedAt: receivedAt,
      eventAt: event.at, lastHook: event.event, lastTool: event.tool, needsAttention: false,
    };
    this.instances.set(id, { occurredAt, task });
    this.lastReceivedAt = receivedAt;
    return structuredClone(task);
  }

  setSessionWorkstream(sessionId, workstream) {
    for (const entry of this.instances.values()) {
      if (entry.task.sessionId !== sessionId) continue;
      entry.task.workstream = workstream ?? entry.task.workstreamRecommendation;
      entry.task.workstreamSource = workstream ? 'manual' : 'recommended';
    }
  }

  snapshot() {
    return [...this.instances.values()].map(({ task }) => {
      const stale = this.clock() - Date.parse(task.updatedAt) > STALE_MS;
      return { ...structuredClone(task), freshness: stale ? 'stale' : 'recent', status: stale && task.status !== 'turn_ended' ? 'unknown' : task.status, stale };
    });
  }
}
