import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeModrinthPack } from '../../../../packages/launcher-core/test/fixtures/modrinth-pack';
import { createLauncherHost } from './host';

test.skipIf(process.platform === 'win32')(
  'reviews, cancels and updates a pack without replacing live worlds or changing its chosen target',
  async () => {
    const scratch = resolve(import.meta.dir, '../../.temp');
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'automation-packs-'));
    const dataDir = join(root, 'profile');
    const json = join(root, 'pack command.json');
    const script = resolve(import.meta.dir, '../../scripts/host.ts');
    const first = new URL('https://cdn.modrinth.com/data/fixture/versions/1/first.jar');
    const next = new URL('https://cdn.modrinth.com/data/fixture/versions/2/next.jar');
    const staged = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let block = false;
    let host: Awaited<ReturnType<typeof createLauncherHost>> | undefined;
    const changes: string[] = [];
    const bytes = new Map([
      [first.href, 'first required bytes'],
      [next.href, 'updated required bytes'],
    ]);

    const fetcher = (async (input, init) => {
      const href = String(input);
      const body = bytes.get(href);
      if (!body) throw new Error('Unexpected fixture resource.');
      if (block && href === next.href) {
        const signal = init?.signal;
        if (!signal) throw new Error('Missing cancellation signal.');
        signal.throwIfAborted();
        staged.resolve();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled.resolve();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      }
      return new Response(body);
    }) as typeof fetch;

    async function call(command: string, argument: object | string) {
      const input = typeof argument === 'string' ? argument : json;
      if (input === json) await writeFile(json, JSON.stringify(argument));
      const child = Bun.spawn([process.execPath, script, '--data-dir', dataDir, command, input], {
        stdout: 'pipe',
        stderr: 'pipe',
        signal: AbortSignal.timeout(10_000),
      });
      const done = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { child, done };
    }

    async function cli(command: string, input: object | string, failure?: RegExp) {
      const { done } = await call(command, input);
      const [code, stdout, stderr] = await done;
      expect(code, stderr).toBe(failure ? 1 : 0);
      if (failure) {
        expect(stderr).toMatch(failure);
        return;
      }
      return JSON.parse(stdout);
    }

    async function archive(name: string, artifact: URL) {
      const body = bytes.get(artifact.href)!;
      const filename = artifact.pathname.split('/').at(-1)!;
      return writeModrinthPack(
        join(root, `${name}.mrpack`),
        {
          formatVersion: 1,
          game: 'minecraft',
          versionId: name,
          name,
          dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.14' },
          files: [
            {
              path: `mods/${filename}`,
              downloads: [artifact.href],
              fileSize: Buffer.byteLength(body),
              hashes: {
                sha1: createHash('sha1').update(body).digest('hex'),
                sha512: createHash('sha512').update(body).digest('hex'),
              },
            },
          ],
        },
        { 'overrides/config/pack.txt': name },
      );
    }

    async function write(path: string, value: string) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, value);
    }

    try {
      host = await createLauncherHost({
        dataDir,
        catalogUrl: 'https://catalog.example.test',
        webUrl: 'https://web.example.test',
        launcherVersion: '0.1.0',
        fetch: fetcher,
        openExternal: async () => {},
        automation: { onModFolderChanged: (id) => changes.push(id) },
      });
      const original = await archive('Original', first);
      const update = await archive('Updated', next);
      const source = { kind: 'file', file: original };
      const plan = await cli('preview-minecraft-pack', { source, target: { kind: 'new' } });
      expect(plan.preview).toMatchObject({ versionId: 'Original', selection: { loader: 'fabric' } });
      const initial = await cli('install-minecraft-pack', plan);
      const instanceId = initial.id;
      const instance = join(dataDir, 'instances', instanceId);
      const game = join(instance, 'game');
      const selected = join(game, 'saves', 'Selected', 'level.dat');
      const sibling = join(game, 'saves', 'Sibling', 'level.dat');
      const settings = join(game, 'config', 'pack.txt');
      await write(selected, 'selected world');
      await write(sibling, 'sibling world');
      await writeFile(settings, 'settings edited by player');
      await write(join(game, 'mods', 'independent.jar'), 'independent mod');
      await cli(
        'install-minecraft-pack',
        { ...plan, source: { kind: 'file', file: update } },
        /Preview the pack again/,
      );
      await cli(
        'install-minecraft-pack',
        { ...plan, target: { kind: 'existing', instanceId } },
        /Preview the pack again/,
      );
      expect(await host.core.listInstances()).toHaveLength(1);

      const replace = await cli('preview-minecraft-pack', {
        source: { kind: 'file', file: update },
        target: { kind: 'existing', instanceId },
      });
      block = true;
      const attempt = await call('install-minecraft-pack', replace);
      await Promise.race([
        staged.promise,
        attempt.done.then(() => {
          throw new Error('The install exited before staging.');
        }),
      ]);
      attempt.child.kill('SIGINT');
      const [code, , error] = await attempt.done;
      expect(code).toBe(1);
      expect(error).toContain('The Launcher command was interrupted.');
      await Promise.race([cancelled.promise, waitForAbort()]);
      expect((await cli('minecraft-pack', instanceId)).versionId).toBe('Original');
      expect(changes).toEqual([]);
      expect(await readFile(join(game, 'mods', 'first.jar'), 'utf8')).toBe(bytes.get(first.href)!);
      expect(await readdir(join(game, 'mods'))).not.toContain('next.jar');
      block = false;
      expect((await cli('install-minecraft-pack', replace)).id).toBe(instanceId);
      expect((await cli('minecraft-pack', instanceId)).versionId).toBe('Updated');
      expect(await readFile(settings, 'utf8')).toBe('settings edited by player');
      expect(await readFile(join(game, 'mods', 'independent.jar'), 'utf8')).toBe('independent mod');

      const required = join(game, 'mods', 'next.jar');
      await writeFile(required, Buffer.alloc(bytes.get(next.href)!.length));
      expect(await cli('repair-minecraft-pack', instanceId)).toEqual({ repaired: 1 });
      expect(await readFile(required, 'utf8')).toBe(bytes.get(next.href)!);
      expect(changes).toEqual([instanceId, instanceId]);
      const exported = join(root, 'Portable pack.mrpack');
      expect(await cli('export-minecraft-pack', { instanceId, file: exported })).toEqual({ path: exported });
      const copy = await cli('preview-minecraft-pack', {
        source: { kind: 'file', file: exported },
        target: { kind: 'copy-worlds', instanceId, worldIds: ['Selected'] },
      });
      const receiving = await cli('install-minecraft-pack', copy);
      const target = join(dataDir, 'instances', receiving.id, 'game');
      expect(receiving.id).not.toBe(instanceId);
      expect(await readdir(join(target, 'saves'))).toEqual(['Selected']);
      expect(await readFile(join(target, 'saves', 'Selected', 'level.dat'), 'utf8')).toBe('selected world');
      expect(await readFile(join(target, 'config', 'pack.txt'), 'utf8')).toBe('Updated');
      expect(await readFile(selected, 'utf8')).toBe('selected world');
      expect(await readFile(sibling, 'utf8')).toBe('sibling world');
    } finally {
      await host?.close();
      await rm(root, { recursive: true, force: true });
    }

    function waitForAbort() {
      const signal = AbortSignal.timeout(3_000);
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('The Host did not cancel the pack download.')), {
          once: true,
        });
      });
    }
  },
  25_000,
);
