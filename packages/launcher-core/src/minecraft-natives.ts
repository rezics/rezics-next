import { getPlatform, type MinecraftFolder, type ResolvedVersion } from '@xmcl/core';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isPortableSaveName } from './saved-worlds.ts';
import { withZipFile } from './zip-read.ts';

export async function extractMinecraftNatives(folder: MinecraftFolder, version: ResolvedVersion, destination: string) {
  const platform = getPlatform();
  const libraries = version.libraries.filter((library) => library.isNative || library.classifier.startsWith('natives'));
  for (const library of libraries) {
    const archive = folder.getLibraryByPath(library.download.path);
    await withZipFile(archive, async (zip) => {
      for await (const entry of zip.eachEntry()) {
        const path = entry.fileName;
        if (
          path.endsWith('/') ||
          path.includes('META-INF/') ||
          path.endsWith('.sha1') ||
          path.endsWith('.git') ||
          library.extractExclude?.some((prefix) => path.startsWith(prefix))
        )
          continue;
        const parts = path.split('/');
        if (parts.length > 1) {
          const [os, arch] = parts;
          if (os !== platform.name || (arch === 'ia32' ? 'x86' : arch) !== platform.arch) continue;
        }
        const file = parts.at(-1)!;
        if (!isPortableSaveName(file)) throw new Error('The Minecraft native archive contains an invalid filename.');
        await pipeline(
          await zip.openReadStreamPromise(entry),
          createWriteStream(join(destination, file), { flags: 'wx' }),
        );
      }
    });
  }
}
