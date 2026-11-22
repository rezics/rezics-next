import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  type MessageBoxOptions,
} from 'electron';
import type { RpcResult } from '../shared/desktop';
import {
  automaticBackupChannel,
  extensionsChangedChannel,
  footprintRecordingChangedChannel,
  installedChangedChannel,
  launchReportChangedChannel,
  minecraftPreparationChannel,
  minecraftSignInChannel,
  modFolderChangedChannel,
  overlayPreferencesChannel,
  overlayStatusChannel,
  rpcChannel,
  saveHistoryChangedChannel,
  sessionChannel,
} from '../shared/desktop';
import { readPackagedMinecraftClientId } from '../shared/minecraft-client';
import { createLauncherHost } from './host';
import { createDesktopRpc } from './rpc';

const scheme = 'rezics-launcher';
const rendererUrl = `${scheme}://app/`;
const rendererRoot = resolve(import.meta.dirname, 'renderer');
const iconPath = resolve(import.meta.dirname, 'rezics.png');
const runFile = promisify(execFile);
protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
app.enableSandbox();

if (app.requestSingleInstanceLock()) {
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error('Could not start REZICS Launcher.', error);
      app.exit(1);
    });
} else {
  app.quit();
}

async function linuxRenameDirectory(source: string, destination: string) {
  const workspaceBun = resolve(app.getAppPath(), '../../node_modules/.bin/bun');
  const bun = await access(workspaceBun, constants.X_OK).then(
    () => workspaceBun,
    () => 'bun',
  );
  const helper = resolve(import.meta.dirname, 'rename-directory.mjs');
  const { stdout } = await runFile(bun, [helper, source, destination], { maxBuffer: 4096 });
  const status = stdout.trim();
  if (!/^\d{1,4}$/u.test(status)) throw new Error('The Linux directory publication helper returned an invalid result.');
  return Number(status);
}

async function start() {
  const webUrl = process.env.REZICS_WEB_URL ?? 'https://rezics.com';
  const catalogUrl = process.env.REZICS_CATALOG_URL ?? 'https://api.rezics.com';
  const minecraftClientId = app.isPackaged
    ? await readPackagedMinecraftClientId(process.resourcesPath)
    : process.env.REZICS_MINECRAFT_CLIENT_ID;
  const webOrigin = new URL(webUrl).origin;
  const dataDir = app.getPath('userData');
  const canStoreSecrets =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  let launcher: BrowserWindow | null = null;
  const host = await createLauncherHost({
    dataDir,
    catalogUrl,
    webUrl,
    launcherVersion: app.getVersion(),
    locale: app.getLocale(),
    ...(process.platform === 'linux' && { linuxRenameDirectory }),
    ...(minecraftClientId && { minecraftClientId }),
    ...(canStoreSecrets && {
      secretStorage: {
        encrypt: (plain: string) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (encrypted: string) => safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
      },
    }),
    overlayExecutable: overlayPath(),
    automation: {
      onInstalledChanged(archivedInstanceIds) {
        if (launcher && !launcher.webContents.isDestroyed()) {
          launcher.webContents.send(installedChangedChannel, archivedInstanceIds);
        }
      },
      onSaveHistoryChanged(instanceId) {
        if (launcher && !launcher.webContents.isDestroyed()) {
          launcher.webContents.send(saveHistoryChangedChannel, instanceId);
        }
      },
      onModFolderChanged(instanceId) {
        if (launcher && !launcher.webContents.isDestroyed()) {
          launcher.webContents.send(modFolderChangedChannel, instanceId);
        }
      },
      onExtensionsChanged() {
        if (launcher && !launcher.webContents.isDestroyed()) launcher.webContents.send(extensionsChangedChannel);
      },
      onFootprintRecordingChanged() {
        if (launcher && !launcher.webContents.isDestroyed()) {
          launcher.webContents.send(footprintRecordingChangedChannel);
        }
      },
    },
    onOverlayStatus(status) {
      if (launcher && !launcher.webContents.isDestroyed()) launcher.webContents.send(overlayStatusChannel, status);
    },
    onOverlayPreferences(value) {
      if (launcher && !launcher.webContents.isDestroyed()) launcher.webContents.send(overlayPreferencesChannel, value);
    },
    async openExternal(link: string) {
      const url = new URL(link);
      if (url.origin !== webOrigin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
        throw new Error('The destination is outside the configured REZICS website.');
      }
      await shell.openExternal(url.href);
    },
  });
  const { core, overlay } = host;
  let closing = false;
  let quitting = false;
  let quitRequest: { confirmed: boolean } | undefined;
  const { handlers: handle, abandonRendererRequests } = createDesktopRpc(host, () => launcher);
  const stopSession = core.subscribe((value) => {
    if (launcher && !launcher.webContents.isDestroyed()) launcher.webContents.send(sessionChannel, value);
  });
  const stopSignIn = core.subscribeMinecraftSignIn(() => {
    if (launcher && !launcher.webContents.isDestroyed()) launcher.webContents.send(minecraftSignInChannel);
  });
  const stopPreparation = core.subscribeMinecraftPreparation((value) => {
    if (launcher && !launcher.webContents.isDestroyed()) {
      launcher.webContents.send(minecraftPreparationChannel, value);
    }
  });
  const stopBackup = core.subscribeAutomaticBackup((instanceId, value) => {
    if (launcher && !launcher.webContents.isDestroyed()) {
      launcher.webContents.send(automaticBackupChannel, instanceId, value);
    }
  });
  const stopLaunchReport = core.subscribeLaunchReport((instanceId) => {
    if (launcher && !launcher.webContents.isDestroyed()) {
      launcher.webContents.send(launchReportChangedChannel, instanceId);
    }
  });

  registerRendererRoutes();
  session.defaultSession.setPermissionRequestHandler((_view, _permission, resolve) => resolve(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.handle(rpcChannel, async (event, name: unknown, ...args: unknown[]): Promise<RpcResult<unknown>> => {
    const sender = event.senderFrame;
    if (
      !launcher ||
      event.sender !== launcher.webContents ||
      sender !== launcher.webContents.mainFrame ||
      sender?.url !== rendererUrl ||
      typeof name !== 'string' ||
      !Object.hasOwn(handle, name)
    ) {
      return { ok: false, error: 'This request is unavailable from the current window.' };
    }
    if (closing) return { ok: false, error: 'The Launcher host is closing.' };
    if (name === 'launch' && quitRequest?.confirmed) {
      return { ok: false, error: 'Quit is scheduled. Cancel it from the Launcher tray to start another game.' };
    }
    try {
      return { ok: true, value: await handle[name as keyof typeof handle](...args) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 320) : 'The launcher could not complete the action.',
      };
    }
  });

  const tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.on('click', show);
  updateTray();
  app.on('activate', show);
  app.on('second-instance', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (closing) {
      event.preventDefault();
      return;
    }
    const work = core.gameWorkState();
    if (work !== 'idle' || (quitRequest && !quitRequest.confirmed)) {
      event.preventDefault();
      if (!quitRequest) void scheduleQuit(work === 'playing');
      return;
    }
    event.preventDefault();
    closing = true;
    const packagesClosed = abandonRendererRequests();
    stopSession();
    stopSignIn();
    stopPreparation();
    stopBackup();
    stopLaunchReport();
    void packagesClosed
      .then(() => host.close())
      .catch(() => {})
      .finally(() => {
        quitting = true;
        tray.destroy();
        app.quit();
      });
  });
  show();

  function cancelQuit() {
    quitRequest = undefined;
    updateTray();
  }

  function updateTray() {
    const pending = quitRequest?.confirmed;
    tray.setToolTip(pending ? 'REZICS Launcher · Quit scheduled' : 'REZICS Launcher');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Launcher', click: show },
        { type: 'separator' },
        pending
          ? { label: 'Cancel scheduled quit', click: cancelQuit }
          : { label: 'Quit Launcher', click: () => app.quit() },
      ]),
    );
  }

  async function scheduleQuit(ask: boolean) {
    const request = { confirmed: false };
    quitRequest = request;
    if (ask) {
      const options: MessageBoxOptions = {
        type: 'question',
        title: 'Quit REZICS Launcher',
        message: 'A game is starting or still running.',
        detail: 'Launcher can quit after the game closes and its automatic save backup completes.',
        buttons: ['Keep Launcher open', 'Quit after game closes'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const choice = await (
        launcher?.isVisible() ? dialog.showMessageBox(launcher, options) : dialog.showMessageBox(options)
      ).catch(() => undefined);
      if (choice?.response !== 1) {
        cancelQuit();
        return;
      }
    }
    request.confirmed = true;
    updateTray();
    await core.waitForGameWork();
    if (quitRequest === request) app.quit();
  }

  function show(): void {
    if (launcher) {
      if (launcher.isMinimized()) launcher.restore();
      launcher.show();
      launcher.focus();
      return;
    }
    const window = new BrowserWindow({
      title: 'REZICS Launcher',
      icon: iconPath,
      width: 1120,
      height: 760,
      minWidth: 680,
      minHeight: 520,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: resolve(import.meta.dirname, 'preload.cjs'),
      },
    });
    launcher = window;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
      if (isMainFrame && !isSameDocument) void abandonRendererRequests();
    });
    window.webContents.on('render-process-gone', abandonRendererRequests);
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      if (launcher === window) launcher = null;
    });
    void window.loadURL(rendererUrl).catch(() => console.error('Could not load the launcher interface.'));
  }
}

function registerRendererRoutes(): void {
  protocol.handle(scheme, (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.hostname !== 'app') return new Response(null, { status: 404 });
    try {
      const pathname = decodeURIComponent(url.pathname);
      const asset = resolve(rendererRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
      const candidate = relative(rendererRoot, asset);
      if (!candidate || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
        return new Response(null, { status: 404 });
      }
      return net.fetch(pathToFileURL(asset).href);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function overlayPath(): string | undefined {
  if (process.env.REZICS_OVERLAY_PATH) return resolve(process.env.REZICS_OVERLAY_PATH);
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  return app.isPackaged
    ? resolve(process.resourcesPath, 'rezics-overlay.exe')
    : resolve(app.getAppPath(), '../overlay/target/release/rezics-overlay.exe');
}
