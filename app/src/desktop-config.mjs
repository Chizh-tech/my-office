import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function desktopOptions({ packaged, resourcesPath, developmentRoot, env = process.env }) {
  const location = packaged
    ? JSON.parse(readFileSync(resolve(resourcesPath, 'office-location.json'), 'utf8'))
    : { version: 1, workspaceRoot: developmentRoot };
  const root = location.workspaceRoot;
  if (location.version !== 1 || typeof root !== 'string' || !isAbsolute(root)
    || root.startsWith('\\\\') || !existsSync(resolve(root, 'app', 'src', 'bridge-hook.mjs'))) {
    throw new Error('My Office project folder is missing or invalid. Restore the original project folder or rebuild the desktop app from its new location.');
  }
  const port = Number(env.PORT ?? 19000);
  if (!Number.isInteger(port) || port < 1024 || port > 65515) throw new Error('PORT must be 1024-65515');
  const bridgeScope = env.MY_OFFICE_SCOPE ?? 'all-local';
  if (!['workspace', 'all-local'].includes(bridgeScope)) throw new Error('MY_OFFICE_SCOPE must be workspace or all-local');
  return {
    port, fallback: true, demo: false, bridgeScope,
    workspaceRoot: root,
    dataFile: resolve(root, 'app', '.local', 'tasks.json'),
    bridgeFile: resolve(root, 'app', '.local', 'bridge.json'),
  };
}

export function desktopNavigationAllowed(target, origin) {
  if (!URL.canParse(target)) return false;
  const url = new URL(target);
  return url.origin === origin && url.pathname === '/' && !url.username && !url.password;
}

export function desktopRequestAllowed(target, origin) {
  return URL.canParse(target) && new URL(target).origin === origin;
}

export const DESKTOP_WINDOW = {
  width: 1280,
  height: 860,
  minWidth: 900,
  minHeight: 640,
  title: 'My Office',
  backgroundColor: '#fffaf0',
  show: false,
  autoHideMenuBar: true,
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  },
};
