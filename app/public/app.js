import { OfficeScene, portraitSvg, executivePortraitSvg } from './office.js';
import { taskTitle, hookActivity, observedActivity, intervention, actorName, agentName, agentRole, clientName, observationOrigin, realObservationState, observationStatus, PROFILE_STORAGE_KEY, profileKey, validateProfile, decodeProfiles, encodeProfiles } from './activity.js';

const get = id => document.getElementById(id);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = name => `<i data-lucide="${name}"></i>`;
const time = (value, seconds = false) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false }).format(new Date(value));
const dateTime = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const sourceBadge = () => '<span class="source-badge observed">真实观测</span>';
const statusLabels = { all: '全部任务', in_progress: '近期活动', turn_ended: '本轮结束', unknown: '状态未确认' };
const initials = task => ({ engineering: 'DM', reports: 'WR', knowledge: 'KB', automation: 'DEV' })[task.workstream];
const avatar = task => `<span class="avatar ${task.workstream}">${portraitSvg(task)}<span class="avatar-code">${initials(task)}</span></span>`;
let state = { tasks: [], events: [], workstreamLabels: {} };
let token;
let selected = null;
let workstream = 'all';
let statusFilter = 'all';
let stream;
let stopped = false;
let connected = false;
let toastTimer;
let searchTimer;
let profiles = new Map();
let profileEditing = null;
let profileStorageError = '';

function refreshIcons() { window.lucide?.createIcons({ attrs: { 'aria-hidden': 'true' } }); }
const scene = new OfficeScene(get('office-canvas'), get('agent-hotspots'), selectTask);

function notify(message, error = false) {
  clearTimeout(toastTimer);
  get('toast').textContent = message;
  get('toast').className = `toast${error ? ' error' : ''}`;
  get('toast').hidden = false;
  toastTimer = setTimeout(() => { get('toast').hidden = true; }, 4500);
}

async function mutate(path, payload, method = 'POST') {
  if (stopped) throw new Error('服务已停止');
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  if (result.tasks) acceptState(result);
  return result;
}

function statusBadge(task) {
  const status = observationStatus(task, connected);
  return `<span class="status-badge ${status}"><span class="status-dot"></span>${statusLabels[status]}</span>`;
}

function profileIdentity(task) {
  const roleOrigin = task.profile?.role ? '用户自定义' : '尚未设置';
  const kind = `${clientName(task)} · ${task.parentId ? '子 Agent' : '主会话'}`;
  return `<div class="detail-agent">${avatar(task)}<div class="identity-name"><strong>${escape(actorName(task))}</strong><p>${escape(agentName(task))} · ${kind}${task.profile?.nickname ? ' · 自定义昵称' : ''}</p></div><button class="icon-button profile-edit" data-profile="${escape(task.id)}" aria-label="编辑人物介绍" title="编辑人物介绍">${icon('contact-round')}</button></div>
    <section class="character-intro" aria-label="人物介绍"><div class="detail-section-heading"><span>负责什么</span><span>${roleOrigin}</span></div><p class="profile-role">${escape(agentRole(task))}</p><p class="identity-original">原始名称：${escape(task.agent)}</p><p class="identity-original">${escape(observationOrigin(task))}</p><details class="identity-facts"><summary>身份与分类</summary><span>执行实例：${escape(task.id)}</span><span>项目标识：${escape(task.workspaceId ?? '旧桥接器未提供')}（同名项目按标识区分）</span><span>工作分类：${escape(state.workstreamLabels[task.workstream])}（${task.workstreamSource === 'manual' ? '手动选择' : '根据请求在桥接器内推荐'}）</span><span>昵称和职责仅为展示备注，不改变 Agent 的行为或权限。</span></details></section>`;
}

function applyProfiles() {
  state = { ...state, tasks: state.tasks.map(task => ({ ...task, profile: profiles.get(profileKey(task)) ?? null })) };
}

function reloadProfiles() {
  try {
    profiles = decodeProfiles(window.localStorage.getItem(PROFILE_STORAGE_KEY));
    profileStorageError = '';
  } catch (error) {
    profiles = new Map();
    profileStorageError = `人物介绍未加载：${error.message}。没有覆盖原存储；其他任务功能仍可使用。`;
    notify(profileStorageError, true);
  }
  get('profile-storage-warning').hidden = !profileStorageError;
  get('profile-storage-error').textContent = profileStorageError;
  applyProfiles();
  render();
  return !profileStorageError;
}

function saveProfile(task, input) {
  const next = decodeProfiles(window.localStorage.getItem(PROFILE_STORAGE_KEY));
  const value = input === null ? null : validateProfile(input);
  if (value && (value.nickname || value.role)) next.set(profileKey(task), value);
  else next.delete(profileKey(task));
  window.localStorage.setItem(PROFILE_STORAGE_KEY, encodeProfiles(next));
  profiles = next;
  applyProfiles();
  selectTask(task.id);
}

function openProfile(task) {
  profileEditing = task.id;
  const form = get('profile-form');
  form.reset();
  get('profile-original').textContent = `真实观测 · 原始名称：${task.agent}`;
  form.elements.nickname.placeholder = task.agent;
  form.elements.nickname.value = task.profile?.nickname ?? '';
  form.elements.role.value = task.profile?.role ?? '';
  get('profile-error').textContent = profileStorageError;
  get('profile-dialog').showModal();
}

function openWorkstream(task) {
  const form = get('workstream-form');
  get('workstream-session').textContent = `${actorName(task)} · ${agentName(task)} · 当前分类：${state.workstreamLabels[task.workstream]}`;
  form.dataset.session = task.sessionId;
  form.elements.workstream.value = task.workstreamSource === 'manual' ? task.workstream : 'auto';
  get('workstream-recommendation').textContent = `自动推荐：${state.workstreamLabels[task.workstreamRecommendation]}。选择自动推荐后，下一条请求会重新判断。`;
  get('workstream-error').textContent = '';
  get('workstream-dialog').showModal();
}

function renderRoster(tasks) {
  const strip = get('agent-strip');
  const focused = document.activeElement?.closest('#agent-strip [data-task]')?.dataset.task;
  const scroll = strip.scrollLeft;
  strip.innerHTML = tasks.map(task => {
    const activity = observedActivity(task, connected).label;
    return `<button class="agent-chip${selected === task.id ? ' selected' : ''}" data-task="${escape(task.id)}" aria-pressed="${selected === task.id}" title="${escape(`${actorName(task)} · ${agentName(task)} · ${observationOrigin(task)} · ${agentRole(task)} · ${activity}`)}">${avatar(task)}<span class="chip-body"><span class="chip-heading"><span class="chip-name">${escape(actorName(task))}</span><span class="chip-source">${task.parentId ? '子 Agent' : '主会话'}</span></span><span class="chip-role">${escape(agentName(task))} · ${escape(clientName(task))}</span><span class="chip-task">${escape(agentRole(task))}</span><span class="chip-activity">${escape(activity)}</span></span></button>`;
  }).join('') || `<div class="empty">${emptyMessage()}</div>`;
  if (focused) [...strip.querySelectorAll('[data-task]')].find(button => button.dataset.task === focused)?.focus({ preventScroll: true });
  strip.scrollLeft = scroll;
  updateRosterControls();
}

function updateRosterControls() {
  const strip = get('agent-strip');
  get('roster-prev').disabled = strip.scrollLeft <= 1;
  get('roster-next').disabled = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1;
}

function emptyMessage() {
  return state.tasks.length ? '没有符合条件的真实记录，请清除筛选。' : '尚未收到真实 Copilot 事件。请在已接入 hooks 的工作区继续聊天。';
}

function filteredTasks() {
  const query = get('search').value.trim().toLowerCase();
  return state.tasks.filter(task => {
    if (workstream !== 'all' && task.workstream !== workstream) return false;
    if (query && !`${observationOrigin(task)} ${task.workspaceId ?? ''} ${task.agent} ${agentName(task)} ${agentRole(task)} ${task.note} ${task.lastTool ?? ''}`.toLowerCase().includes(query)) return false;
    if (statusFilter !== 'all' && observationStatus(task, connected) !== statusFilter) return false;
    return true;
  });
}

function selectTask(id) {
  if (state.tasks.some(task => task.id === id) && !filteredTasks().some(task => task.id === id)) {
    workstream = 'all';
    statusFilter = 'all';
    get('search').value = '';
  }
  const changed = selected !== id;
  selected = id;
  render();
  if (changed) get('detail').scrollTop = 0;
  [...get('agent-strip').querySelectorAll('[data-task]')].find(button => button.dataset.task === selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function acceptState(next) {
  state = realObservationState(next);
  applyProfiles();
  render();
}

function renderNavigation() {
  const items = [['all', 'layout-grid', '全部任务'], ['engineering', 'scan-line', 'DM 工程'], ['reports', 'notebook-pen', '周报 / 月报'], ['knowledge', 'library', '知识整理'], ['automation', 'terminal', '代码与自动化']];
  get('navigation').innerHTML = items.map(([key, symbol, label], index) => {
    const count = state.tasks.filter(task => key === 'all' || task.workstream === key).length;
    const active = key === workstream;
    return `${index === 1 ? '<div class="nav-divider"></div>' : ''}<button class="nav-item${active ? ' selected' : ''}" data-nav="${key}" aria-pressed="${active}">${icon(symbol)}<span>${label}</span><b>${count.toString().padStart(2, '0')}</b></button>`;
  }).join('');
}

function renderDetail(task) {
  get('detail').classList.toggle('observed-detail', Boolean(task));
  if (!task) {
    get('detail').innerHTML = `<div class="detail-empty">${icon('mouse-pointer-2')}${emptyMessage()}</div>`;
    return;
  }
  renderObservedDetail(task);
}

function renderObservedDetail(task) {
  const activity = observedActivity(task, connected);
  const parent = state.tasks.find(item => item.id === task.parentId);
  const events = state.events.filter(event => event.taskId === task.id).slice(0, 6);
  const history = events.map(event => {
    const summary = event.hook ? hookActivity(event.hook, event.tool).label : event.message;
    return `<li><time title="${dateTime(event.eventAt ?? event.at)} 北京时间">${time(event.eventAt ?? event.at, true)}</time><div><span>${escape(summary)}</span>${event.tool ? `<small>${escape(event.tool)}</small>` : ''}</div></li>`;
  }).join('');
  get('detail').innerHTML = `
    <div class="detail-top"><span>人物档案</span>${sourceBadge(task)}</div>
    ${profileIdentity(task)}
    <section class="request-goal" aria-label="任务目标">
      <div class="detail-section-heading"><span>隐私设置 · 仅元数据</span><button class="text-button workstream-edit" data-workstream="${escape(task.id)}" ${!connected || state.bridge?.privacy !== 'metadata-only' ? 'disabled title="需要连接新版服务后修改分类"' : ''}>${escape(state.workstreamLabels[task.workstream])} · 修改</button></div>
      <h2>${escape(taskTitle(task))}</h2>
      <p class="context-hint">按你的设置，不采集请求正文、委派内容、工具参数或返回正文。具体任务目标请在原聊天查看。</p>
    </section>
    ${task.parentId ? `<section class="parent-context"><span>所属主会话</span>${parent ? `<button class="parent-task" data-task="${escape(parent.id)}">${escape(actorName(parent))} · ${escape(agentName(parent))}</button>` : '<p>尚未收到主会话记录</p>'}</section>` : ''}
    <section class="activity-card${task.stale || !connected ? ' uncertain' : ''}" aria-label="最近操作">
      <div class="detail-section-heading"><span>最近操作</span>${statusBadge(task)}</div>
      <strong>${escape(activity.label)}</strong>
      ${task.lastTool ? `<p class="activity-tool">工具：${escape(task.lastTool)}</p>` : ''}
      <p class="context-hint">${escape(activity.detail)}</p>
    </section>
    <section class="detail-section" aria-label="是否需要我处理"><div class="detail-section-heading"><span>是否需要我处理</span><span>以 VS Code Copilot 为准</span></div><p class="detail-note">${escape(intervention(task, connected))}</p><p class="context-hint">办公室是只读观测，不提供批准或拒绝操作，也不根据本轮结束推断等待审批。</p></section>
    <section class="detail-section" aria-label="此人物的最近记录"><div class="detail-section-heading"><span>此人物的最近记录</span><span>最近 ${events.length} 条</span></div><ol class="agent-history">${history || '<li>暂无保留的活动记录</li>'}</ol></section>
    <div class="observation-meta"><span>最近事件：${escape(task.lastHook)} · ${dateTime(task.eventAt)}</span><span>本机接收：${dateTime(task.updatedAt)} · 业务进度未知</span><span>仅保留项目名称、脱敏身份、事件类型、工具名和时间；不读取历史聊天。</span></div>`;
}

function renderTimeline() {
  const events = state.events.filter(event => get('timeline-filter').value !== 'selected' || event.taskId === selected).slice(0, 35);
  get('timeline').innerHTML = events.map(event => `<div class="timeline-event"><time title="${dateTime(event.at)} 北京时间">${time(event.at)}</time><span class="timeline-marker"></span><div><strong>${escape(event.title)}</strong><p>${escape(event.hook ? `${hookActivity(event.hook, event.tool).label}${event.tool ? ` · ${event.tool}` : ''}` : event.message)}</p></div></div>`).join('') || '<div class="empty">暂无真实活动记录</div>';
}

function render() {
  const tasks = filteredTasks();
  if (!tasks.some(task => task.id === selected)) selected = tasks[0]?.id ?? null;
  renderNavigation();
  const count = key => state.tasks.filter(task => key === 'all' || observationStatus(task, connected) === key).length;
  for (const key of ['all', 'in_progress', 'turn_ended', 'unknown']) get(`count-${key}`).textContent = count(key).toString().padStart(2, '0');
  document.querySelectorAll('.metric').forEach(button => {
    const active = button.dataset.status === statusFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  get('overview').textContent = state.tasks.length ? `${state.tasks.length} 个真实执行实例 · 仅元数据 · ${state.bridge?.scope === 'all-local' ? '多项目接收已就绪' : '旧服务 / 单工作区接收'}` : '等待真实 Copilot 事件 · 仅元数据 · 不填充示例数据';
  get('real-count').textContent = state.realConnections ?? 0;
  get('bridge-status').textContent = !state.bridge?.ready ? '未启用' : state.bridge.lastReceivedAt ? `${state.bridge.testMode ? '合成测试' : '最近事件'} ${time(state.bridge.lastReceivedAt)}` : '就绪 · 等待事件';
  get('vp-observation-summary').textContent = !connected ? '连接中断 · 状态未刷新'
    : state.tasks.length ? `${state.tasks.length} 个真实执行实例 · 以 VS Code Copilot 为准` : '等待 Copilot hooks 事件';
  get('breadcrumb').textContent = workstream === 'all' ? statusLabels[statusFilter] : state.workstreamLabels[workstream];
  get('roster-count').textContent = tasks.length;
  get('filter-summary').textContent = `${tasks.length} 项`;
  get('clear-filters').hidden = workstream === 'all' && statusFilter === 'all' && !get('search').value;
  renderRoster(tasks);
  get('task-list').innerHTML = tasks.map(task => `<button class="task-row${selected === task.id ? ' selected' : ''}" data-task="${escape(task.id)}">${avatar(task)}<span><strong>${escape(observationOrigin(task))}</strong><p>${escape(agentName(task))} · ${escape(observedActivity(task, connected).label)}</p><p>${escape(agentRole(task))}</p></span><span class="row-aside">${statusBadge(task)}</span></button>`).join('') || `<div class="empty">${emptyMessage()}</div>`;
  const sceneTasks = tasks.slice(0, 6);
  if (selected && !sceneTasks.some(task => task.id === selected)) sceneTasks[5] = tasks.find(task => task.id === selected);
  get('scene-count').textContent = `场景 ${sceneTasks.length} 位 Agent + Chi · VP${tasks.length > sceneTasks.length ? ' · 其余见名册' : ''}`;
  scene.update(sceneTasks, selected, false, connected);
  renderDetail(tasks.find(task => task.id === selected));
  renderTimeline();
  refreshIcons();
}

document.addEventListener('click', event => {
  const taskButton = event.target.closest('[data-task]');
  if (taskButton) selectTask(taskButton.dataset.task);
  const profileButton = event.target.closest('[data-profile]');
  if (profileButton) openProfile(state.tasks.find(task => task.id === profileButton.dataset.profile));
  const workstreamButton = event.target.closest('[data-workstream]');
  if (workstreamButton) openWorkstream(state.tasks.find(task => task.id === workstreamButton.dataset.workstream));
  const navButton = event.target.closest('[data-nav]');
  if (navButton) {
    workstream = navButton.dataset.nav;
    statusFilter = 'all';
    render();
  }
  const metric = event.target.closest('[data-status]');
  if (metric) { statusFilter = metric.dataset.status; render(); }
});

get('vp-portrait').innerHTML = executivePortraitSvg();

get('close-profile').addEventListener('click', () => get('profile-dialog').close());
get('close-workstream').addEventListener('click', () => get('workstream-dialog').close());
get('workstream-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const value = form.elements.workstream.value;
  try {
    await mutate(`/api/sessions/${form.dataset.session}/workstream`, { workstream: value === 'auto' ? null : value }, 'PATCH');
    get('workstream-dialog').close();
    notify(value === 'auto' ? '已恢复自动分类推荐' : `已将当前会话分类为“${state.workstreamLabels[value]}”；后续请求和子 Agent 将继续使用此分类。`);
  } catch (error) { get('workstream-error').textContent = `分类未保存：${error.message}`; }
});
get('profile-form').addEventListener('submit', event => {
  event.preventDefault();
  const task = state.tasks.find(task => task.id === profileEditing);
  if (!task) { get('profile-error').textContent = '执行实例已不在当前列表，请关闭后重新选择。'; return; }
  try {
    const form = event.currentTarget;
    saveProfile(task, { nickname: form.elements.nickname.value, role: form.elements.role.value });
    get('profile-dialog').close();
    notify('人物介绍已保存到当前客户端；未修改 Agent 的实际职责或任务。');
  } catch (error) { get('profile-error').textContent = `介绍未保存：${error.message}`; }
});
get('profile-reset').addEventListener('click', () => {
  const task = state.tasks.find(task => task.id === profileEditing);
  if (!task) { get('profile-error').textContent = '执行实例已不在当前列表，请关闭后重新选择。'; return; }
  try {
    saveProfile(task, null);
    get('profile-dialog').close();
    notify('此人物已恢复默认介绍');
  } catch (error) { get('profile-error').textContent = `无法恢复默认介绍：${error.message}`; }
});
function clearProfiles() {
  if (!confirm('清除当前客户端保存的全部人物昵称和职责？不会删除任务或修改 Agent。')) return;
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    if (!reloadProfiles()) return;
    get('profile-dialog').close();
    notify('本机人物介绍已清除，任务和原始身份保持不变');
  } catch (error) { notify(`人物介绍未清除：${error.message}`, true); }
}
get('profile-clear-all').addEventListener('click', clearProfiles);
get('profile-recover').addEventListener('click', clearProfiles);
window.addEventListener('storage', event => {
  if (event.key === PROFILE_STORAGE_KEY || event.key === null) reloadProfiles();
});
for (const [id, direction] of [['roster-prev', -1], ['roster-next', 1]]) {
  get(id).addEventListener('click', () => get('agent-strip').scrollBy({ left: direction * get('agent-strip').clientWidth * 0.8, behavior: 'auto' }));
}
get('agent-strip').addEventListener('scroll', updateRosterControls, { passive: true });
window.addEventListener('resize', updateRosterControls);
get('timeline-filter').addEventListener('change', () => { renderTimeline(); refreshIcons(); });
get('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 100); });
get('clear-filters').addEventListener('click', () => {
  workstream = 'all'; statusFilter = 'all'; get('search').value = ''; render();
});
for (const [button, view] of [['office-tab', 'office'], ['list-tab', 'list']]) {
  get(button).addEventListener('click', () => {
    for (const name of ['office', 'list']) {
      get(`${name}-tab`).setAttribute('aria-selected', String(view === name));
      get(`${name}-view`).hidden = view !== name;
    }
  });
}

get('shutdown').addEventListener('click', async () => {
  if (!confirm('停止 My Office 本机服务？内存中的观测记录会清空，已有本地存储不变。')) return;
  try {
    await mutate('/api/shutdown', {});
    stopped = true;
    stream?.close();
    setConnected(false, '服务已停止');
    notify('服务已停止；下次使用需重新启动');
  } catch (error) { notify(error.message, true); }
});

function setConnected(isConnected, label) {
  const changed = connected !== isConnected;
  connected = isConnected;
  get('connection').classList.toggle('offline', !connected);
  get('connection').innerHTML = `<span class="status-dot"></span>${label || (connected ? '本机已连接' : '连接中断 · 状态未刷新')}`;
  if (changed) render();
  get('shutdown').disabled = !connected;
}

async function connect() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error('本机连接失败');
    const session = await response.json();
    token = session.token;
    get('app-version').textContent = session.version ? `v${session.version}` : '版本未知';
    acceptState(session.state);
    stream?.close();
    stream = new EventSource('/api/events');
    stream.onmessage = event => { acceptState(JSON.parse(event.data)); setConnected(true); };
    stream.onerror = () => setConnected(false);
    stream.onopen = async () => {
      try {
        const current = await (await fetch('/api/session')).json();
        token = current.token;
        get('app-version').textContent = current.version ? `v${current.version}` : '版本未知';
        acceptState(current.state);
        setConnected(true);
      } catch { setConnected(false); }
    };
  } catch (error) { setConnected(false, '服务未连接'); notify(error.message, true); }
}
get('clock').textContent = `${time(Date.now(), true)} 北京时间`;
setInterval(() => { get('clock').textContent = `${time(Date.now(), true)} 北京时间`; }, 1000);
refreshIcons();
reloadProfiles();
connect();
