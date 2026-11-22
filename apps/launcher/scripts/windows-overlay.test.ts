import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readWindowsOverlayFiles } from './windows-overlay';

function image({ library, dll = false, machine = 0x8664 }: { library?: string; dll?: boolean; machine?: number } = {}) {
  const bytes = Buffer.alloc(0x400);
  const pe = 0x80;
  const optional = pe + 24;
  const section = optional + 240;
  bytes.write('MZ');
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x4550, pe);
  bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(dll ? 0x2002 : 2, pe + 22);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  if (library) {
    bytes.writeUInt32LE(0x1000, optional + 120);
    bytes.writeUInt32LE(40, optional + 124);
    bytes.writeUInt32LE(0x1040, 0x200 + 12);
    bytes.write(library, 0x240);
  }
  return bytes;
}

test('packages the WebView2 loader only when the x64 Overlay imports it', async () => {
  const scratch = resolve(import.meta.dir, '../.temp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'windows-overlay-'));
  const overlay = join(root, 'rezics-overlay.exe');
  const loader = join(root, 'WebView2Loader.dll');
  try {
    const staticallyLinked = image({ library: 'user32.dll' });
    await writeFile(overlay, staticallyLinked);
    expect(await readWindowsOverlayFiles(overlay)).toEqual({ executable: staticallyLinked });

    const dynamic = image({ library: 'WEBVIEW2LOADER.DLL' });
    await writeFile(overlay, dynamic);
    await expect(readWindowsOverlayFiles(overlay)).rejects.toThrow('This Overlay imports WebView2Loader.dll');
    await writeFile(loader, image({ dll: true, machine: 0x14c }));
    await expect(readWindowsOverlayFiles(overlay)).rejects.toThrow(
      'WebView2Loader.dll must be a valid Windows x64 DLL',
    );
    const companion = image({ dll: true });
    await writeFile(loader, companion);
    expect(await readWindowsOverlayFiles(overlay)).toEqual({ executable: dynamic, loader: companion });

    const broken = Buffer.from(dynamic);
    broken.writeUInt32LE(0xffff_ffff, 0x200 + 12);
    await writeFile(overlay, broken);
    await expect(readWindowsOverlayFiles(overlay)).rejects.toThrow('Could not read the Windows import table');
    await writeFile(overlay, image({ machine: 0xaa64 }));
    await expect(readWindowsOverlayFiles(overlay)).rejects.toThrow('must be a valid Windows x64 executable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
