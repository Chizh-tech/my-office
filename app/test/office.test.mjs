import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficeStore } from '../src/store.mjs';
import { startOffice } from '../src/server.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { CopilotSessions, normalizeHook, recommendWorkstream, STALE_MS, HOOK_EVENTS } from '../src/copilot-events.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runHook(eventName, input, descriptorFile, provider = 'vscode-copilot') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bridge-hook.mjs', import.meta.url)), eventName, provider], { env: { ...process.env, MY_OFFICE_BRIDGE_FILE: descriptorFile } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const workspaceRoot = process.cwd();
const hookInput = (event, changes = {}) => ({ hook_event_name: event, session_id: 'private-session', cwd: workspaceRoot, timestamp: '2026-09-20T00:00:00.000Z', ...changes });

test('staged hooks cover only supported lifecycle events and use the neutral bridge script', async () => {
  const config = JSON.parse(await readFile(new URL('../hooks/my-office.hooks.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.hooks), HOOK_EVENTS);
  for (const [event, commands] of Object.entries(config.hooks)) {
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, 'command');
    assert.equal(commands[0].timeout, 2);
    assert.equal(commands[0].command, `node "__MY_OFFICE_BRIDGE__" ${event}`);
  }
});

test('hook privacy boundary discards prompts, responses, paths and raw identities', () => {
  const raw = hookInput('PreToolUse', { tool_name: 'read_file', tool_use_id: 'private-tool', prompt: 'PRIVATE', tool_input: { secret: 'PRIVATE' }, tool_response: 'PRIVATE', transcript_path: 'PRIVATE' });
  const normalized = normalizeHook(raw, 'PreToolUse', workspaceRoot);
  assert.ok(normalized);
  assert.equal(normalized.tool, 'read_file');
  for (const forbidden of ['PRIVATE', 'private-session', 'private-tool', 'transcript', 'prompt', 'tool_input', 'cwd']) assert.ok(!JSON.stringify(normalized).includes(forbidden));
  assert.equal(normalizeHook(hookInput('Stop', { session_id: null }), 'Stop', workspaceRoot), null);
  assert.equal(normalizeHook(hookInput('Stop', { cwd: join(workspaceRoot, 'other') }), 'Stop', workspaceRoot), null);
  assert.equal(normalizeHook(hookInput('Stop'), 'PreToolUse', workspaceRoot), null);
  assert.equal(normalizeHook(hookInput('Stop', { timestamp: 'unknown' }), 'Stop', workspaceRoot), null);
});

test('workstream recommendations use prompt content locally without retaining the prompt', () => {
  assert.equal(recommendWorkstream('生成本周周报和下周计划'), 'reports');
  assert.equal(recommendWorkstream('分析 CT300 waviness 和 CPK'), 'engineering');
  assert.equal(recommendWorkstream('把会议纪要沉淀到 Obsidian'), 'knowledge');
  assert.equal(recommendWorkstream('修复脚本并运行测试'), 'automation');
  assert.equal(recommendWorkstream('普通请求'), 'automation');
  const raw = hookInput('UserPromptSubmit', { prompt: '生成月报 PRIVATE' });
  const normalized = normalizeHook(raw, 'UserPromptSubmit', workspaceRoot);
  assert.equal(normalized.recommendedWorkstream, 'reports');
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
});

test('manual workstream selection overrides recommendations for the session and its children', () => {
  let now = Date.parse('2026-09-20T00:00:02Z');
  const store = new OfficeStore(null, () => now, { workspaceRoot });
  const push = (event, changes = {}) => {
    now += 1000;
    store.observe(normalizeHook(hookInput(event, { ...changes, timestamp: new Date(now).toISOString() }), event, workspaceRoot));
    return store.snapshot().tasks;
  };
  const main = push('UserPromptSubmit', { prompt: '生成本周周报' })[0];
  assert.equal(main.workstream, 'reports');
  assert.equal(main.workstreamSource, 'recommended');
  store.setObservedWorkstream(main.sessionId, 'engineering');
  assert.equal(store.snapshot().tasks[0].workstream, 'engineering');
  assert.equal(store.snapshot().tasks[0].workstreamSource, 'manual');
  const child = push('SubagentStart', { agent_id: 'classification-child' })[1];
  assert.equal(child.workstream, 'engineering');
  push('UserPromptSubmit', { prompt: '整理知识笔记' });
  assert.equal(store.snapshot().tasks[0].workstream, 'engineering');
  assert.equal(store.snapshot().tasks[0].workstreamRecommendation, 'knowledge');
  const persisted = store.persistable();
  const reloaded = new OfficeStore(persisted, () => now, { workspaceRoot });
  now += 1000;
  reloaded.observe(normalizeHook(hookInput('UserPromptSubmit', {
    prompt: '生成月报',
    timestamp: new Date(now).toISOString(),
  }), 'UserPromptSubmit', workspaceRoot));
  assert.equal(reloaded.snapshot().tasks[0].workstream, 'engineering');
  assert.equal(reloaded.snapshot().tasks[0].workstreamSource, 'manual');
  store.setObservedWorkstream(main.sessionId, null);
  assert.equal(store.snapshot().tasks[0].workstream, 'knowledge');
  assert.equal(store.snapshot().tasks[1].workstreamSource, 'recommended');
  const saved = store.persistable();
  assert.deepEqual(saved.classifications, []);
});

test('observations isolate child sessions, deduplicate, reject older state and never imply completion', () => {
  let now = Date.parse('2026-09-20T00:00:02Z');
  const sessions = new CopilotSessions({ workspaceRoot }, () => now);
  const push = (event, changes) => sessions.receive(normalizeHook(hookInput(event, changes), event, workspaceRoot));
  push('UserPromptSubmit');
  push('SubagentStart', { agent_id: 'private-child' });
  assert.equal(sessions.snapshot().length, 2);
  const stopped = normalizeHook(hookInput('Stop', { timestamp: '2026-09-20T00:00:01Z' }), 'Stop', workspaceRoot);
  sessions.receive(stopped);
  assert.equal(sessions.receive(stopped), null);
  assert.equal(push('PreToolUse'), null);
  assert.equal(sessions.snapshot()[0].status, 'turn_ended');
  assert.equal(sessions.snapshot()[1].status, 'in_progress');
  now += STALE_MS + 1;
  assert.equal(sessions.snapshot()[0].status, 'turn_ended');
  assert.equal(sessions.snapshot()[1].status, 'unknown');
  assert.equal(sessions.snapshot()[1].freshness, 'stale');
  push('PostToolUse', { agent_id: 'private-child', timestamp: new Date(now).toISOString() });
  assert.equal(sessions.snapshot()[1].status, 'in_progress');
  assert.ok(sessions.snapshot().every(task => task.status !== 'completed' && task.milestones.length === 0));
  assert.throws(() => sessions.receive({ ...stopped, prompt: 'forbidden' }));
  assert.throws(() => sessions.receive({ ...stopped, at: new Date(now + 120000).toISOString() }));
});

test('distinct events with the same timestamp are accepted in arrival order', () => {
  const now = Date.parse('2026-09-20T00:00:02Z');
  const sessions = new CopilotSessions({ workspaceRoot }, () => now);
  const timestamp = new Date(now).toISOString();
  const first = normalizeHook(hookInput('PreToolUse', {
    timestamp, tool_name: 'view', tool_use_id: 'first-tool',
  }), 'PreToolUse', workspaceRoot);
  const second = normalizeHook(hookInput('PreToolUse', {
    timestamp, tool_name: 'rg', tool_use_id: 'second-tool',
  }), 'PreToolUse', workspaceRoot);
  assert.equal(sessions.receive(first).lastTool, 'view');
  assert.equal(sessions.receive(second).lastTool, 'rg');
  assert.equal(sessions.snapshot()[0].lastTool, 'rg');
  assert.equal(sessions.receive(second), null);
});

test('stale observations make room for new sessions at the instance limit', () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const sessions = new CopilotSessions({ workspaceRoot }, () => now);
  for (let index = 0; index < 100; index++) {
    const event = normalizeHook(hookInput('SessionStart', {
      session_id: `capacity-session-${index}`,
      timestamp: new Date(now).toISOString(),
    }), 'SessionStart', workspaceRoot);
    sessions.receive(event);
  }
  const firstId = sessions.snapshot()[0].id;
  now += STALE_MS + 1;
  const replacement = sessions.receive(normalizeHook(hookInput('SessionStart', {
    session_id: 'capacity-replacement',
    timestamp: new Date(now).toISOString(),
  }), 'SessionStart', workspaceRoot));
  const snapshot = sessions.snapshot();
  assert.equal(snapshot.length, 100);
  assert.ok(replacement);
  assert.ok(snapshot.some(task => task.id === replacement.id));
  assert.ok(!snapshot.some(task => task.id === firstId));
});

test('every hook including prompt submission discards request, response and transcript content', () => {
  for (const event of HOOK_EVENTS) {
    const normalized = normalizeHook(hookInput(event, {
      ...(event.startsWith('Subagent') ? { agent_id: 'child' } : {}),
      prompt: 'PRIVATE', tool_input: 'PRIVATE', tool_response: 'PRIVATE', transcript_path: 'PRIVATE',
    }), event, workspaceRoot);
    assert.ok(normalized);
    assert.ok(!Object.hasOwn(normalized, 'requestExcerpt'));
    assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
  }
});

test('metadata-only receiver rejects excerpts and unknown payload fields', () => {
  const sessions = new CopilotSessions({ workspaceRoot }, () => Date.parse('2026-09-20T00:00:02Z'));
  const event = normalizeHook(hookInput('UserPromptSubmit', { prompt: '检查人物详情' }), 'UserPromptSubmit', workspaceRoot);
  for (const value of [null, '', 'x', {}, ['text'], 5]) {
    assert.throws(() => sessions.receive({ ...event, requestExcerpt: value }));
  }
  assert.throws(() => sessions.receive({ ...event, prompt: 'PRIVATE' }));
  assert.equal(sessions.receive(event).privacy, 'metadata-only');
});

test('requests update metadata without storing goals; child identity and ephemeral history stay isolated', () => {
  let now = Date.parse('2026-09-20T00:00:00Z');
  const store = new OfficeStore(null, () => now, { workspaceRoot });
  const push = (event, changes = {}) => {
    now += 1000;
    store.observe(normalizeHook(hookInput(event, { ...changes, timestamp: new Date(now).toISOString() }), event, workspaceRoot));
    return store.snapshot().tasks;
  };
  const first = push('UserPromptSubmit', { prompt: '让每个 Copilot 的任务更清楚' })[0];
  assert.match(first.title, /VS Code/);
  assert.equal(first.requestExcerpt, undefined);
  const tools = push('PreToolUse', { tool_name: 'Grep' })[0];
  assert.equal(tools.title, first.title);
  assert.equal(tools.requestAt, undefined);
  assert.equal(tools.lastTool, 'Grep');
  const child = push('SubagentStart', { agent_id: 'child-one' })[1];
  const sibling = push('SubagentStart', { agent_id: 'child-two' })[2];
  assert.equal(child.parentId, first.id);
  assert.equal(child.requestExcerpt, undefined);
  assert.notEqual(child.title, sibling.title);
  push('PostToolUse', { agent_id: 'child-one', tool_name: 'Read' });
  const stopped = push('Stop')[0];
  assert.equal(stopped.requestExcerpt, undefined);
  assert.equal(stopped.lastTool, null);
  assert.equal(stopped.status, 'turn_ended');
  assert.equal(push('UserPromptSubmit', { prompt: '检查回归测试' })[0].title, first.title);
  const missing = push('UserPromptSubmit')[0];
  assert.equal(missing.requestExcerpt, undefined);
  assert.notEqual(missing.title, '检查回归测试');
  assert.equal(missing.requestAt, undefined);
  assert.ok(!JSON.stringify(store.snapshot()).includes('检查回归测试'));
  const events = store.snapshot().events;
  assert.equal(events.find(event => event.tool === 'Grep').hook, 'PreToolUse');
  assert.equal(events.find(event => event.tool === 'Read').taskId, child.id);
  assert.equal(events[0].eventAt, new Date(now).toISOString());
  assert.deepEqual(store.persistable(), { version: 1, tasks: [], classifications: [] });
  assert.equal(new OfficeStore(store.persistable(), () => now, { workspaceRoot }).snapshot().tasks.length, 0);
});

const draft = overrides => ({ title: 'Test task', agent: 'Test agent', workstream: 'engineering', status: 'in_progress', note: '', milestones: ['Read', 'Check'], doneCount: 0, ...overrides });

test('demo steps never resolve waiting or blocked tasks', () => {
  const store = new OfficeStore();
  store.demo('reset');
  const waiting = store.snapshot().tasks.filter(task => task.needsAttention);
  for (let index = 0; index < 12; index++) store.demo('step');
  assert.deepEqual(store.snapshot().tasks.filter(task => task.needsAttention), waiting);
  assert.equal(store.snapshot().realConnections, 0);
});

test('manual tasks are independent from demo reset and clear', () => {
  const store = new OfficeStore();
  const created = store.create(draft());
  store.demo('reset');
  store.demo('step');
  store.demo('clear');
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0].id, created.id);
  assert.equal(store.snapshot().tasks[0].freshness, 'self_reported');
  assert.equal(store.snapshot().events.length, 1);
});

test('validate source, identity, completion and waiting reason', () => {
  const store = new OfficeStore();
  for (const input of [draft({ source: 'observed' }), draft({ status: 'completed' }), draft({ status: 'blocked' }), draft({ doneCount: -1 }), draft({ milestones: [''] })]) {
    assert.throws(() => store.create(input));
  }
  store.demo('reset');
  assert.throws(() => store.update('demo-analysis', draft()));
  assert.throws(() => store.demo('approve'));
  assert.equal(store.create(draft({ status: 'completed', doneCount: 2 })).status, 'completed');
});

test('matching display names do not merge task identity; snapshots cannot mutate store', () => {
  const store = new OfficeStore();
  const first = store.create(draft());
  const second = store.create(draft());
  assert.notEqual(first.id, second.id);
  store.snapshot().tasks[0].milestones.push('Foreign');
  assert.equal(store.snapshot().tasks[0].milestones.length, 2);
  store.update(first.id, draft({ status: 'waiting_review', note: 'Review content only' }));
  assert.equal(store.snapshot().tasks[1].status, 'in_progress');
});

test('only recent manual tasks persist; reloaded status is self-reported', () => {
  let now = Date.parse('2026-09-18T00:00:00Z');
  const store = new OfficeStore(null, () => now);
  store.create(draft());
  store.demo('reset');
  const saved = store.persistable();
  assert.equal(saved.tasks.length, 1);
  const reloaded = new OfficeStore(saved, () => now);
  assert.equal(reloaded.snapshot().tasks[0].freshness, 'self_reported');
  now += 8 * 24 * 60 * 60 * 1000;
  assert.equal(new OfficeStore(saved, () => now).snapshot().tasks.length, 0);
  assert.throws(() => new OfficeStore({ version: 9, tasks: [] }));
});

test('timeline remains bounded', () => {
  const store = new OfficeStore();
  store.demo('start');
  for (let index = 0; index < 350; index++) store.advance();
  assert.equal(store.snapshot().events.length, 300);
  store.demo('pause');
  assert.equal(store.snapshot().demoRunning, false);
});

test('HTTP: local-only, authenticated writes, persistence, restart and rejected requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-test-'));
  const dataFile = join(directory, 'tasks.json');
  let app;
  try {
    app = await startOffice({ port: 0, dataFile });
    assert.equal(app.server.address().address, '127.0.0.1');
    const activityModule = await fetch(`${app.origin}/activity.js`);
    assert.equal(activityModule.status, 200);
    assert.match(activityModule.headers.get('content-type'), /javascript/);
    const browserSession = await (await fetch(`${app.origin}/api/session`)).json();
    const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.equal(browserSession.version, packageVersion);
    const { token } = browserSession;
    const headers = { Origin: app.origin, 'X-Office-Token': token, 'Content-Type': 'application/json' };
    const post = (path, value, extra = {}) => fetch(`${app.origin}${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    assert.equal((await post('/api/tasks', draft(), { 'X-Office-Token': 'invalid' })).status, 403);
    assert.equal((await post('/api/tasks', draft(), { 'X-Office-Token': '\u00e9'.repeat(64) })).status, 403);
    assert.equal((await post('/api/tasks', draft(), { Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await post('/api/tasks', draft({ note: 'x'.repeat(20000) }))).status, 413);
    assert.equal((await post('/api/tasks', draft({ source: 'observed' }))).status, 400);
    assert.equal((await post('/api/tasks', draft())).status, 200);
    const disk = JSON.parse(await readFile(dataFile, 'utf8'));
    assert.equal(disk.tasks.length, 1);
    assert.equal(disk.tasks[0].source, 'manual');
    assert.equal((await post('/api/demo', { action: 'reset' })).status, 200);
    assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).tasks.length, 1);
    assert.equal((await fetch(`${app.origin}/.local/tasks.json`)).status, 404);
    assert.equal((await fetch(`${app.origin}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${app.origin}/api/session`, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await (await fetch(`${app.origin}/api/health`)).json()).version, packageVersion);
    const badHost = await new Promise(resolveResult => {
      http.get(`${app.origin}/api/state`, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolveResult(response.statusCode); });
    });
    assert.equal(badHost, 403);
    const eventResponse = await fetch(`${app.origin}/api/events`);
    const reader = eventResponse.body.getReader();
    const firstEvent = new TextDecoder().decode((await reader.read()).value);
    assert.ok(firstEvent.startsWith('data: '));
    await reader.cancel();
    await app.close();
    app = await startOffice({ port: 0, dataFile, demo: false });
    assert.equal(app.store.snapshot().tasks.length, 1);
    assert.equal(app.store.snapshot().tasks[0].freshness, 'self_reported');
    const restartedSession = await (await fetch(`${app.origin}/api/session`)).json();
    const removal = await fetch(`${app.origin}/api/tasks/${disk.tasks[0].id}`, { method: 'DELETE', headers: { Origin: app.origin, 'X-Office-Token': restartedSession.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(removal.status, 200);
    assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).tasks.length, 0);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('busy port falls forward without replacing the existing listener', async () => {
  const first = await startOffice({ port: 0, dataFile: null });
  let second;
  try {
    second = await startOffice({ port: first.server.address().port, fallback: true, dataFile: null });
    assert.notEqual(first.origin, second.origin);
    assert.equal((await fetch(`${first.origin}/api/health`)).status, 200);
  } finally {
    if (second) await second.close();
    await first.close();
  }
});

test('SSE keeps large context snapshots connected when writes need draining', async () => {
  const app = await startOffice({ port: 0, dataFile: null, demo: false });
  let reader;
  try {
    for (let index = 0; index < 50; index++) app.store.create(draft({ title: `任务 ${index}`, note: '详情'.repeat(250) }));
    assert.ok(Buffer.byteLength(JSON.stringify(app.store.snapshot())) > 65536);
    const { token } = await (await fetch(`${app.origin}/api/session`)).json();
    const response = await fetch(`${app.origin}/api/events`, { signal: AbortSignal.timeout(10000) });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (let index = 0; index < 3; index++) {
      if (index) {
        const update = await fetch(`${app.origin}/api/demo`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Office-Token': token }, body: JSON.stringify({ action: 'step' }) });
        assert.equal(update.status, 200);
      }
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE must remain connected after a large snapshot');
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffered.indexOf('\n\n');
      const snapshot = JSON.parse(buffered.slice(6, end));
      buffered = buffered.slice(end + 2);
      assert.equal(snapshot.tasks.filter(task => task.source === 'manual').length, 50);
      if (index) assert.equal(snapshot.events[0].message, index === 1 ? '模拟：对比两个测试样件的异常点。' : '模拟：异常点检查完成，正在验证分析结论。');
    }
  } finally {
    if (reader) await reader.cancel();
    await app.close();
  }
});

test('bridge script end-to-end: restricted token, sanitized delivery, ephemeral observations and neutral failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-bridge-'));
  const dataFile = join(directory, 'tasks.json');
  const bridgeFile = join(directory, 'bridge.json');
  let app;
  try {
    app = await startOffice({ port: 0, dataFile, workspaceRoot, demo: false, bridgeTestMode: true });
    const descriptor = JSON.parse(await readFile(bridgeFile, 'utf8'));
    const browserSession = await (await fetch(`${app.origin}/api/session`)).json();
    assert.notEqual(browserSession.token, descriptor.token);
    assert.ok(!JSON.stringify(browserSession).includes(descriptor.token));
    const event = normalizeHook(hookInput('PreToolUse', { timestamp: new Date().toISOString(), tool_name: 'read_file' }), 'PreToolUse', workspaceRoot);
    const send = (value, token, extra = {}) => fetch(`${app.origin}/api/bridge/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-Bridge-Token': token, ...extra }, body: JSON.stringify(value) });
    assert.equal((await send(event, browserSession.token)).status, 403);
    assert.equal((await send(event, descriptor.token, { Origin: app.origin })).status, 403);
    assert.equal((await send({ ...event, prompt: 'SECRET' }, descriptor.token)).status, 400);
    assert.equal((await fetch(`${app.origin}/api/shutdown`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-Office-Token': descriptor.token }, body: '{}' })).status, 403);
    const raw = hookInput('PreToolUse', { timestamp: new Date().toISOString(), prompt: 'SECRET', tool_input: { value: 'SECRET' }, tool_response: 'SECRET', transcript_path: 'SECRET', tool_name: 'read_file' });
    assert.deepEqual(await runHook('PreToolUse', raw, bridgeFile), { code: 0, stdout: '{}\n', stderr: '' });
    assert.equal(app.store.snapshot().tasks.length, 1);
    assert.equal(app.store.snapshot().tasks[0].source, 'bridge_test');
    assert.equal(app.store.snapshot().realConnections, 0);
    assert.ok(!JSON.stringify(app.store.snapshot()).includes('SECRET'));
    assert.equal(app.store.persistable().tasks.length, 0);
    assert.deepEqual(await runHook('UserPromptSubmit', hookInput('UserPromptSubmit', { timestamp: new Date().toISOString(), prompt: '本机人物任务详情回归检查', tool_response: 'SECRET' }), bridgeFile), { code: 0, stdout: '{}\n', stderr: '' });
    const contextState = await (await fetch(`${app.origin}/api/state`)).json();
    assert.equal(contextState.tasks[0].requestExcerpt, undefined);
    assert.equal(contextState.tasks[0].privacy, 'metadata-only');
    assert.ok(!JSON.stringify(contextState).includes('本机人物任务详情回归检查'));
    assert.ok(!JSON.stringify(contextState).includes('SECRET'));
    assert.equal(app.store.persistable().tasks.length, 0);
    assert.deepEqual(await runHook('postToolUse', {
      cwd: workspaceRoot, sessionId: 'private-session', timestamp: Date.now(),
      toolName: 'view', toolResult: { textResultForLlm: 'SECRET' },
    }, bridgeFile, 'copilot-cli'), { code: 0, stdout: '{}\n', stderr: '' });
    assert.equal(app.store.snapshot().tasks.length, 2);
    assert.equal(app.store.snapshot().tasks[1].provider, 'copilot-cli');
    assert.ok(!JSON.stringify(app.store.snapshot()).includes('SECRET'));
    assert.deepEqual(await runHook('Stop', '{bad json', bridgeFile), { code: 0, stdout: '{}\n', stderr: '' });
    assert.deepEqual(await runHook('Stop', 'x'.repeat(1024 * 1024 + 1), bridgeFile), { code: 0, stdout: '{}\n', stderr: '' });
    assert.equal((await fetch(`${app.origin}/.local/bridge.json`)).status, 404);
    await app.close();
    await assert.rejects(readFile(bridgeFile), { code: 'ENOENT' });
    assert.deepEqual(await runHook('Stop', raw, bridgeFile), { code: 0, stdout: '{}\n', stderr: '' });
    app = await startOffice({ port: 0, dataFile, workspaceRoot, demo: false });
    assert.equal(app.store.snapshot().tasks.length, 0);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
