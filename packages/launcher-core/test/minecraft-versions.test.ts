import { defaultFabricVersion, defaultMinecraftVersion } from '@rezics/launcher-contract';
import { installVersionTask } from '@xmcl/installer';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLauncher } from '../src/index.ts';
import { MinecraftVersions } from '../src/minecraft-versions.ts';

const homes: string[] = [];

async function fixture(fetcher: typeof fetch) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rezics-minecraft-versions-'));
  homes.push(dataDir);
  const start = () =>
    createLauncher({
      dataDir,
      catalogUrl: 'https://catalog.example.invalid',
      webUrl: 'https://rezics.example.invalid',
      launcherVersion: '0.1.0',
      fetch: fetcher,
      openExternal: async () => {},
    });
  return { dataDir, launcher: start(), restart: start };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { force: true, recursive: true })));
});

function metadata(id: string, type = 'release') {
  return { id, type, url: `https://piston-meta.mojang.com/v1/packages/abc/${id}.json` };
}

function officialFetch(requests: string[] = []) {
  return (async (input: URL) => {
    const url = new URL(input);
    requests.push(url.href);
    if (url.hostname === 'piston-meta.mojang.com') {
      return Response.json({
        latest: { release: '26.3', snapshot: '26.4-snapshot-1' },
        versions: [
          metadata('26.4-snapshot-1', 'snapshot'),
          metadata('26.3'),
          metadata(defaultMinecraftVersion),
          metadata('1.0'),
          metadata('b1.7.3', 'old_beta'),
        ],
      });
    }
    if (url.pathname === '/v2/versions/loader/1.0') return Response.json([], { status: 400 });
    if (url.pathname !== '/v2/versions/loader/26.3') throw new Error(`Unexpected loader URL ${url.pathname}`);
    return Response.json([
      { loader: { version: '0.20.0-beta.1', stable: false } },
      { loader: { version: '0.19.2', stable: true } },
      { loader: { version: '0.19.0', stable: true } },
    ]);
  }) as typeof fetch;
}

test('streams and verifies the Minecraft metadata and client through XMCL under Bun', async () => {
  const temporary = new URL('../.temp/', import.meta.url);
  await mkdir(temporary, { recursive: true });
  const home = await mkdtemp(join(fileURLToPath(temporary), 'minecraft-download-'));
  homes.push(home);
  const id = '1.20.1';
  const client = 'client bytes';
  const sha1 = (data: string) => createHash('sha1').update(data).digest('hex');
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === '/client.jar') return new Response(client);
      if (pathname.endsWith(`/${id}.json`)) {
        return new Response(metadataAt(server.url), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    },
  });

  function metadataAt(url: URL) {
    return JSON.stringify({
      id,
      type: 'release',
      mainClass: 'fixture.Game',
      assets: 'fixture',
      libraries: [],
      downloads: {
        client: { sha1: sha1(client), size: Buffer.byteLength(client), url: new URL('client.jar', url).href },
      },
    });
  }

  try {
    const metadata = metadataAt(server.url);
    const url = new URL(`v1/packages/${sha1(metadata)}/${id}.json`, server.url).href;
    const version = await installVersionTask({ id, url }, home).startAndWait();
    expect(version.id).toBe(id);
    expect(await readFile(join(home, 'versions', id, `${id}.json`), 'utf8')).toBe(metadata);
    expect(await readFile(join(home, 'versions', id, `${id}.jar`), 'utf8')).toBe(client);
  } finally {
    await server.stop(true);
  }
});

test('preserves Fabric library checksums and fetches the missing Maven checksum', async () => {
  const profile = 'https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.14/profile/json';
  const maven = 'https://maven.fabricmc.net/';
  const asm = 'org/ow2/asm/asm/9.8/asm-9.8.jar';
  const loader = 'net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar';
  const commonHash = 'a'.repeat(40);
  const loaderHash = 'b'.repeat(40);
  const urls: string[] = [];
  const versions = new MinecraftVersions((async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === maven + loader + '.sha1') return new Response(loaderHash + '\n');
    if (url !== profile) throw new Error('Unexpected library HTTP request.');
    return Response.json({
      inheritsFrom: '1.21.1',
      mainClass: 'fixture.Game',
      libraries: [
        { name: 'org.ow2.asm:asm:9.8', url: maven, sha1: commonHash, size: 123_456 },
        { name: 'net.fabricmc:fabric-loader:0.16.14', url: maven },
      ],
    });
  }) as typeof fetch);
  const resolved = await versions.fabricProfile(
    { loader: 'fabric', version: '1.21.1', fabricVersion: '0.16.14' },
    new AbortController().signal,
  );
  expect(urls).toEqual([profile, maven + loader + '.sha1']);
  expect(resolved.libraries.map(({ downloads }) => downloads.artifact)).toEqual([
    { path: asm, url: maven + asm, sha1: commonHash, size: 123_456 },
    { path: loader, url: maven + loader, sha1: loaderHash, size: -1 },
  ]);
});

test('projects official stable releases and loader availability, then persists exact choices', async () => {
  const requests: string[] = [];
  const { launcher, restart } = await fixture(officialFetch(requests));
  expect(await launcher.listMinecraftVersions()).toEqual([
    { id: '26.3', latest: true },
    { id: defaultMinecraftVersion },
    { id: '1.0' },
  ]);
  expect(await launcher.listFabricVersions('26.3')).toEqual([
    { id: '0.20.0-beta.1', stable: false },
    { id: '0.19.2', stable: true },
    { id: '0.19.0', stable: true },
  ]);
  const explicit = await launcher.createMinecraft({
    name: 'Explicit loader',
    loader: 'fabric',
    version: '26.3',
    fabricVersion: '0.19.0',
  });
  const automatic = await launcher.createMinecraft({ name: 'Choose stable', loader: 'fabric', version: '26.3' });
  expect(explicit.minecraft).toEqual({ loader: 'fabric', version: '26.3', fabricVersion: '0.19.0', prepared: false });
  expect(automatic.minecraft).toMatchObject({ fabricVersion: '0.19.2' });
  expect((await restart().listInstances()).find(({ id }) => id === explicit.id)).toEqual(explicit);
  expect(requests).toEqual([
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    'https://meta.fabricmc.net/v2/versions/loader/26.3',
  ]);
});

test('rejects unknown versions and incompatible loaders before writing an instance', async () => {
  const { launcher } = await fixture(officialFetch());
  await expect(launcher.createMinecraft({ name: 'Undiscovered', loader: 'vanilla', version: '99.0' })).rejects.toThrow(
    'release is unavailable',
  );
  await expect(
    launcher.createMinecraft({ name: 'Private loader', loader: 'fabric', version: '26.3', fabricVersion: '0.1.0' }),
  ).rejects.toThrow('does not have this Fabric loader');
  await expect(
    launcher.createMinecraft({ name: 'Wrong loader', loader: 'vanilla', fabricVersion: defaultFabricVersion }),
  ).rejects.toThrow('Vanilla instances do not use a Fabric loader');
  expect(await launcher.listFabricVersions('1.0')).toEqual([]);
  expect(await launcher.listInstances()).toEqual([]);
});

test('creates the built-in pair offline and reads the exact legacy loader without altering the old record', async () => {
  const { dataDir, launcher } = await fixture((async (_input: URL): Promise<Response> => {
    throw new Error('unexpected network call');
  }) as typeof fetch);
  const created = await launcher.createMinecraft({ name: 'Default', loader: 'fabric' });
  expect(created.minecraft).toEqual({
    version: defaultMinecraftVersion,
    loader: 'fabric',
    fabricVersion: defaultFabricVersion,
    prepared: false,
  });
  const legacy = {
    id: 'game-legacy',
    kind: 'minecraft',
    name: 'Legacy',
    minecraft: { version: defaultMinecraftVersion, loader: 'fabric' as const, prepared: true },
    installation: {
      versionId: `fabric-loader-${defaultFabricVersion}-${defaultMinecraftVersion}`,
      javaRuntime: 'java-runtime-delta',
    },
  };
  const directory = join(dataDir, 'instances', legacy.id);
  const file = join(directory, 'instance.json');
  await mkdir(directory);
  await writeFile(file, JSON.stringify(legacy));
  const instances = await launcher.listInstances();
  expect(instances.find(({ id }) => id === legacy.id)?.minecraft).toEqual({
    ...legacy.minecraft,
    fabricVersion: defaultFabricVersion,
  });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(legacy);
});

test('catalogue failures are retryable and oversized lists are refused', async () => {
  let attempts = 0;
  const { launcher } = await fixture((async (_input: URL) => {
    switch (++attempts) {
      case 1:
        return Response.json({}, { status: 503 });
      case 2:
        return Response.json({ versions: Array.from({ length: 4097 }, () => metadata('26.3')) });
      default:
        return Response.json({ versions: [metadata('26.3')] });
    }
  }) as typeof fetch);
  await expect(launcher.listMinecraftVersions()).rejects.toThrow('503');
  await expect(launcher.listMinecraftVersions()).rejects.toThrow();
  expect(await launcher.listMinecraftVersions()).toEqual([{ id: '26.3' }]);
});
