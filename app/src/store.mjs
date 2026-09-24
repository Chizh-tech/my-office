import { randomUUID } from 'node:crypto';
import { CopilotSessions, OBSERVED_WORKSTREAMS } from './copilot-events.mjs';

export const STATUSES = ['queued', 'in_progress', 'waiting_input', 'waiting_review', 'blocked', 'completed', 'failed', 'cancelled'];
export const WORKSTREAMS = ['engineering', 'reports', 'knowledge', 'automation'];
export const STATUS_LABELS = {
  queued: '排队中', in_progress: '进行中', waiting_input: '等待输入', waiting_review: '等待审核',
  blocked: '已阻塞', completed: '已完成', failed: '失败', cancelled: '已取消',
};
export const WORKSTREAM_LABELS = {
  engineering: 'DM 工程', reports: '周报 / 月报', knowledge: '知识整理', automation: '代码与自动化',
};
const ATTENTION = new Set(['waiting_input', 'waiting_review', 'blocked', 'failed']);
const MAX_EVENTS = 300;
const RETENTION = 7 * 24 * 60 * 60 * 1000;

function text(value, name, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${name}格式不正确（最多 ${max} 字）`);
  }
  return value.trim();
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务格式不正确');
  const allowed = new Set(['title', 'agent', 'workstream', 'status', 'note', 'milestones', 'doneCount']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('存在不支持的字段');
  const title = text(input.title, '任务名称', 100);
  const agent = text(input.agent, '执行者', 32);
  const note = text(input.note ?? '', '备注', 500, false);
  if (!WORKSTREAMS.includes(input.workstream)) throw new Error('工作分类不正确');
  if (!STATUSES.includes(input.status)) throw new Error('任务状态不正确');
  if (!Array.isArray(input.milestones) || input.milestones.length > 8) throw new Error('最多 8 个阶段');
  const milestones = input.milestones.map(value => text(value, '阶段名称', 48));
  const doneCount = input.doneCount;
  if (!Number.isInteger(doneCount) || doneCount < 0 || doneCount > milestones.length) throw new Error('阶段进度不正确');
  if (input.status === 'completed' && doneCount !== milestones.length) throw new Error('完成任务前请确认全部阶段');
  if (ATTENTION.has(input.status) && !note) throw new Error('请填写需要处理或阻塞的原因');
  return { title, agent, note, workstream: input.workstream, status: input.status, milestones, doneCount };
}

export class OfficeStore {
  constructor(saved = null, clock = () => Date.now(), bridgeOptions = null) {
    this.clock = clock;
    this.classificationOverrides = new Map();
    this.tasks = [];
    this.events = [];
    this.running = false;
    this.tickCount = 0;
    if (saved !== null) {
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('不支持的存储版本');
      for (const task of saved.tasks.slice(0, 100)) {
        if (task.source !== 'manual' || typeof task.id !== 'string' || !Number.isFinite(Date.parse(task.updatedAt))) throw new Error('存储数据不正确');
        if (this.clock() - Date.parse(task.updatedAt) > RETENTION) continue;
        const { title, agent, note, workstream, status, milestones, doneCount } = task;
        const fields = validate({ title, agent, note, workstream, status, milestones, doneCount });
        this.tasks.push({ ...fields, id: task.id, source: 'manual', updatedAt: task.updatedAt, createdAt: task.updatedAt });
      }
      if (saved.classifications !== undefined && !Array.isArray(saved.classifications)) throw new Error('存储分类数据不正确');
      for (const item of (saved.classifications ?? []).slice(0, 100)) {
        if (!item || typeof item !== 'object' || !/^[a-f0-9]{64}$/.test(item.sessionId)
          || !OBSERVED_WORKSTREAMS.includes(item.workstream) || !Number.isFinite(Date.parse(item.updatedAt))) {
          throw new Error('存储分类数据不正确');
        }
        this.classificationOverrides.set(item.sessionId, { workstream: item.workstream, updatedAt: item.updatedAt });
      }
    }
    this.copilot = bridgeOptions ? new CopilotSessions({ ...bridgeOptions, workstreamOverrides: this.classificationOverrides }, clock) : null;
  }

  now() { return new Date(this.clock()).toISOString(); }

  observe(event) {
    if (!this.copilot) throw new Error('Bridge unavailable');
    const task = this.copilot.receive(event);
    if (task) this.record(task, `${task.lastHook} · ${task.note}`);
    return Boolean(task);
  }

  setObservedWorkstream(sessionId, workstream) {
    if (!this.copilot) throw new Error('Bridge unavailable');
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/.test(sessionId)) throw new Error('会话标识不正确');
    if (workstream !== null && !OBSERVED_WORKSTREAMS.includes(workstream)) throw new Error('工作分类不正确');
    if (!this.copilot.snapshot().some(task => task.sessionId === sessionId)) throw new Error('真实会话不存在');
    if (workstream === null) this.classificationOverrides.delete(sessionId);
    else {
      if (!this.classificationOverrides.has(sessionId) && this.classificationOverrides.size >= 100) {
        const oldest = [...this.classificationOverrides.entries()]
          .sort((left, right) => Date.parse(left[1].updatedAt) - Date.parse(right[1].updatedAt))[0][0];
        this.classificationOverrides.delete(oldest);
      }
      this.classificationOverrides.set(sessionId, { workstream, updatedAt: this.now() });
    }
    this.copilot.setSessionWorkstream(sessionId, workstream);
  }

  record(task, message) {
    this.events.unshift({ id: randomUUID(), taskId: task.id, title: task.title, source: task.source, status: task.status, message, at: this.now(), ...(task.lastHook ? { hook: task.lastHook, tool: task.lastTool, eventAt: task.eventAt } : {}) });
    this.events = this.events.slice(0, MAX_EVENTS);
  }

  create(input) {
    if (this.tasks.filter(task => task.source === 'manual').length >= 100) throw new Error('手动任务上限为 100');
    const task = { ...validate(input), id: randomUUID(), source: 'manual', createdAt: this.now(), updatedAt: this.now() };
    this.tasks.push(task);
    this.record(task, `手动上报 · ${STATUS_LABELS[task.status]}`);
    return structuredClone(task);
  }

  update(id, input) {
    const task = this.tasks.find(item => item.id === id && item.source === 'manual');
    if (!task) throw new Error('手动任务不存在');
    Object.assign(task, validate(input), { updatedAt: this.now() });
    this.record(task, `手动更新 · ${STATUS_LABELS[task.status]}`);
    return structuredClone(task);
  }

  remove(id) {
    const task = this.tasks.find(item => item.id === id && item.source === 'manual');
    if (!task) throw new Error('手动任务不存在');
    this.tasks = this.tasks.filter(item => item.id !== id);
    this.record(task, '手动移除任务');
  }

  demo(action) {
    if (!['start', 'pause', 'step', 'reset', 'clear'].includes(action)) throw new Error('不支持的演示操作');
    if (action === 'reset' || action === 'clear') {
      this.running = false;
      this.tasks = this.tasks.filter(task => task.source !== 'simulated');
      this.events = this.events.filter(event => event.source !== 'simulated');
      this.tickCount = 0;
    }
    if (action === 'clear') return;
    if (action !== 'pause' && !this.tasks.some(task => task.source === 'simulated')) this.seed();
    if (action === 'start') this.running = true;
    if (action === 'pause') this.running = false;
    if (action === 'step') this.advance();
  }

  seed() {
    const fixtures = [
      ['demo-analysis', '数据分析员', '测试样件 · 波纹数据检查', 'engineering', ['读取测试数据', '检查异常点', '验证分析结论'], 'in_progress', 1, '正在核对测试数据中的异常点。'],
      ['demo-report', '报告编辑', '示例周报 · 工作摘要', 'reports', ['整理测试条目', '形成英文草稿', '内容审核'], 'waiting_review', 2, '示例草稿已形成，等待 Chi 审核措辞；未发布。'],
      ['demo-knowledge', '知识整理员', '演示笔记 · 结论归类', 'knowledge', ['提取结论', '归类与去重', '检查来源'], 'waiting_input', 1, '等待选择归档分类；不会写入 Obsidian。'],
      ['demo-build', '自动化助手', '样例脚本 · 校验流程', 'automation', ['准备样例', '运行检查', '复核输出'], 'blocked', 1, '模拟缺少输入字段。需要检查样例格式后重试。'],
    ];
    for (const [id, agent, title, workstream, milestones, status, doneCount, note] of fixtures) {
      const task = { id, agent, title, workstream, milestones, status, doneCount, note, source: 'simulated', createdAt: this.now(), updatedAt: this.now() };
      this.tasks.push(task);
      this.record(task, `载入演示 · ${STATUS_LABELS[status]}`);
    }
  }

  advance() {
    const task = this.tasks.find(item => item.id === 'demo-analysis');
    if (!task) return;
    this.tickCount += 1;
    const steps = [
      ['in_progress', 1, '模拟：对比两个测试样件的异常点。'],
      ['in_progress', 2, '模拟：异常点检查完成，正在验证分析结论。'],
      ['completed', 3, '模拟：三个阶段均已完成；这是演示结果，不是真实工程结论。'],
      ['queued', 0, '模拟：下一轮测试数据已进入队列。'],
      ['in_progress', 0, '模拟：开始读取下一轮测试数据。'],
    ];
    const [status, doneCount, note] = steps[(this.tickCount - 1) % steps.length];
    Object.assign(task, { status, doneCount, note, updatedAt: this.now() });
    this.record(task, note);
  }

  snapshot() {
    const tasks = this.tasks.map(task => ({ ...task, freshness: task.source === 'manual' ? 'self_reported' : 'simulated', needsAttention: ATTENTION.has(task.status) }));
    const observed = this.copilot?.snapshot() ?? [];
    const realConnections = observed.filter(task => task.source === 'observed' && !task.parentId && !task.stale).length;
    const bridge = this.copilot ? { ready: true, alias: this.copilot.alias, scope: this.copilot.scope, privacy: 'metadata-only', testMode: this.copilot.testMode, lastReceivedAt: this.copilot.lastReceivedAt } : { ready: false };
    return structuredClone({ tasks: [...observed, ...tasks], events: this.events, demoRunning: this.running, realConnections, bridge, serverTime: this.now(), statusLabels: { ...STATUS_LABELS, turn_ended: '本轮执行结束', unknown: '状态未确认' }, workstreamLabels: WORKSTREAM_LABELS });
  }

  persistable() {
    return {
      version: 1,
      tasks: this.tasks.filter(task => task.source === 'manual' && this.clock() - Date.parse(task.updatedAt) <= RETENTION),
      classifications: [...this.classificationOverrides.entries()].map(([sessionId, value]) => ({ sessionId, ...value })),
    };
  }
}
