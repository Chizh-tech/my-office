import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { startOffice } from '../src/server.mjs';

test('startup recovers a stale bridge whose PID now belongs to a live unrelated process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-startup-'));
  const bridgeFile = join(directory, 'bridge.json');
  const previous = await startOffice({ port: 0, dataFile: null, demo: false });
  const port = previous.server.address().port;
  await previous.close();
  const stale = { version: 2, origin: previous.origin, pid: process.pid, token: 'a'.repeat(64) };
  let app;
  try {
    await writeFile(bridgeFile, JSON.stringify(stale));
    app = await startOffice({ port, dataFile: null, bridgeFile, demo: false });
    assert.equal(app.origin, previous.origin, 'probe must run before binding the saved port');
    assert.equal((await fetch(`${app.origin}/api/health`)).status, 200);
    const current = JSON.parse(await readFile(bridgeFile, 'utf8'));
    assert.equal(current.pid, process.pid);
    assert.equal(current.origin, app.origin);
    assert.notEqual(current.token, stale.token);
    process.kill(stale.pid, 0);
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup preserves a live bridge owner and reports its address', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-owner-'));
  const bridgeFile = join(directory, 'bridge.json');
  let first;
  let second;
  try {
    first = await startOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
    const descriptor = await readFile(bridgeFile, 'utf8');
    await assert.rejects(async () => {
      second = await startOffice({ port: first.server.address().port, fallback: true, dataFile: null, bridgeFile, demo: false });
    }, error => error.message.includes(first.origin) && error.message.includes('Stop the previous My Office instance'));
    assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
    assert.equal((await fetch(`${first.origin}/api/health`)).status, 200);
  } finally {
    if (second) await second.close();
    if (first) await first.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup preserves an invalid bridge address instead of probing a non-loopback host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-invalid-owner-'));
  const bridgeFile = join(directory, 'bridge.json');
  let app;
  try {
    for (const origin of ['http://example.invalid:19000', 'http://127.0.0.1:19000@localhost:19000', 'http://127.0.0.1:70000', 'not a URL']) {
      const descriptor = JSON.stringify({ origin, pid: process.pid });
      await writeFile(bridgeFile, descriptor);
      await assert.rejects(async () => {
        app = await startOffice({ port: 0, dataFile: null, bridgeFile, demo: false });
      }, /Invalid bridge owner origin/);
      assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
    }
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup preserves the descriptor when endpoint verification fails unexpectedly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-probe-error-'));
  const bridgeFile = join(directory, 'bridge.json');
  const descriptor = JSON.stringify({ origin: 'http://127.0.0.1:19000', pid: process.pid });
  try {
    await writeFile(bridgeFile, descriptor);
    t.mock.method(net, 'createConnection', () => {
      const socket = new EventEmitter();
      queueMicrotask(() => {
        socket.emit('error', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }));
        socket.emit('close');
      });
      return socket;
    });
    await assert.rejects(startOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
      error => /Cannot verify bridge owner/.test(error.message) && error.cause.code === 'ECONNRESET');
    assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup bounds endpoint verification to 1500 ms and preserves the descriptor on timeout', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-probe-timeout-'));
  const bridgeFile = join(directory, 'bridge.json');
  const descriptor = JSON.stringify({ origin: 'http://127.0.0.1:19000', pid: process.pid });
  try {
    await writeFile(bridgeFile, descriptor);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let destroyed = false;
    t.mock.method(net, 'createConnection', () => {
      const socket = new EventEmitter();
      socket.destroy = error => {
        destroyed = true;
        socket.emit('error', error);
        socket.emit('close');
      };
      return socket;
    });
    const rejection = assert.rejects(startOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
      error => /Cannot verify bridge owner/.test(error.message) && error.cause.code === 'ETIMEDOUT');
    t.mock.timers.tick(1499);
    assert.equal(destroyed, false);
    t.mock.timers.tick(1);
    await rejection;
    assert.equal(destroyed, true);
    assert.equal(await readFile(bridgeFile, 'utf8'), descriptor);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('startup does not remove an ownership record replaced during its probe', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-owner-race-'));
  const bridgeFile = join(directory, 'bridge.json');
  const descriptor = { origin: 'http://127.0.0.1:19000', pid: process.pid, token: 'a'.repeat(64) };
  const replacement = JSON.stringify({ ...descriptor, token: 'b'.repeat(64) });
  try {
    await writeFile(bridgeFile, JSON.stringify(descriptor));
    t.mock.method(net, 'createConnection', () => {
      const socket = new EventEmitter();
      queueMicrotask(() => {
        writeFileSync(bridgeFile, replacement);
        socket.emit('error', Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }));
        socket.emit('close');
      });
      return socket;
    });
    await assert.rejects(startOffice({ port: 0, dataFile: null, bridgeFile, demo: false }), /Bridge owner changed during startup/);
    assert.equal(await readFile(bridgeFile, 'utf8'), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous startups retain one exclusive bridge owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-exclusive-'));
  const bridgeFile = join(directory, 'bridge.json');
  const results = await Promise.allSettled([
    startOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
    startOffice({ port: 0, dataFile: null, bridgeFile, demo: false }),
  ]);
  try {
    const owners = results.filter(result => result.status === 'fulfilled');
    assert.equal(owners.length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'EEXIST');
    assert.equal(JSON.parse(await readFile(bridgeFile, 'utf8')).origin, owners[0].value.origin);
    assert.equal((await fetch(`${owners[0].value.origin}/api/health`)).status, 200);
  } finally {
    for (const result of results) if (result.status === 'fulfilled') await result.value.close();
    await rm(directory, { recursive: true, force: true });
  }
});
