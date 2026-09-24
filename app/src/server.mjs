import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OfficeStore } from './store.mjs';
import { existingOfficeOrigin, isOfficeOrigin, openOffice } from './launcher.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE.version;
if (typeof VERSION !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)) throw new Error('package.json version is invalid');
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/activity.js', ['activity.js', 'text/javascript; charset=utf-8']],
  ['/office.js', ['office.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const MAX_BODY = 16 * 1024;

async function clearStaleBridgeDescriptor(bridgeFile) {
  if (!existsSync(bridgeFile)) return;
  const contents = readFileSync(bridgeFile, 'utf8');
  const existing = JSON.parse(contents);
  let alive = false;
  if (Number.isInteger(existing.pid) && existing.pid > 0) {
    try { process.kill(existing.pid, 0); alive = true; }
    catch (error) {
      if (error.code === 'EPERM') alive = true;
      else if (error.code !== 'ESRCH') throw error;
    }
  }
  if (alive) {
    if (!isOfficeOrigin(existing.origin)) {
      throw new Error('Invalid bridge owner origin; descriptor left unchanged.');
    }
    const endpoint = new URL(existing.origin);
    // PIDs can be reused after an unclean shutdown. Only a refused connection proves the endpoint is stale.
    const listening = await new Promise((resolveProbe, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: Number(endpoint.port || 80) });
      const deadline = setTimeout(() => {
        socket.destroy(Object.assign(new Error('Bridge owner probe timed out'), { code: 'ETIMEDOUT' }));
      }, 1500);
      socket.once('connect', () => { socket.destroy(); resolveProbe(true); });
      socket.once('error', error => {
        if (error.code === 'ECONNREFUSED') resolveProbe(false);
        else reject(new Error(`Cannot verify bridge owner at ${existing.origin}; descriptor left unchanged.`, { cause: error }));
      });
      socket.once('close', () => clearTimeout(deadline));
    });
    if (listening) throw Object.assign(new Error(`Bridge endpoint ${existing.origin} is still in use (saved PID ${existing.pid}). Stop the previous My Office instance first.`), { code: 'OFFICE_ALREADY_RUNNING', bridgeFile });
  }
  if (existsSync(bridgeFile)) {
    if (readFileSync(bridgeFile, 'utf8') !== contents) throw new Error('Bridge owner changed during startup; retry after checking the running instance.');
    unlinkSync(bridgeFile);
  }
}

function bodyJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    let oversized = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        oversized = true;
        chunks.length = 0;
      } else if (!oversized) chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) return reject(Object.assign(new Error('请求体过大'), { status: 413 }));
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('JSON 格式不正确')); }
    });
    request.on('error', reject);
  });
}

export async function startOffice({ port = 19000, dataFile = resolve(ROOT, '.local', 'tasks.json'), fallback = false, demo = true, bridgeFile = dataFile ? resolve(dirname(dataFile), 'bridge.json') : null, workspaceRoot = resolve(ROOT, '..'), bridgeTestMode = false, bridgeScope = 'workspace' } = {}) {
  let saved = null;
  if (dataFile && existsSync(dataFile)) {
    if (statSync(dataFile).size > 512 * 1024) throw new Error('任务文件超过大小上限，启动已停止');
    saved = JSON.parse(readFileSync(dataFile, 'utf8'));
  }
  const store = new OfficeStore(saved, () => Date.now(), bridgeFile ? { workspaceRoot, alias: 'My Office', testMode: bridgeTestMode, scope: bridgeScope } : null);
  if (demo) store.demo('reset');
  const token = randomBytes(32).toString('hex');
  const bridgeToken = randomBytes(32).toString('hex');
  let bridgeRequests = 0;
  let bridgeWindow = Date.now();
  const streams = new Set();
  let origin;
  let closed = false;
  let timer;
  let lastFreshnessSignature;

  function freshnessSignature(snapshot) {
    return snapshot.tasks
      .filter(task => task.source === 'observed' || task.source === 'bridge_test')
      .map(task => `${task.id}:${task.status}:${task.stale}`)
      .sort()
      .join('|');
  }

  function persist() {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(`${dataFile}.tmp`, JSON.stringify(store.persistable()), { encoding: 'utf8', mode: 0o600 });
    renameSync(`${dataFile}.tmp`, dataFile);
  }

  function broadcast(snapshot = store.snapshot()) {
    lastFreshnessSignature = freshnessSignature(snapshot);
    const event = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const response of streams) {
      // A large snapshot can need draining without the client disconnecting.
      if (!response.writableNeedDrain) response.write(event);
    }
  }

  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const localHost = `127.0.0.1:${server.address()?.port}`;
    const aliasHost = `localhost:${server.address()?.port}`;
    const host = request.headers.host;
    const allowedOrigins = [`http://${localHost}`, `http://${aliasHost}`];
    if (![localHost, aliasHost].includes(host) || request.headers['sec-fetch-site'] === 'cross-site') {
      return json(response, 403, { error: '只接受本机同源请求' });
    }
    if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) return json(response, 403, { error: '来源不允许' });
    const pathname = new URL(request.url, origin).pathname;
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return json(response, 405, { error: '方法不允许' });

    if (pathname === '/api/bridge/events') {
      const supplied = request.headers['x-office-bridge-token'];
      if (!bridgeFile || request.method !== 'POST' || request.headers.origin || request.headers['sec-fetch-site'] || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(bridgeToken))) {
        return json(response, 403, { error: 'Bridge authorization failed' });
      }
      if (request.headers['content-type'] !== 'application/json') return json(response, 415, { error: 'JSON required' });
      if (Number(request.headers['content-length']) > MAX_BODY) return json(response, 413, { error: 'Event too large' });
      if (Date.now() - bridgeWindow > 60000) { bridgeWindow = Date.now(); bridgeRequests = 0; }
      if (++bridgeRequests > 600) return json(response, 429, { error: 'Bridge rate limit' });
      try {
        const accepted = store.observe(await bodyJson(request));
        if (accepted) broadcast();
        return json(response, 200, { accepted });
      } catch (error) { return json(response, error.status ?? 400, { error: 'Bridge event rejected' }); }
    }

    if (request.method !== 'GET') {
      const supplied = request.headers['x-office-token'];
      if (!allowedOrigins.includes(request.headers.origin) || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return json(response, 403, { error: '写入校验失败，请刷新页面' });
      }
      if (request.headers['content-type'] !== 'application/json') return json(response, 415, { error: '仅接受 JSON' });
      if (Number(request.headers['content-length']) > MAX_BODY) return json(response, 413, { error: '请求体过大' });
      try {
        const input = await bodyJson(request);
        if (pathname === '/api/shutdown' && request.method === 'POST') {
          json(response, 200, { ok: true });
          setImmediate(() => close());
          return;
        }
        const before = {
          tasks: structuredClone(store.tasks),
          events: structuredClone(store.events),
          classifications: new Map(store.classificationOverrides),
          running: store.running,
          tickCount: store.tickCount,
        };
        try {
          if (pathname === '/api/tasks' && request.method === 'POST') store.create(input);
          else if (/^\/api\/tasks\/[\w-]+$/.test(pathname) && request.method === 'PATCH') store.update(pathname.split('/').at(-1), input);
          else if (/^\/api\/tasks\/[\w-]+$/.test(pathname) && request.method === 'DELETE') store.remove(pathname.split('/').at(-1));
          else if (/^\/api\/sessions\/[a-f0-9]{64}\/workstream$/.test(pathname) && request.method === 'PATCH') {
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'workstream') || !Object.hasOwn(input, 'workstream')) {
              throw new Error('分类请求格式不正确');
            }
            store.setObservedWorkstream(pathname.split('/')[3], input.workstream);
          }
          else if (pathname === '/api/demo' && request.method === 'POST') store.demo(input.action);
          else return json(response, 404, { error: '接口不存在' });
          if (pathname !== '/api/demo') persist();
        } catch (error) {
          Object.assign(store, { tasks: before.tasks, events: before.events, classificationOverrides: before.classifications, running: before.running, tickCount: before.tickCount });
          if (store.copilot) {
            store.copilot.workstreamOverrides = store.classificationOverrides;
            for (const task of store.copilot.snapshot()) {
              store.copilot.setSessionWorkstream(task.sessionId, store.classificationOverrides.get(task.sessionId)?.workstream ?? null);
            }
          }
          if (error.code) throw new Error('本地保存失败；未应用此次更改');
          throw error;
        }
        broadcast();
        return json(response, 200, store.snapshot());
      } catch (error) {
        return json(response, error.status ?? 400, { error: error.message });
      }
    }

    if (pathname === '/api/session') return json(response, 200, { token, version: VERSION, state: store.snapshot() });
    if (pathname === '/api/state') return json(response, 200, store.snapshot());
    if (pathname === '/api/health') return json(response, 200, { ok: true, version: VERSION, mode: 'local-preview', realConnections: store.snapshot().realConnections, bridgeReady: Boolean(bridgeFile) });
    if (pathname === '/api/events') {
      if (streams.size >= 12) return json(response, 429, { error: '连接数已达上限' });
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
      streams.add(response);
      request.on('close', () => streams.delete(response));
      return;
    }
    let file;
    let contentType;
    if (pathname === '/vendor/lucide.js') {
      file = resolve(ROOT, 'node_modules/lucide/dist/umd/lucide.js');
      contentType = 'text/javascript; charset=utf-8';
    } else if (FILES.has(pathname)) {
      const entry = FILES.get(pathname);
      file = resolve(PUBLIC, entry[0]);
      contentType = entry[1];
    } else return json(response, 404, { error: '资源不存在' });
    try {
      const content = readFileSync(file);
      response.writeHead(200, { 'Content-Type': contentType });
      response.end(content);
    } catch { json(response, 404, { error: '资源不存在' }); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;

  if (bridgeFile) await clearStaleBridgeDescriptor(bridgeFile);
  let requestedPort = port;
  for (;;) {
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(requestedPort, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
      });
      break;
    } catch (error) {
      if (!fallback || error.code !== 'EADDRINUSE' || requestedPort >= port + 20) throw error;
      requestedPort++;
    }
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  if (bridgeFile) {
    try {
      mkdirSync(dirname(bridgeFile), { recursive: true });
      writeFileSync(bridgeFile, JSON.stringify({ version: 2, origin, token: bridgeToken, workspaceRoot, scope: bridgeScope, privacy: 'metadata-only', pid: process.pid }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await new Promise(resolveClose => server.close(resolveClose));
      if (error.code === 'EEXIST') error.bridgeFile = bridgeFile;
      throw error;
    }
  }
  lastFreshnessSignature = freshnessSignature(store.snapshot());
  timer = setInterval(() => {
    if (store.running) {
      store.advance();
      broadcast();
      return;
    }
    const snapshot = store.snapshot();
    if (freshnessSignature(snapshot) !== lastFreshnessSignature) broadcast(snapshot);
  }, 6000);
  timer.unref();

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(timer);
    for (const response of streams) response.end();
    streams.clear();
    if (bridgeFile) {
      try {
        const descriptor = JSON.parse(readFileSync(bridgeFile, 'utf8'));
        if (descriptor.token === bridgeToken) unlinkSync(bridgeFile);
      } catch {}
    }
    return new Promise(resolveClose => {
      server.close(resolveClose);
      server.closeAllConnections();
    });
  }
  return { server, store, origin, close };
}

export async function launchOffice(options = {}) {
  try {
    return { ...await startOffice(options), reused: false };
  } catch (error) {
    if (!['OFFICE_ALREADY_RUNNING', 'EEXIST'].includes(error.code) || !error.bridgeFile) throw error;
    return { origin: await existingOfficeOrigin(error.bridgeFile), reused: true };
  }
}

async function main() {
  const requested = Number(process.env.PORT ?? 19000);
  if (!Number.isInteger(requested) || requested < 1024 || requested > 65515) throw new Error('PORT must be 1024-65515');
  const office = await launchOffice({ port: requested, fallback: true, demo: false, bridgeScope: process.env.MY_OFFICE_SCOPE ?? 'all-local' });
  if (office.reused) {
    console.log(`My Office is already running: ${office.origin}`);
    console.log('Using the existing instance. Restart it to apply code or configuration changes.');
  } else {
    console.log(`My Office v${VERSION}: ${office.origin}`);
    console.log('Local metadata-only bridge ready; waiting for configured VS Code / Copilot CLI hooks. Ctrl+C to stop.');
    process.once('SIGINT', () => office.close());
    process.once('SIGTERM', () => office.close());
  }
  if (process.argv.includes('--open')) await openOffice(office.origin);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(`My Office: ${error.message}`);
    process.exitCode = 1;
  }
}
