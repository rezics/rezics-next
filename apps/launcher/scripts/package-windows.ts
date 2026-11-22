import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { minecraftClientResource, parseMinecraftClientId } from '../src/shared/minecraft-client';
import { readWindowsOverlayFiles } from './windows-overlay';

const target = process.argv.includes('--unpacked') ? 'dir' : 'nsis';
const overlay = resolve(process.env.REZICS_OVERLAY_PATH ?? '../overlay/target/release/rezics-overlay.exe');
const overlayFile = await stat(overlay).catch(() => undefined);
if (!overlayFile?.isFile() || !basename(overlay).toLowerCase().endsWith('.exe')) {
  throw new Error('Build the Windows Overlay first or set REZICS_OVERLAY_PATH to the built Windows executable.');
}
const overlayFiles = await readWindowsOverlayFiles(overlay);

const resources = '.temp/resources';
const hostCommand = 'rezics-launcher-host.exe';
const configuredClient = process.env.REZICS_MINECRAFT_CLIENT_ID?.trim() ?? '';
const minecraftClient = parseMinecraftClientId(configuredClient);
if (configuredClient && !minecraftClient) {
  throw new Error('REZICS_MINECRAFT_CLIENT_ID must be the application (client) ID of the Microsoft public client.');
}
await mkdir(resources, { recursive: true });
const host = await Bun.build({
  entrypoints: ['scripts/host.ts'],
  compile: {
    target: 'bun-windows-x64-baseline',
    outfile: resolve(resources, hostCommand),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: { REZICS_PACKAGED_LAUNCHER_HOST: 'true' },
});
if (!host.success) throw new AggregateError(host.logs, 'Could not build the Windows Launcher host.');
await writeFile(`${resources}/rezics-overlay.exe`, overlayFiles.executable);
await writeFile(resolve(resources, minecraftClientResource), `${minecraftClient ?? ''}\n`);
const files = ['rezics-overlay.exe', minecraftClientResource];
if (overlayFiles.loader) {
  await writeFile(`${resources}/WebView2Loader.dll`, overlayFiles.loader);
  files.push('WebView2Loader.dll');
}
await build({
  targets: Platform.WINDOWS.createTarget(target, Arch.x64),
  config: {
    appId: 'com.rezics.launcher',
    productName: 'REZICS Launcher',
    nsis: { include: resolve('scripts/windows-installer.nsh') },
    directories: { output: '.temp/installers' },
    files: ['.temp/app/**/*', 'package.json'],
    extraResources: [{ from: resources, to: '.', filter: files }],
    extraFiles: [
      { from: resources, to: '.', filter: [hostCommand] },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'Launcher Host Notices.md' },
    ],
    npmRebuild: false,
  },
});
