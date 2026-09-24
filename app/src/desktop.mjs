import { app, BrowserWindow, Menu, dialog, session } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchOffice } from './server.mjs';
import { desktopOptions } from './desktop-config.mjs';
import { runDesktop } from './desktop-runtime.mjs';

const developmentRoot = fileURLToPath(new URL('../../', import.meta.url));
app.setName('My Office');
app.setAppUserModelId('local.myoffice.desktop');
app.setPath('userData', resolve(app.getPath('appData'), 'My Office'));

await runDesktop({ app, BrowserWindow, Menu, dialog, session }, {
  launch: () => launchOffice(desktopOptions({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    developmentRoot,
  })),
  icon: app.isPackaged
    ? resolve(process.resourcesPath, 'my-office.png')
    : resolve(developmentRoot, 'app', '.local', 'desktop-build', 'my-office.png'),
});
