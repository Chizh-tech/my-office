export const fromHook = task => ['observed', 'bridge_test'].includes(task.source);
export const taskTitle = task => fromHook(task) ? '任务目标未采集（仅元数据）' : task.title;
export const clientName = task => ({ 'vscode-copilot': 'VS Code', 'copilot-cli': 'Copilot CLI' })[task.provider] ?? '客户端待识别';
export const observationOrigin = task => `${clientName(task)} · ${task.workspaceName || '项目待识别（旧桥接器）'}`;
export const agentName = task => task.profile?.nickname || task.agent;
export const actorName = task => fromHook(task) && task.workspaceName ? task.workspaceName : agentName(task);
export function realObservationState(snapshot) {
  const tasks = snapshot.tasks.filter(task => task.source === 'observed').map(task => {
    const { requestExcerpt, requestAt, ...metadata } = task;
    return { ...metadata, privacy: 'metadata-only', title: observationOrigin(task) };
  });
  const titles = new Map(tasks.map(task => [task.id, task.title]));
  return {
    ...snapshot,
    tasks,
    events: snapshot.events.filter(event => event.source === 'observed').map(event => ({
      ...event, title: titles.get(event.taskId) ?? '真实会话记录',
      message: event.hook ? hookActivity(event.hook, event.tool).label : '观测事件',
    })),
  };
}

export function observationStatus(task, connected = true) {
  if (task.status === 'turn_ended') return 'turn_ended';
  if (!connected || task.stale || task.freshness === 'stale') return 'unknown';
  return task.status === 'in_progress' ? 'in_progress' : 'unknown';
}

export const PROFILE_STORAGE_KEY = 'my-office.character-profiles.v1';
export const profileKey = task => `${task.source}:${task.id}`;

const DEMO_ROLES = {
  'demo-analysis': '检查样件数据、核对异常点并验证分析结论。',
  'demo-report': '整理工作摘要、形成报告草稿，等待内容审核。',
  'demo-knowledge': '提取结论、归类演示笔记并检查来源。',
  'demo-build': '准备脚本输入、检查校验流程并定位阻塞。',
};
export const agentRole = task => task.profile?.role || (task.source === 'simulated' ? DEMO_ROLES[task.id] : '') || '职责尚未设置';

export function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['nickname', 'role'].includes(key))) {
    throw new Error('人物介绍只能包含昵称和职责');
  }
  if (typeof input.nickname !== 'string' || input.nickname.length > 32) throw new Error('昵称最多 32 字');
  if (typeof input.role !== 'string' || input.role.length > 160) throw new Error('职责介绍最多 160 字');
  return { nickname: input.nickname.trim(), role: input.role.trim() };
}

export function decodeProfiles(raw) {
  if (raw === null) return new Map();
  if (typeof raw !== 'string' || raw.length > 512 * 1024) throw new Error('人物介绍存储超过大小限制');
  let saved;
  try { saved = JSON.parse(raw); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('人物介绍存储格式损坏');
    throw error;
  }
  if (!saved || saved.version !== 1 || Object.keys(saved).some(key => !['version', 'entries'].includes(key))
    || !Array.isArray(saved.entries) || saved.entries.length > 500) {
    throw new Error('不支持的人物介绍存储格式或数量');
  }
  const profiles = new Map();
  const seen = new Set();
  for (const entry of saved.entries) {
    if (!Array.isArray(entry) || entry.length !== 2
      || typeof entry[0] !== 'string' || !/^(observed|bridge_test|manual|simulated):[\w-]{1,200}$/.test(entry[0])
      || seen.has(entry[0])) throw new Error('人物介绍身份标识无效或重复');
    seen.add(entry[0]);
    const value = validateProfile(entry[1]);
    if (value.nickname || value.role) profiles.set(entry[0], value);
  }
  return profiles;
}

export function encodeProfiles(profiles) {
  const raw = JSON.stringify({ version: 1, entries: [...profiles] });
  return JSON.stringify({ version: 1, entries: [...decodeProfiles(raw)] });
}

const TOOL_GROUPS = [
  [['read', 'view', 'read_file', 'readfile'], '读取文件', '文件读取工具已返回'],
  [['grep', 'rg', 'glob', 'file_search', 'text_search', 'semantic_search'], '搜索项目内容', '搜索工具已返回'],
  [['applypatch', 'apply_patch', 'edit', 'editfiles', 'replace_string_in_file', 'create_file', 'write'], '修改文件', '文件修改工具已返回'],
  [['powershell', 'bash', 'run_in_terminal', 'terminal'], '运行命令', '命令工具已返回'],
  [['runtests', 'run_tests'], '运行测试', '测试工具已返回'],
  [['readpage', 'screenshotpage', 'runplaywrightcode', 'openbrowserpage', 'clickelement', 'navigatepage'], '检查或操作页面', '浏览器工具已返回'],
  [['webfetch', 'web_fetch', 'fetch_webpage'], '读取网页资料', '网页读取工具已返回'],
  [['task', 'agent', 'runsubagent', 'create_session'], '调用委派工具', '委派工具已返回'],
  [['askuser', 'ask_user', 'ask_questions'], '发起用户询问', '用户询问工具已返回'],
];

export function hookActivity(hook, tool) {
  if (['PreToolUse', 'PostToolUse'].includes(hook)) {
    const key = (tool ?? '').split(/[./:]/).at(-1).toLowerCase();
    const group = TOOL_GROUPS.find(([names]) => names.includes(key));
    return {
      label: hook === 'PreToolUse' ? (group ? `准备${group[1]}` : '准备调用工具') : (group?.[2] ?? '工具已返回'),
      detail: hook === 'PreToolUse' ? '仅观测到调用前事件；是否获准、是否正在执行尚未确认。' : '未采集返回正文；不能据此确认结果正确或业务任务完成。',
    };
  }
  return ({
    SessionStart: { label: '会话已启动', detail: '等待收到本轮用户请求。' },
    UserPromptSubmit: { label: '已收到本轮请求', detail: '尚未观测到后续工具操作；不能判断具体思考或执行进度。' },
    PreCompact: { label: '正在整理会话上下文', detail: '收到上下文压缩事件，不代表业务阶段变化。' },
    SubagentStart: { label: '观测到子 Agent 启动', detail: '不采集委派内容；仅在事件提供独立身份时单独显示人物，不按名称猜测。' },
    SubagentStop: { label: '子 Agent 本轮执行结束', detail: '不代表业务任务已完成，请在原聊天检查结果。' },
    Stop: { label: '本轮执行结束', detail: '不代表业务任务已完成或会话已关闭，请在原聊天检查结果。' },
    SessionEnd: { label: 'CLI 会话已结束', detail: '不代表业务任务已完成，请在原 CLI 检查结果。' },
    PostToolUseFailure: { label: '收到工具失败事件', detail: '错误正文未采集，不代表整个业务任务失败，请在原 CLI 检查。' },
    ErrorOccurred: { label: '收到客户端错误事件', detail: '错误正文未采集，无法判断是否已恢复或业务任务是否失败。' },
  })[hook] ?? { label: '暂无可解释的操作记录', detail: '未收到受支持的活动事件。' };
}

export function observedActivity(task, connected = true) {
  const latest = hookActivity(task.lastHook, task.lastTool);
  if (!connected) return { ...latest, label: '连接中断，当前状态未知', detail: `页面状态未刷新。最后记录：${latest.label}。` };
  if (task.stale) return {
    ...latest,
    label: task.status === 'turn_ended' ? '本轮执行已结束，记录已过期' : '超过 5 分钟无新事件，状态未确认',
    detail: `最后记录：${latest.label}。无新事件不代表离线，也不代表业务完成。`,
  };
  return latest;
}

export function intervention(task, connected = true) {
  if (!connected) return '连接中断，无法确认是否需要你处理；请查看原 Copilot 聊天。';
  if (task.stale) return '记录已过期，无法确认当前是否需要你处理；请查看原 Copilot 聊天。';
  if (task.status === 'turn_ended') return '本轮已结束，建议回到原 Copilot 聊天检查结果；这里无法判断是否还需确认。';
  return '尚无法确认。当前 hooks 不提供完整的提问、权限批准或审核状态；请以原 Copilot 聊天为准。';
}
