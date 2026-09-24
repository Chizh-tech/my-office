import test from 'node:test';
import assert from 'node:assert/strict';
import { fromHook, taskTitle, hookActivity, observedActivity, intervention } from '../public/activity.js';

const task = { source: 'observed', lastHook: 'PreToolUse', lastTool: 'Grep', status: 'in_progress', stale: false, parentId: null, requestExcerpt: '检查人物详情' };

test('observed goals never display request excerpts in metadata-only mode, including old server records', () => {
  assert.equal(taskTitle(task), '任务目标未采集（仅元数据）');
  assert.equal(taskTitle({ ...task, requestExcerpt: null, title: '会话 abc123' }), taskTitle(task));
  assert.equal(taskTitle({ ...task, parentId: 'parent', requestExcerpt: null }), taskTitle(task));
  for (const source of ['manual', 'simulated']) {
    assert.equal(fromHook({ source }), false);
    assert.equal(taskTitle({ source, title: '原来的任务' }), '原来的任务');
  }
  assert.equal(fromHook({ source: 'bridge_test' }), true);
});

test('tool names get factual, readable labels without guessing results or commands', () => {
  for (const tool of ['Grep', 'functions.rg', 'tools/glob']) assert.equal(hookActivity('PreToolUse', tool).label, '准备搜索项目内容');
  assert.equal(hookActivity('PostToolUse', 'Grep').label, '搜索工具已返回');
  assert.match(hookActivity('PreToolUse', 'ApplyPatch').detail, /是否获准/);
  assert.match(hookActivity('PostToolUse', 'runTests').detail, /不能据此确认/);
  assert.equal(hookActivity('PreToolUse', 'powershell').label, '准备运行命令');
  assert.equal(hookActivity('PreToolUse', 'unknown-tool').label, '准备调用工具');
  assert.equal(hookActivity('PostToolUse', null).label, '工具已返回');
  assert.equal(hookActivity('Unsupported').label, '暂无可解释的操作记录');
  assert.match(hookActivity('SubagentStart').detail, /独立身份/);
});

test('stale, ended and disconnected records never claim current activity or business completion', () => {
  assert.equal(observedActivity(task).label, '准备搜索项目内容');
  assert.match(observedActivity({ ...task, stale: true }).label, /状态未确认/);
  assert.match(observedActivity({ ...task, stale: true }, false).label, /连接中断/);
  const ended = { ...task, lastHook: 'Stop', lastTool: null, status: 'turn_ended' };
  assert.equal(observedActivity(ended).label, '本轮执行结束');
  assert.match(observedActivity(ended).detail, /不代表业务任务已完成/);
  assert.match(observedActivity({ ...ended, stale: true }).label, /已结束，记录已过期/);
  assert.match(intervention(task), /尚无法确认/);
  assert.match(intervention(task, false), /连接中断/);
  assert.match(intervention({ ...task, stale: true }), /记录已过期/);
  assert.match(intervention(ended), /建议回到原 Copilot 聊天检查结果/);
});
