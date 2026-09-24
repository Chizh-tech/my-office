import { DESKTOP_WINDOW, desktopNavigationAllowed, desktopRequestAllowed } from './desktop-config.mjs';

export async function runDesktop({ app, BrowserWindow, Menu, dialog, session }, { launch, icon }) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  let office;
  let window;
  let quitting = false;
  let closingService = false;
  const focus = () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on('second-instance', focus);
  app.on('activate', focus);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    quitting = true;
    if (!office?.close || closingService) return;
    event.preventDefault();
    closingService = true;
    office.close().then(() => app.quit(), error => {
      dialog.showErrorBox('My Office', `Could not stop the desktop-owned service: ${error.message}`);
      app.exit(1);
    });
  });
  try {
    await app.whenReady();
    Menu.setApplicationMenu(null);
    office = await launch();
    if (quitting) {
      if (office.close) await office.close();
      return;
    }
    if (office.server) office.server.once('close', () => app.quit());
    const desktopSession = session.defaultSession;
    desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !desktopRequestAllowed(details.url, office.origin) });
    });
    desktopSession.on('will-download', event => event.preventDefault());
    window = new BrowserWindow({ ...DESKTOP_WINDOW, webPreferences: { ...DESKTOP_WINDOW.webPreferences }, icon });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const eventName of ['will-navigate', 'will-redirect']) {
      contents.on(eventName, (event, url) => {
        if (!desktopNavigationAllowed(url, office.origin)) event.preventDefault();
      });
    }
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => {
      if (quitting) return;
      dialog.showErrorBox('My Office', `The desktop window stopped unexpectedly (${details.reason}). Reopen My Office to reconnect.`);
      app.quit();
    });
    window.on('page-title-updated', event => event.preventDefault());
    window.once('ready-to-show', focus);
    await window.loadURL(`${office.origin}/?desktop=1`);
    return { window, office };
  } catch (error) {
    dialog.showErrorBox('My Office', `Desktop startup failed: ${error.message}`);
    app.quit();
  }
}
