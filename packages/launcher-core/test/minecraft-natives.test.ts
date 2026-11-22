import { expect, test } from 'bun:test';
import { getPlatform, MinecraftFolder } from '@xmcl/core';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { ZipFile } from 'yazl';
import { Minecraft } from '../src/minecraft.ts';
import { MinecraftAuth } from '../src/minecraft-auth.ts';
import { MinecraftVersions } from '../src/minecraft-versions.ts';
import { writeJson } from '../src/storage.ts';

test.skipIf(process.platform === 'darwin')(
  'recreates native files for each launch and removes them after Java exits',
  async () => {
    const scratch = join(import.meta.dir, '../.temp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'minecraft-natives-'));
    try {
      const id = 'fixture';
      const folder = new MinecraftFolder(join(root, 'minecraft-resources'));
      const game = join(root, 'game');
      const ignored = folder.getNativesRoot(id);
      await mkdir(folder.getVersionRoot(id), { recursive: true });
      await writeFile(ignored, 'Previously derived cache is occupied');
      await writeFile(folder.getVersionJar(id), 'Client fixture');

      const { name: os, arch } = getPlatform();
      const jar = new ZipFile();
      jar.addBuffer(Buffer.from('Native fixture'), `${os}/${arch}/libfixture.bin`);
      jar.addBuffer(Buffer.from('Other architecture'), `${os}/different/libfixture.bin`);
      jar.addBuffer(Buffer.from('Metadata'), 'META-INF/libfixture.bin');
      jar.end();
      const bytes = await buffer(jar.outputStream);
      const path = 'fixture/library/1/library-1-natives-test.jar';
      const library = folder.getLibraryByPath(path);
      await mkdir(dirname(library), { recursive: true });
      await writeFile(library, bytes);
      const artifact = {
        path,
        sha1: createHash('sha1').update(bytes).digest('hex'),
        size: bytes.length,
        url: 'https://example.invalid/native.jar',
      };
      const descriptor = {
        id,
        mainClass: 'fixture.Game',
        arguments: {
          game: [],
          jvm: [
            '-e',
            `const fs = require('node:fs');
          const path = require('node:path');
          const selected = process.argv[1];
          if (fs.readdirSync(selected).join() !== 'libfixture.bin') process.exit(5);
          if (fs.readFileSync(path.join(selected, 'libfixture.bin'), 'utf8') !== 'Native fixture') process.exit(6);
          fs.appendFileSync('native-folders.txt', selected + '\\n');`,
            '--',
            '${natives_directory}',
          ],
        },
        libraries: [
          {
            name: 'fixture:library:1:natives-test',
            downloads: { artifact },
          },
        ],
        javaVersion: { component: 'fixture-java', majorVersion: 21 },
      };
      await writeJson(folder.getVersionJson(id), descriptor);

      const auth = new MinecraftAuth(undefined, join(root, 'unused-credentials.json'));
      auth.launchCredentials = async () => ({ profile: { name: 'Fixture', id }, token: 'fixture-session' });
      const minecraft = new Minecraft(root, auth, new MinecraftVersions(fetch), async (executable) => ({
        executable,
        major: 21,
        architecture: 'x64',
      }));
      const settings = {
        loader: 'vanilla',
        settings: { java: { kind: 'custom', executable: process.execPath } },
      } as const;
      for (let attempt = 0; attempt < 2; attempt++) {
        let done: Promise<unknown> | undefined;
        await minecraft.start(game, { versionId: id }, settings, (child, _token, cleanup) => {
          done = Promise.all([once(child, 'close'), cleanup]);
        });
        expect(await done).toEqual([[0, null], undefined]);
        expect((await readdir(folder.root)).filter((name) => name.startsWith('natives-'))).toEqual([]);
      }
      const destinations = (await readFile(join(game, 'native-folders.txt'), 'utf8')).trim().split('\n');
      expect(destinations).toHaveLength(2);
      expect(new Set(destinations).size).toBe(2);
      expect(await readFile(ignored, 'utf8')).toBe('Previously derived cache is occupied');

      const conflictingJar = new ZipFile();
      conflictingJar.addBuffer(Buffer.from('First'), 'libfixture.bin');
      conflictingJar.addBuffer(Buffer.from('Second'), `${os}/${arch}/libfixture.bin`);
      conflictingJar.end();
      const conflictingBytes = await buffer(conflictingJar.outputStream);
      await writeFile(library, conflictingBytes);
      artifact.sha1 = createHash('sha1').update(conflictingBytes).digest('hex');
      artifact.size = conflictingBytes.length;
      await writeJson(folder.getVersionJson(id), descriptor);
      await expect(minecraft.start(game, { versionId: id }, settings)).rejects.toMatchObject({
        issue: { kind: 'installation', action: 'repair' },
      });
      expect((await readdir(folder.root)).filter((name) => name.startsWith('natives-'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
