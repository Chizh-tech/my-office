import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_WINDOW, desktopOptions, desktopNavigationAllowed, desktopRequestAllowed } from '../src/desktop-config.mjs';
import { runDesktop } from '../src/desktop-runtime.mjs';
import { prepareDesktop } from '../scripts/prepare-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:19000';
const flush = () => new Promise(resolveFlush => setImmediate(resolveFlush));

test('desktop entry does not block Electron readiness with top-level await', async () => {
  const entry = await readFile(new URL('../src/desktop.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /^\s*await\s+runDesktop/m);
  assert.match(entry, /runDesktop\([\s\S]*\)\.catch\(/);
});

function electronDouble({ locked = true, loadError = null } = {}) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => locked;
  app.whenReady = async () => {};
  app.quits = 0;
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event);
    if (!event.prevented) app.quits++;
  };
  app.exit = code => { app.exitCode = code; };
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.focusCount = 0;
      this.minimized = false;
      windows.push(this);
    }
    isDestroyed() { return false; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.shown = true; }
    focus() { this.focusCount++; }
    async loadURL(url) {
      if (loadError) throw loadError;
      this.url = url;
      this.emit('ready-to-show');
    }
  }
  const desktopSession = new EventEmitter();
  desktopSession.setPermissionRequestHandler = handler => { desktopSession.permissionRequest = handler; };
  desktopSession.setPermissionCheckHandler = handler => { desktopSession.permissionCheck = handler; };
  desktopSession.webRequest = { onBeforeRequest(_filter, handler) { desktopSession.request = handler; } };
  const errors = [];
  return {
    app, BrowserWindow, windows,
    Menu: { setApplicationMenu(menu) { assert.equal(menu, null); } },
    dialog: { showErrorBox(title, message) { errors.push({ title, message }); } },
    session: { defaultSession: desktopSession },
    errors,
  };
}

test('development and packaged desktop share the original bridge and data location', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-desktop-config-'));
  try {
    await writeFile(join(directory, 'office-location.json'), JSON.stringify({ version: 1, workspaceRoot: root }));
    const dev = desktopOptions({ packaged: false, developmentRoot: root, env: {} });
    const packed = desktopOptions({ packaged: true, resourcesPath: directory, env: {} });
    assert.deepEqual(packed, dev);
    assert.equal(packed.dataFile, resolve(root, 'app', '.local', 'tasks.json'));
    assert.equal(packed.bridgeFile, resolve(root, 'app', '.local', 'bridge.json'));
    assert.equal(packed.bridgeScope, 'all-local');
    assert.equal(packed.demo, false);
    assert.equal(desktopOptions({ packaged: false, developmentRoot: root, env: { PORT: '19003', MY_OFFICE_SCOPE: 'workspace' } }).port, 19003);
    for (const env of [{ PORT: '0' }, { PORT: 'bad' }, { MY_OFFICE_SCOPE: 'unknown' }]) {
      assert.throws(() => desktopOptions({ packaged: false, developmentRoot: root, env }));
    }
    assert.throws(() => desktopOptions({ packaged: false, developmentRoot: 'relative', env: {} }), /folder is missing or invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('desktop window is sandboxed and accepts only the local office page and resources', () => {
  assert.equal(DESKTOP_WINDOW.webPreferences.nodeIntegration, false);
  assert.equal(DESKTOP_WINDOW.webPreferences.contextIsolation, true);
  assert.equal(DESKTOP_WINDOW.webPreferences.sandbox, true);
  assert.equal(DESKTOP_WINDOW.webPreferences.webSecurity, true);
  assert.ok(desktopNavigationAllowed(`${origin}/?desktop=1`, origin));
  assert.ok(desktopRequestAllowed(`${origin}/api/events`, origin));
  assert.equal(desktopNavigationAllowed(`${origin}/api/session`, origin), false);
  for (const url of ['https://example.invalid', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://127.0.0.1:19001/', 'invalid']) {
    assert.equal(desktopNavigationAllowed(url, origin), false);
    assert.equal(desktopRequestAllowed(url, origin), false);
  }
});

test('desktop reuses an external service, focuses on second launch, and does not stop the service on close', async () => {
  const electron = electronDouble();
  let launches = 0;
  const result = await runDesktop(electron, { launch: async () => { launches++; return { origin, reused: true }; }, icon: 'icon.png' });
  assert.equal(launches, 1);
  assert.equal(result.window.url, `${origin}/?desktop=1`);
  assert.equal(result.window.shown, true);
  result.window.minimized = true;
  electron.app.emit('second-instance');
  assert.equal(result.window.minimized, false);
  assert.equal(result.window.focusCount, 2);
  assert.equal(launches, 1);
  assert.deepEqual(result.window.openHandler(), { action: 'deny' });
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  result.window.webContents.emit('will-navigate', event, 'https://example.invalid');
  assert.equal(event.prevented, true);
  const desktopSession = electron.session.defaultSession;
  assert.equal(desktopSession.permissionCheck(), false);
  desktopSession.permissionRequest(null, 'media', allowed => assert.equal(allowed, false));
  desktopSession.request({ url: 'https://example.invalid' }, result => assert.equal(result.cancel, true));
  desktopSession.request({ url: `${origin}/styles.css` }, result => assert.equal(result.cancel, false));
  electron.app.emit('window-all-closed');
  assert.equal(electron.app.quits, 1);
  assert.deepEqual(electron.errors, []);
});

test('desktop stops only its own service when the window closes', async () => {
  const electron = electronDouble();
  const server = new EventEmitter();
  let closes = 0;
  const office = { origin, server, reused: false, close: async () => { closes++; server.emit('close'); } };
  await runDesktop(electron, { launch: async () => office });
  electron.app.emit('window-all-closed');
  await flush();
  assert.equal(closes, 1);
  assert.ok(electron.app.quits > 0);
  assert.deepEqual(electron.errors, []);
});

test('stopping a desktop-owned service from the page exits the desktop window', async () => {
  const electron = electronDouble();
  const server = new EventEmitter();
  let closes = 0;
  await runDesktop(electron, { launch: async () => ({ origin, server, reused: false, close: async () => { closes++; } }) });
  server.emit('close');
  await flush();
  assert.equal(closes, 1);
  assert.ok(electron.app.quits > 0);
});

test('a second desktop process exits without launching another service or window', async () => {
  const electron = electronDouble({ locked: false });
  await runDesktop(electron, { launch: async () => assert.fail('must not launch') });
  assert.equal(electron.app.quits, 1);
  assert.equal(electron.windows.length, 0);
});

test('desktop reports startup and window-load errors and cleans up an owned service', async () => {
  const failedLaunch = electronDouble();
  await runDesktop(failedLaunch, { launch: async () => { throw new Error('Invalid bridge'); } });
  assert.match(failedLaunch.errors[0].message, /Invalid bridge/);
  assert.equal(failedLaunch.windows.length, 0);
  const failedWindow = electronDouble({ loadError: new Error('Page unavailable') });
  let closes = 0;
  await runDesktop(failedWindow, { launch: async () => ({ origin, close: async () => { closes++; } }) });
  await flush();
  assert.match(failedWindow.errors[0].message, /Page unavailable/);
  assert.equal(closes, 1);
});

test('desktop build resources contain only the location and valid pixel icons', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'my-office-desktop-build-'));
  try {
    await prepareDesktop(directory);
    const location = JSON.parse(await readFile(join(directory, 'office-location.json'), 'utf8'));
    assert.deepEqual(location, { version: 1, workspaceRoot: root });
    const png = await readFile(join(directory, 'my-office.png'));
    const ico = await readFile(join(directory, 'my-office.ico'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 256);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt32LE(14), png.length);
    assert.deepEqual(ico.subarray(22), png);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.deepEqual(pkg.build.files, ['src/**/*', 'public/**/*', 'package.json']);
    assert.deepEqual(pkg.build.extraResources.map(resource => resource.to), ['office-location.json', 'my-office.png']);
    assert.equal(pkg.build.portable.requestExecutionLevel, 'user');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
