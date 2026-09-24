import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_EVENTS, CopilotSessions, normalizeHook } from '../src/copilot-events.mjs';
import { sendHook } from '../src/bridge-hook.mjs';
import { startOffice } from '../src/server.mjs';
import { generateHookConfigs } from '../scripts/generate-hooks.mjs';
import { realObservationState, observationOrigin } from '../public/activity.js';

const root = process.cwd();
const other = join(root, 'another-parent', basename(root));
const raw = (cwd = root, changes = {}) => ({
  session_id: 'same-session', cwd, timestamp: new Date().toISOString(),
  prompt: 'PRIVATE_REQUEST', tool_input: 'PRIVATE_ARGS', tool_response: 'PRIVATE_RESULT',
  transcript_path: 'PRIVATE_TRANSCRIPT', ...changes,
});
const normalize = (cwd, provider = 'vscode-copilot', changes = {}) =>
  normalizeHook(raw(cwd, changes), 'PreToolUse', root, { scope: 'all-local', provider });

test('project and provider identity isolate same session IDs, including projects with the same basename', () => {
  const sessions = new CopilotSessions({ workspaceRoot: root, scope: 'all-local' });
  const events = [normalize(root), normalize(other), normalize(root, 'copilot-cli'), normalize(other, 'copilot-cli')];
  for (const event of events) {
    assert.ok(event);
    sessions.receive(event);
  }
  const tasks = sessions.snapshot();
  assert.equal(tasks.length, 4);
  assert.equal(new Set(tasks.map(task => task.id)).size, 4);
  assert.equal(new Set(tasks.map(task => task.workspaceId)).size, 2);
  assert.equal(new Set(tasks.map(task => task.workspaceName)).size, 1);
  assert.equal(new Set(tasks.map(task => task.provider)).size, 2);
  const before = tasks[0];
  const child = sessions.receive(normalizeHook(raw(root, { agent_id: 'child' }), 'SubagentStart', root));
  assert.equal(child.parentId, before.id);
  assert.equal(child.workspaceId, before.workspaceId);
  const privateText = JSON.stringify(tasks);
  for (const forbidden of ['PRIVATE_', 'same-session', root, other, 'requestExcerpt', 'transcript']) {
    assert.ok(!privateText.includes(forbidden), forbidden);
  }
  const scoped = new CopilotSessions({ workspaceRoot: root });
  assert.throws(() => scoped.receive(events[1]), /identity/);
});

test('local scope rejects relative paths, UNC paths, invalid providers and ambiguous identity fields', () => {
  for (const cwd of ['', 'relative-project', '..', '\\\\server\\share\\project', '//server/share/project', null]) {
    assert.equal(normalize(cwd), null, String(cwd));
  }
  assert.equal(normalize(root, 'unknown-provider'), null);
  assert.equal(normalize(root, 'vscode-copilot', { sessionId: 'conflicting-session' }), null);
  assert.equal(normalize(root, 'vscode-copilot', { timestamp: 1 }), null);
  assert.equal(normalize(root, 'copilot-cli', { timestamp: Number.MAX_SAFE_INTEGER }), null);
  assert.equal(normalizeHook(raw(other), 'Stop', root), null);
  assert.equal(normalizeHook(raw(), 'SessionEnd', root), null);
  assert.throws(() => new CopilotSessions({ workspaceRoot: root, scope: 'unlimited' }), /scope/);
});

test('CLI native event formats preserve metadata, never use a subagent name as its identity', () => {
  const sessions = new CopilotSessions({ workspaceRoot: root, scope: 'all-local' });
  let timestamp = Date.now() - 1000;
  for (const [name, canonical] of Object.entries(CLI_EVENTS)) {
    const event = normalizeHook({
      sessionId: 'native-cli-session', timestamp: timestamp++, cwd: root, toolName: 'powershell',
      ...(name === 'subagentStop' ? { agentId: 'child' } : {}),
      agentName: 'PRIVATE_NAME', agentDescription: 'PRIVATE_DESCRIPTION',
      prompt: 'PRIVATE_PROMPT', initialPrompt: 'PRIVATE_PROMPT', toolArgs: 'PRIVATE_ARGS',
      toolResult: { textResultForLlm: 'PRIVATE_RESULT' }, response: 'PRIVATE_RESPONSE',
      error: { message: 'PRIVATE_ERROR' }, transcriptPath: 'PRIVATE_PATH',
    }, name, root, { provider: 'copilot-cli', scope: 'all-local' });
    assert.ok(event, name);
    assert.equal(event.event, canonical);
    assert.ok(!JSON.stringify(event).includes('PRIVATE_'));
    const task = sessions.receive(event);
    if (name === 'subagentStart') {
      assert.equal(task.parentId, null);
      assert.equal(sessions.snapshot().length, 1);
      assert.match(task.note, /缺少独立标识/);
    }
    if (name === 'subagentStop') assert.ok(task.parentId);
    if (name === 'sessionEnd') assert.equal(task.status, 'turn_ended');
    if (name === 'postToolUseFailure') {
      assert.equal(task.lastTool, 'powershell');
      assert.notEqual(task.status, 'failed');
    }
  }
  const compatible = normalizeHook(raw(root, { hook_event_name: 'PreToolUse', tool_name: 'Read' }), 'PreToolUse', root, { provider: 'copilot-cli' });
  assert.equal(compatible.tool, 'Read');
});

test('v2 allowlist rejects prompt excerpts, paths, spoofed scope and unknown provider fields', () => {
  const sessions = new CopilotSessions({ workspaceRoot: root, scope: 'all-local' });
  const event = normalize(root);
  for (const extra of [
    { requestExcerpt: null }, { prompt: 'PRIVATE' }, { cwd: root }, { transcriptPath: root },
    { scope: 'all-local' }, { version: 1 }, { provider: 'unknown' },
    { workspaceId: 'bad' }, { workspaceName: '../PRIVATE' }, { workspaceName: '' },
    { event: 'toString' },
  ]) assert.throws(() => sessions.receive({ ...event, ...extra }));
});

test('old running descriptor still receives metadata-only v1 and preserves existing VS Code identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-legacy-'));
  let received;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.end('{}');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const descriptor = join(directory, 'bridge.json');
    await writeFile(descriptor, JSON.stringify({
      version: 1, origin: `http://127.0.0.1:${server.address().port}`,
      token: randomBytes(32).toString('hex'), workspaceRoot: root,
    }));
    assert.equal(await sendHook(raw(), 'UserPromptSubmit', descriptor), true);
    assert.deepEqual(Object.keys(received).sort(), ['version', 'workspaceId', 'sessionId', 'agentId', 'event', 'at', 'tool', 'eventId'].sort());
    assert.equal(received.version, 1);
    assert.ok(!JSON.stringify(received).includes('PRIVATE_'));
    const digest = value => createHash('sha256').update(value).digest('hex');
    const path = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
    assert.equal(received.sessionId, digest(`${digest(path)}:same-session`));
    assert.equal(normalize(root).sessionId, received.sessionId);
    assert.equal(await sendHook(raw(other), 'PreToolUse', descriptor), false);
    assert.equal(await sendHook(raw(), 'PreToolUse', descriptor, 'copilot-cli'), false);
  } finally {
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('isolated v2 receiver ingests multiple projects and clients through the actual sender without persisting observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-multi-'));
  const bridgeFile = join(directory, 'bridge.json');
  let app;
  try {
    app = await startOffice({ port: 0, dataFile: null, bridgeFile, demo: false, workspaceRoot: root, bridgeScope: 'all-local' });
    const descriptor = JSON.parse(await readFile(bridgeFile, 'utf8'));
    assert.equal(descriptor.version, 2);
    assert.equal(descriptor.scope, 'all-local');
    assert.equal(descriptor.privacy, 'metadata-only');
    for (const cwd of [root, other]) {
      assert.equal(await sendHook(raw(cwd), 'UserPromptSubmit', bridgeFile), true);
      assert.equal(await sendHook({
        cwd, sessionId: 'same-session', timestamp: Date.now(), toolName: 'view', prompt: 'PRIVATE',
      }, 'preToolUse', bridgeFile, 'copilot-cli'), true);
    }
    const snapshot = await (await fetch(`${app.origin}/api/state`)).json();
    assert.equal(snapshot.tasks.length, 4);
    assert.equal(snapshot.realConnections, 4);
    assert.equal(snapshot.events.length, 4);
    assert.equal(snapshot.bridge.scope, 'all-local');
    assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
    assert.ok(!JSON.stringify(snapshot).includes(descriptor.token));
    assert.deepEqual(app.store.persistable(), { version: 1, tasks: [], classifications: [] });
    assert.equal(realObservationState(snapshot).tasks.length, 4);
    const chosen = snapshot.tasks[0];
    app.store.setObservedWorkstream(chosen.sessionId, 'engineering');
    assert.deepEqual(app.store.snapshot().tasks.map(task => task.workstream), ['engineering', 'automation', 'automation', 'automation']);
    assert.equal(app.store.persistable().classifications.length, 1);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('staged CLI template names the provider explicitly and never changes cwd or agent behavior', async () => {
  const config = JSON.parse(await readFile(new URL('../hooks/copilot-cli.hooks.example.json', import.meta.url), 'utf8'));
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.hooks), Object.keys(CLI_EVENTS));
  for (const [event, [hook]] of Object.entries(config.hooks)) {
    assert.equal(hook.exec, 'node');
    assert.equal(hook.args[0], '__MY_OFFICE_BRIDGE__');
    assert.deepEqual(hook.args.slice(1), [event, 'copilot-cli']);
    assert.equal(hook.cwd, undefined);
    assert.equal(hook.timeoutSec, 2);
  }
});

test('hook generator resolves the current installation path without changing hook behavior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-hooks-'));
  try {
    const outputs = await generateHookConfigs(directory);
    assert.equal(outputs.length, 2);
    const [vscode, cli] = await Promise.all(outputs.map(output => readFile(output, 'utf8')));
    const expectedPath = fileURLToPath(new URL('../src/bridge-hook.mjs', import.meta.url)).replaceAll('\\', '/');
    assert.ok(vscode.includes(`node \\"${expectedPath}\\"`));
    assert.ok(cli.includes(expectedPath));
    assert.ok(!vscode.includes('__MY_OFFICE_BRIDGE__'));
    assert.ok(!cli.includes('__MY_OFFICE_BRIDGE__'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('UI hides old-server prompt titles everywhere while exposing safe project and client identity', () => {
  const input = {
    tasks: [{ source: 'observed', id: 'old', provider: 'copilot-cli', workspaceName: 'Project A',
      title: 'PRIVATE_REQUEST', requestExcerpt: 'PRIVATE_REQUEST', requestAt: 'old-time' }],
    events: [{ source: 'observed', taskId: 'old', title: 'PRIVATE_REQUEST', message: 'PRIVATE_REQUEST', hook: 'UserPromptSubmit' }],
  };
  const projected = realObservationState(input);
  assert.ok(!JSON.stringify(projected).includes('PRIVATE'));
  assert.ok(!JSON.stringify(projected).includes('requestExcerpt'));
  assert.equal(projected.tasks[0].title, 'Copilot CLI · Project A');
  assert.equal(projected.events[0].title, projected.tasks[0].title);
  assert.equal(observationOrigin({ provider: 'vscode-copilot', workspaceName: 'Project B' }), 'VS Code · Project B');
  assert.equal(input.tasks[0].requestExcerpt, 'PRIVATE_REQUEST');
});
