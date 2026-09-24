import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import childProcess from 'node:child_process';
import { launchOffice } from '../src/server.mjs';
import { openOffice } from '../src/launcher.mjs';

test('repeated launch reuses the verified instance without changing ownership or observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-reuse-'));
  const bridgeFile = join(directory, 'bridge.json');
  let first;
  let second;
  try {
    first = await launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
    assert.equal(first.reused, false);
    const descriptor = await readFile(bridgeFile, 'utf8');
    const before = first.store.snapshot();
    second = await launchOffice({ port: first.server.address().port, fallback: true, dataFile: null, bridgeFile, demo: false });
    assert.deepEqual(second, { origin: first.origin, reused: true });
    assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
    assert.deepEqual(first.store.snapshot().tasks, before.tasks);
    assert.deepEqual(first.store.snapshot().events, before.events);
    assert.equal((await fetch(`${first.origin}/api/health`)).status, 200);
  } finally {
    if (second?.close) await second.close();
    if (first) await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated launch refuses a live server when the saved token no longer matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-wrong-token-'));
  const bridgeFile = join(directory, 'bridge.json');
  let first;
  let second;
  try {
    first = await launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
    const original = await readFile(bridgeFile, 'utf8');
    const altered = JSON.stringify({ ...JSON.parse(original), token: 'a'.repeat(64) });
    await writeFile(bridgeFile, altered);
    await assert.rejects(async () => {
      second = await launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
    }, /bridge ownership verification failed \(HTTP 403\)/);
    assert.equal(await readFile(bridgeFile, 'utf8'), altered);
    assert.equal((await fetch(`${first.origin}/api/health`)).status, 200);
    await writeFile(bridgeFile, original);
  } finally {
    if (second?.close) await second.close();
    if (first) await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a health-like response or redirect from an unrelated listener is not reused', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-unrelated-'));
  const bridgeFile = join(directory, 'bridge.json');
  let status = 200;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(status, { 'Content-Type': 'application/json', Location: 'http://example.invalid' });
    response.end(JSON.stringify({ ok: true, version: '0.2.0', mode: 'local-preview', bridgeReady: true }));
  });
  let app;
  try {
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const descriptor = JSON.stringify({ version: 2, origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid, token: 'a'.repeat(64) });
    await writeFile(bridgeFile, descriptor);
    for (status of [200, 302]) {
      await assert.rejects(async () => {
        app = await launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
      }, /bridge ownership verification failed/);
      assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
    }
    assert.equal(requests, 2);
  } finally {
    if (app?.close) await app.close();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unresponsive listeners time out instead of being reused or having their descriptor removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-reuse-timeout-'));
  const bridgeFile = join(directory, 'bridge.json');
  const server = http.createServer(request => request.resume());
  let app;
  try {
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const descriptor = JSON.stringify({ version: 2, origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid, token: 'a'.repeat(64) });
    await writeFile(bridgeFile, descriptor);
    await assert.rejects(async () => {
      app = await launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
    }, /Bridge ownership verification timed out/);
    assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
  } finally {
    if (app?.close) await app.close();
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous launchers start one owner and reuse it for the other launch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-launch-race-'));
  const bridgeFile = join(directory, 'bridge.json');
  const results = await Promise.allSettled([
    launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
    launchOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
  ]);
  try {
    assert.ok(results.every(result => result.status === 'fulfilled'));
    const offices = results.map(result => result.value);
    assert.equal(offices.filter(office => office.reused).length, 1);
    assert.equal(offices[0].origin, offices[1].origin);
    assert.equal(JSON.parse(await readFile(bridgeFile, 'utf8')).origin, offices[0].origin);
  } finally {
    for (const result of results) if (result.status === 'fulfilled' && result.value.close) await result.value.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser launcher opens only the validated actual loopback address', async t => {
  const origin = 'http://127.0.0.1:19007';
  const commands = [];
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => {
    commands.push({ command, args, options });
    callback(null);
  });
  await openOffice(origin);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.at(-1), origin);
  if (process.platform === 'win32') {
    assert.equal(commands[0].command, process.env.ComSpec ?? 'cmd.exe');
    assert.deepEqual(commands[0].args, ['/d', '/c', 'start', '""', origin]);
  }
  for (const invalid of ['https://example.invalid', `${origin}/&calc`, `${origin} & calc`]) {
    assert.throws(() => openOffice(invalid), /invalid My Office address/);
  }
  assert.equal(commands.length, 1);
});

test('browser launcher reports failures with the URL for manual opening', async t => {
  t.mock.method(childProcess, 'execFile', (command, args, options, callback) => callback(new Error('Browser unavailable')));
  await assert.rejects(openOffice('http://127.0.0.1:19007'), /Open http:\/\/127\.0\.0\.1:19007 manually.*Browser unavailable/);
});

test('double-click launcher explicitly enables browser opening', async () => {
  const script = await readFile(new URL('../../start.cmd', import.meta.url), 'utf8');
  assert.match(script, /node src\\server\.mjs --open/);
});
