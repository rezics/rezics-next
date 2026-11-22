import { defaultMinecraftVersion, type MinecraftPreparation, type MinecraftSelection } from '@rezics/launcher-contract';
import { MinecraftFolder, Version } from '@xmcl/core';
import { DEFAULT_RUNTIME_ALL_URL } from '@xmcl/installer';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { Agent, interceptors } from 'undici/index.js';
import { ZipFile } from 'yazl';
import { LaunchFailure } from '../../src/launch-issues.ts';
import { Minecraft } from '../../src/minecraft.ts';
import { MinecraftAuth } from '../../src/minecraft-auth.ts';
import type { MinecraftInstallation } from '../../src/minecraft-launch-metadata.ts';
import { installMinecraftLibraries } from '../../src/minecraft-libraries.ts';
import type { ForgeSelection } from '../../src/minecraft-versions.ts';
import { createMinecraftPreparation } from '../../src/plugins/minecraft-preparation.ts';
import { readJson, writeJson } from '../../src/storage.ts';

function hash(bytes: string | Buffer) {
  return createHash('sha1').update(bytes).digest('hex');
}

async function archive(entries: Record<string, string | Buffer>) {
  const zip = new ZipFile();
  for (const [path, contents] of Object.entries(entries)) zip.addBuffer(Buffer.from(contents), path);
  zip.end();
  return buffer(zip.outputStream as NodeJS.ReadableStream);
}

const root = process.argv[2];
assert(root);
const entered = Promise.withResolvers<void>();
const disconnected = Promise.withResolvers<void>();
const routes = new Map<string, string | Buffer>();
const requests: string[] = [];
let stall = false;
const server = createServer((request, response) => {
  const pathname = request.url ?? '';
  if (pathname === '/assets.json') {
    requests.push(pathname);
    response.writeHead(302, { location: '/resources/assets.json' }).end();
    return;
  }
  const contents = routes.get(pathname);
  if (!contents) {
    response.writeHead(404).end();
    return;
  }
  const headers = { 'content-length': String(Buffer.byteLength(contents)) };
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  requests.push(pathname);
  if (stall && pathname === '/client.jar') {
    response.once('close', () => disconnected.resolve());
    response.write(Buffer.of(0));
    entered.resolve();
    return;
  }
  response.end(contents);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const serverUrl = new URL(`http://127.0.0.1:${address.port}`);
try {
  const resource = (path: string, contents: string | Buffer) => {
    routes.set(path, contents);
    return { url: new URL(path, serverUrl).href, sha1: hash(contents), size: Buffer.byteLength(contents) };
  };
  const client = 'fixture jar with a known checksum';
  const java = resource(
    '/java',
    `#!${process.execPath}\nconsole.log('java.version = 21.0.1\\nos.arch = ${process.arch}');\n`,
  );
  const runtimeKey = 'java-runtime-fixture';
  const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
  const runtimeData = 'fixture Java runtime data';
  const runtimeDataFile = resource('/runtime-data', runtimeData);
  const runtimeManifest = JSON.stringify({
    files: {
      [`bin/${javaName}`]: { type: 'file', executable: true, downloads: { raw: java } },
      'lib/runtime-data': { type: 'file', executable: true, downloads: { raw: runtimeDataFile } },
      ...(process.platform !== 'win32' && {
        legal: { type: 'directory' },
        'lib/runtime-alias': { type: 'link', target: 'runtime-data' },
        'lib/legal-alias': { type: 'link', target: '../legal' },
      }),
    },
  });
  const runtime = resource('/runtime.json', runtimeManifest);
  const target = {
    availability: { group: 1, progress: 100 },
    manifest: runtime,
    version: { name: 'fixture', released: '2024-08-08T00:00:00Z' },
  };
  const platforms = ['linux', 'linux-i386', 'windows-x64', 'windows-x86', 'windows-arm64', 'mac-os', 'mac-os-arm64'];
  const library = {
    name: 'dev.rezics:fixture:1.0',
    downloads: {
      artifact: {
        path: 'dev/rezics/fixture/1.0/fixture-1.0.jar',
        ...resource('/library.jar', 'fixture library with a known checksum'),
      },
    },
  };
  const logging = {
    client: {
      argument: '-Dlog4j.configurationFile=${path}',
      type: 'log4j2-xml',
      file: { id: 'fixture-log.xml', ...resource('/logging.xml', '<Configuration/>') },
    },
  };
  const assetsRoot = join(root, 'minecraft-resources', 'assets', 'objects');
  const assets = Array.from({ length: 33 }, (_, index) => {
    const file = `asset ${index}`;
    return { file, hash: hash(file), size: file.length };
  });
  const objects = Object.fromEntries(assets.map(({ hash, size }, index) => [`assets/file-${index}`, { hash, size }]));
  const assetIndex = JSON.stringify({
    virtual: true,
    objects: { ...objects, 'alias/file-0': objects['assets/file-0'] },
  });
  for (const asset of assets) {
    const directory = join(assetsRoot, asset.hash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, asset.hash), asset.file);
  }
  const metadata = {
    id: defaultMinecraftVersion,
    type: 'release',
    releaseTime: '2024-08-08T00:00:00Z',
    time: '2024-08-08T00:00:00Z',
    mainClass: 'net.minecraft.client.main.Main',
    minimumLauncherVersion: 21,
    arguments: { game: [], jvm: [] },
    libraries: [library],
    assets: 'fixture-assets',
    assetIndex: {
      id: 'fixture-assets',
      ...resource('/resources/assets.json', assetIndex),
      url: new URL('/assets.json', serverUrl).href,
    },
    logging,
    downloads: { client: resource('/client.jar', client) },
    javaVersion: { component: runtimeKey, majorVersion: 21 },
  };
  const metadataJson = JSON.stringify(metadata);
  const listed = resource(`/v1/packages/${hash(metadataJson)}/${metadata.id}.json`, metadataJson);
  const fabricVersion = '0.16.14';
  const minecraft = new Minecraft(
    root,
    new MinecraftAuth(undefined, join(root, 'credentials.json')),
    {
      gameMetadata: async () => ({ id: metadata.id, url: listed.url }),
      async loaderInstaller() {
        throw new Error('Unexpected Forge installer for Fabric preparation');
      },
      async resourceJson(address, signal) {
        signal?.throwIfAborted();
        if (address === DEFAULT_RUNTIME_ALL_URL) {
          return Object.fromEntries(platforms.map((platform) => [platform, { [runtimeKey]: [target] }]));
        }
        throw new Error(`Unexpected resource during preparation ${address}`);
      },
      async fabricProfile() {
        const { mainClass, releaseTime, time, type, arguments: args } = metadata;
        return { inheritsFrom: metadata.id, libraries: [], mainClass, releaseTime, time, type, arguments: args };
      },
    },
    process.platform === 'win32' ? async (executable) => ({ executable, major: 21, architecture: 'x64' }) : undefined,
  );
  const instancePath = join(root, 'instance');
  const gamePath = join(instancePath, 'game');
  await mkdir(join(gamePath, 'saves', 'world'), { recursive: true });
  await mkdir(join(gamePath, 'mods'), { recursive: true });
  const world = join(gamePath, 'saves', 'world', 'level.dat');
  const mod = join(gamePath, 'mods', 'user.jar');
  await writeFile(world, 'world fixture');
  await writeFile(mod, 'user mod fixture');
  const instanceRecord = join(instancePath, 'instance.json');
  const preparation = createMinecraftPreparation({
    directory: () => instancePath,
    async prepare(_id, job) {
      const installation = await minecraft.prepare({ version: metadata.id, loader: 'fabric', fabricVersion }, job);
      await job.commit(() => writeJson(instanceRecord, installation));
    },
  });
  const id = 'minecraft';
  async function expectState(state: string) {
    const actual = await preparation.wait(id);
    assert(actual);
    assert.equal(actual.state, state, JSON.stringify(actual));
    return actual;
  }
  const reported: MinecraftPreparation[] = [];
  const unsubscribe = preparation.subscribe((attempt) => reported.push(attempt));
  await preparation.start(id, 'install');
  const ready = await expectState('ready');
  unsubscribe();
  assert.equal(ready.progress, undefined);
  const counts = (phase: MinecraftPreparation['phase']) =>
    reported.filter((attempt) => attempt.phase === phase).flatMap(({ progress }) => (progress ? [progress] : []));
  assert.deepEqual(counts('libraries'), [
    { completed: 0, total: 1 },
    { completed: 1, total: 1 },
  ]);
  assert.deepEqual(
    counts('assets'),
    [0, 32, 33].map((completed) => ({ completed, total: 33 })),
  );
  assert.deepEqual(requests.slice(0, 3), [new URL(listed.url).pathname, '/client.jar', '/runtime.json']);
  // XMCL downloads the executable and the runtime data concurrently.
  assert.deepEqual(requests.slice(3, 5).sort(), ['/java', '/runtime-data']);
  assert.deepEqual(requests.slice(5), ['/library.jar', '/assets.json', '/resources/assets.json', '/logging.xml']);
  const playable = await readFile(instanceRecord, 'utf8');
  const installation = JSON.parse(playable);
  assert.match(installation.versionId, /^1\.21\.1-fabric0\.16\.14-[a-f\d]{20}$/u);
  assert.equal(installation.javaRuntime, `${runtimeKey}-${runtime.sha1}`);
  assert.equal(installation.javaMajor, 21);
  assert.equal(await minecraft.requiredJavaMajor({ versionId: installation.versionId }), 21);
  requests.length = 0;
  await preparation.start(id, 'repair');
  await expectState('ready');
  assert.deepEqual(requests, []);

  const retained = assetsRoot + '-retained';
  await rename(assetsRoot, retained);
  await writeFile(assetsRoot, 'blocked assets directory');
  await preparation.start(id, 'repair');
  const failed = await expectState('failed');
  assert.equal(failed.phase, 'assets');
  assert.deepEqual(failed.progress, { completed: 0, total: 33 });
  assert.match(failed.error ?? '', /Minecraft assets could not be downloaded or verified/);
  assert.equal(await readFile(instanceRecord, 'utf8'), playable);
  await rm(assetsRoot);
  await rename(retained, assetsRoot);

  const installedJar = join(root, 'minecraft-resources', 'versions', metadata.id, `${metadata.id}.jar`);
  const gameResources = join(root, 'minecraft-resources');
  const installedLibrary = join(gameResources, 'libraries', library.downloads.artifact.path);
  const installedIndex = join(gameResources, 'assets', 'indexes', `${metadata.assetIndex.sha1}.json`);
  const installedLogging = join(gameResources, 'assets', 'log_configs', logging.client.file.id);
  const installedRuntime = join(gameResources, 'runtime', installation.javaRuntime);
  async function expectsRepair(summary: RegExp) {
    await assert.rejects(
      minecraft.start(gamePath, installation, { loader: 'vanilla' }),
      (failure: unknown) =>
        failure instanceof LaunchFailure &&
        failure.issue.kind === 'installation' &&
        failure.issue.action === 'repair' &&
        summary.test(failure.issue.summary),
    );
  }
  assert.deepEqual(
    installation.launchMetadata.map(({ id }: { id: string }) => id),
    [installation.versionId, metadata.id],
  );
  for (const { sha256 } of installation.launchMetadata) {
    const profile = join(gameResources, 'launch-metadata', `${sha256}.json`);
    const original = await readFile(profile, 'utf8');
    const originalClass = JSON.parse(original).mainClass as string;
    const damaged = original.replace(`"mainClass":"${originalClass}"`, `"mainClass":"x${originalClass.slice(1)}"`);
    assert.notEqual(original, damaged);
    await writeFile(profile, damaged);
    await expectsRepair(/Minecraft version or loader profile is missing or damaged/);
    await preparation.start(id, 'repair');
    await expectState('ready');
    assert.equal(await readFile(profile, 'utf8'), original);
  }

  await writeFile(installedJar, 'x'.repeat(client.length));
  await expectsRepair(/Minecraft client is missing or damaged/);
  stall = true;
  await preparation.start(id, 'repair');
  await entered.promise;
  const cancellationStarted = performance.now();
  assert.equal((await preparation.cancel(id))?.state, 'cancelling');
  await expectState('cancelled');
  await disconnected.promise;
  assert(performance.now() - cancellationStarted < 2_000, 'Cancellation did not close the stalled transfer promptly');
  assert.equal(await readFile(instanceRecord, 'utf8'), playable);

  requests.length = 0;
  stall = false;
  await preparation.start(id, 'repair');
  await expectState('ready');
  assert.deepEqual(requests, ['/client.jar']);
  assert.equal(await readFile(installedJar, 'utf8'), client);
  assert.equal(await readFile(world, 'utf8'), 'world fixture');
  assert.equal(await readFile(mod, 'utf8'), 'user mod fixture');

  await rm(installedLibrary);
  await expectsRepair(/Minecraft libraries are missing or damaged/);
  await writeFile(installedIndex, '{}');
  await expectsRepair(/Minecraft asset index is missing or damaged/);
  await writeFile(installedIndex, assetIndex);
  const indexed = join(gameResources, 'assets', 'indexes', `${metadata.assets}.json`);
  await writeFile(indexed, assetIndex);
  await rm(installedIndex);
  await expectsRepair(/Minecraft libraries are missing or damaged/);
  await writeFile(installedIndex, assetIndex);
  await rm(installedLogging);
  requests.length = 0;
  await preparation.start(id, 'repair');
  await expectState('ready');
  assert.deepEqual(requests, ['/library.jar', '/logging.xml']);
  assert.equal(await readFile(installedLogging, 'utf8'), '<Configuration/>');
  await rm(installedLogging);
  await expectsRepair(/Minecraft logging configuration is missing or damaged/);
  await writeFile(installedLogging, '<Configuration/>');

  const [firstAsset] = assets;
  assert(firstAsset);
  const installedAsset = join(assetsRoot, firstAsset.hash.slice(0, 2), firstAsset.hash);
  const virtualAssets = join(gameResources, 'assets', 'virtual', metadata.assets);
  const namedAsset = join(virtualAssets, 'assets', 'file-0');
  const aliasAsset = join(virtualAssets, 'alias', 'file-0');
  assert.equal(await readFile(namedAsset, 'utf8'), firstAsset.file);
  assert.equal(await readFile(aliasAsset, 'utf8'), firstAsset.file);
  await rm(namedAsset);
  await link(installedAsset, namedAsset);
  await writeFile(aliasAsset, 'x'.repeat(firstAsset.size));
  const unrelatedAsset = join(virtualAssets, 'user-file');
  await writeFile(unrelatedAsset, 'unrelated content');
  await writeFile(installedAsset, 'x'.repeat(firstAsset.size));
  await expectsRepair(/Minecraft assets are missing or damaged/);
  await writeFile(installedAsset, firstAsset.file);

  const installedManifest = join(installedRuntime, 'manifest.json');
  const installedRuntimeData = join(installedRuntime, 'lib', 'runtime-data');
  const runtimeAlias = join(installedRuntime, 'lib', 'runtime-alias');
  const legalAlias = join(installedRuntime, 'lib', 'legal-alias');
  if (process.platform !== 'win32') {
    assert.ok((await stat(installedRuntimeData)).mode & 0o100);
    assert.equal(await readlink(runtimeAlias), 'runtime-data');
    assert.equal(await readlink(legalAlias), '../legal');
  }
  await writeFile(installedManifest, runtimeManifest.replace('lib/runtime-data', 'lib/runtime-date'));
  await expectsRepair(/managed Java runtime files are missing or damaged/);
  await writeFile(installedManifest, runtimeManifest);
  await writeFile(installedRuntimeData, 'x'.repeat(runtimeData.length));
  const brokenRuntime = await minecraft.checkJavaRuntime(metadata.id, { kind: 'managed' }, installation);
  assert.equal(brokenRuntime.state, 'invalid');
  assert.equal(brokenRuntime.action, 'repair');
  await expectsRepair(/managed Java runtime files are missing or damaged/);
  requests.length = 0;
  await preparation.start(id, 'repair');
  await expectState('ready');
  assert.deepEqual(requests, ['/runtime-data']);
  assert.equal(await readFile(installedRuntimeData, 'utf8'), runtimeData);
  const checkedRuntime = await minecraft.checkJavaRuntime(metadata.id, { kind: 'managed' }, installation);
  assert.equal(checkedRuntime.state, 'ready');
  assert.equal(checkedRuntime.major, 21);
  assert.equal(await readFile(world, 'utf8'), 'world fixture');
  if (process.platform !== 'win32') {
    await chmod(installedRuntimeData, 0o644);
    await rm(runtimeAlias);
    await symlink('unavailable', runtimeAlias);
    await rm(legalAlias);
  }
  await assert.rejects(
    minecraft.start(gamePath, installation, { loader: 'vanilla' }),
    (failure: unknown) =>
      failure instanceof LaunchFailure && failure.issue.kind === 'account' && failure.issue.action === 'account',
  );
  assert.equal(await readFile(aliasAsset, 'utf8'), firstAsset.file);
  assert.equal(await readFile(unrelatedAsset, 'utf8'), 'unrelated content');
  if (process.platform !== 'win32') {
    assert.ok((await stat(installedRuntimeData)).mode & 0o100);
    assert.equal(await readFile(runtimeAlias, 'utf8'), runtimeData);
    assert.ok((await stat(legalAlias)).isDirectory());
  }
  await writeFile(namedAsset, 'x'.repeat(firstAsset.size));
  assert.equal(await readFile(installedAsset, 'utf8'), firstAsset.file);
  await preparation.start(id, 'repair');
  await expectState('ready');
  assert.equal(await readFile(namedAsset, 'utf8'), firstAsset.file);

  const folder = new MinecraftFolder(gameResources);
  const coordinate = 'dev/rezics/retry/1.0/retry-1.0.jar';
  const fallbackLibrary = 'verified library content';
  const destinations = [
    ['https://libraries.minecraft.net', `/${coordinate}`],
    ['https://repo.maven.apache.org', `/maven2/${coordinate}`],
    ['https://repo1.maven.org', `/maven2/${coordinate}`],
  ] as const;
  const fallbackBatch = Version.resolveLibraries([
    {
      name: 'dev.rezics:retry:1.0',
      downloads: {
        artifact: {
          path: coordinate,
          url: destinations[0].join(''),
          sha1: hash(fallbackLibrary),
          size: fallbackLibrary.length,
        },
      },
    },
  ]);
  const repositories = new Agent();
  const attempts: number[] = [];
  const dispatcher = repositories.compose(
    interceptors.redirect({ maxRedirections: 5 }),
    (dispatch) => (options, handler) => {
      const index = destinations.findIndex(
        ([origin, path]) => origin === String(options.origin) && path === options.path,
      );
      assert.notEqual(index, -1, 'Unexpected library repository');
      attempts.push(index);
      return dispatch({ ...options, origin: serverUrl.origin, path: `/repository-${index}${options.path}` }, handler);
    },
  ) as unknown as Parameters<typeof installMinecraftLibraries>[2];
  const backupPath = `/repository-2${destinations[2][1]}`;
  const centralPath = `/repository-1${destinations[1][1]}`;
  const damaged = `${fallbackLibrary} plus leftover bytes`;
  const fallbackDestination = folder.getLibraryByPath(coordinate);
  const signal = new AbortController().signal;
  try {
    routes.set(centralPath, damaged);
    routes.set(backupPath, fallbackLibrary);
    await installMinecraftLibraries(fallbackBatch, folder, dispatcher, signal);
    assert.equal(await readFile(fallbackDestination, 'utf8'), fallbackLibrary);
    assert.deepEqual(attempts.splice(0), [0, 1, 2]);

    await writeFile(fallbackDestination, 'preserved prior content');
    routes.delete(backupPath);
    await assert.rejects(installMinecraftLibraries(fallbackBatch, folder, dispatcher, signal), /published checksum/);
    assert.deepEqual(attempts, [0, 1, 2]);
    assert.equal(await readFile(fallbackDestination, 'utf8'), 'preserved prior content');
    assert.deepEqual(await readdir(dirname(fallbackDestination)), ['retry-1.0.jar']);
  } finally {
    await repositories.close();
  }

  if (process.platform !== 'win32') {
    const forge = { loader: 'forge', version: '1.20.1', forgeVersion: '47.4.10' } as const satisfies MinecraftSelection;
    const neo = {
      loader: 'neoforge',
      version: '1.21.1',
      neoForgeVersion: '21.1.206',
    } as const satisfies MinecraftSelection;
    const forgeJson = JSON.stringify({
      ...metadata,
      id: forge.version,
      downloads: {
        client: resource('/forge-client.jar', 'Forge base client'),
        client_mappings: resource('/raw-client-mappings.txt', 'Mojang raw mappings fixture'),
      },
      javaVersion: { component: 'required-runtime-fixture', majorVersion: 17 },
    });
    const forgeListed = resource(`/v1/packages/${hash(forgeJson)}/${forge.version}.json`, forgeJson);
    const processorBytes = await archive({
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nMain-Class: fixture.Processor\r\n',
    });
    const processor = {
      name: 'dev.rezics:processor:1.0',
      downloads: {
        artifact: {
          path: 'dev/rezics/processor/1.0/processor-1.0.jar',
          ...resource('/processor.jar', processorBytes),
        },
      },
    };
    const activeChild = join(root, 'active-processor');
    const holdChild = join(root, 'hold-processor');
    const clientPatch = randomBytes(3_000_000);
    const mappingsPath = 'dev/rezics/client/1.0/client-1.0-mappings.txt';
    const mappings = 'canonical Forge mappings fixture';
    async function loaderArchive(selection: ForgeSelection, revision: string) {
      const target = selection.loader === 'forge' ? '1.20.1-forge-47.4.10' : 'neoforge-21.1.206';
      const key = selection.loader;
      const profile = {
        spec: 1,
        profile: key,
        version: target,
        minecraft: selection.version,
        json: '/version.json',
        path: null,
        libraries: [processor],
        data: {
          PATCHED: { client: `[dev.rezics:patched-${key}:1.0]`, server: '' },
          ...(key === 'forge' && {
            MOJMAPS: { client: '[dev.rezics:client:1.0:mappings@txt]', server: '' },
            PATCHED_SHA: { client: `'${hash(`generated:${revision}`)}'`, server: '' },
          }),
        },
        processors: [
          ...(key === 'forge'
            ? [
                {
                  jar: processor.name,
                  args: ['--task', 'DOWNLOAD_MOJMAPS', '--sanitize', '--output', '{MOJMAPS}'],
                  classpath: [],
                  outputs: { '{MOJMAPS}': `'${hash(mappings)}'` },
                },
              ]
            : []),
          {
            jar: processor.name,
            args: [
              '--output',
              '{PATCHED}',
              revision,
              ...(key === 'neoforge'
                ? ['--task', 'PROCESS_MINECRAFT_JAR', '--extract-libraries-to', '{ROOT}/libraries/']
                : []),
            ],
            classpath: [],
          },
        ],
      };
      const launch = {
        ...metadata,
        id: target,
        inheritsFrom: selection.version,
        downloads: undefined,
        libraries: [],
        javaVersion: undefined,
      };
      return resource(
        `/loaders/${key}-${revision}.jar`,
        await archive({
          'install_profile.json': JSON.stringify(profile),
          'version.json': JSON.stringify(launch),
          'data/client.lzma': clientPatch,
        }),
      );
    }

    const forgeInstaller = await loaderArchive(forge, 'first');
    let forgeRevision = forgeInstaller;
    const neoInstaller = await loaderArchive(neo, 'first');
    const custom = new Minecraft(root, new MinecraftAuth(undefined, join(root, 'credentials.json')), {
      gameMetadata: async (version) => ({ id: version, url: version === forge.version ? forgeListed.url : listed.url }),
      loaderInstaller: async ({ loader }) => (loader === 'forge' ? forgeRevision : neoInstaller),
      async resourceJson() {
        throw new Error('Custom Java must skip the managed Java catalogue');
      },
      async fabricProfile() {
        throw new Error('Unexpected Fabric profile for Forge preparation');
      },
    });
    async function customJava(major: number) {
      const executable = join(root, `java-${major}`, 'java');
      await mkdir(join(root, `java-${major}`));
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = process.getBuiltinModule('fs');
const path = process.getBuiltinModule('path');
if (process.argv.includes('-version')) {
  console.log('java.version = ${major}.0.1\\nos.arch = ${process.arch}');
} else if (process.argv.includes('--sanitize')) {
  const outputIndex = process.argv.indexOf('--output');
  fs.writeFileSync(process.argv[outputIndex + 1], ${JSON.stringify(mappings)});
} else {
  const extractIndex = process.argv.indexOf('--extract-libraries-to');
  if (extractIndex !== -1) {
    const target = process.argv[extractIndex + 1];
    const staging = path.join(${JSON.stringify(gameResources)}, 'processor-staging');
    if (!target.startsWith(staging + path.sep) || !fs.statSync(target).isDirectory()) {
      throw new Error('Extraction must be isolated in processor staging.');
    }
  }
  const outputIndex = process.argv.indexOf('--output');
  fs.writeFileSync(process.argv[outputIndex + 1], 'generated:' + process.argv[outputIndex + 2]);
  fs.writeFileSync(process.argv[outputIndex + 1] + '.cache', 'auxiliary processor cache');
  fs.writeFileSync(${JSON.stringify(activeChild)}, String(process.pid));
  if (fs.existsSync(${JSON.stringify(holdChild)})) setInterval(() => {}, 1000);
}
`,
        { mode: 0o755 },
      );
      return { kind: 'custom', executable } as const;
    }
    const java17 = await customJava(17);
    const java21 = await customJava(21);
    const loaderRecord = (key: string) => join(root, 'loader-instances', key, 'record.json');
    const loaderJobs = createMinecraftPreparation({
      directory: (key) => join(root, 'loader-instances', key),
      async prepare(key, job) {
        const [selection, java] = key === 'neo' ? [neo, java21] : [forge, key === 'wrong' ? java21 : java17];
        const record = loaderRecord(key);
        const previous = await readJson<MinecraftInstallation>(record);
        const installation = await custom.prepare({ ...selection, settings: { java } }, job, previous);
        await job.commit(() => writeJson(record, installation));
      },
    });
    for (const [key, version, selection, java] of [
      ['forge', 17, forge, java17],
      ['neo', 21, neo, java21],
    ] as const) {
      await loaderJobs.start(key, 'install');
      const state = await loaderJobs.wait(key);
      assert.equal(state?.state, 'ready', JSON.stringify(state));
      const record = JSON.parse(await readFile(loaderRecord(key), 'utf8'));
      assert.equal(record.javaMajor, version);
      assert.equal(record.javaRuntime, undefined);
      const { loaderOutputsSha256, ...legacy } = record;
      assert.match(loaderOutputsSha256, /^[a-f\d]{64}$/u);
      const launch = () => custom.start(gamePath, record, { loader: selection.loader, settings: { java } });
      const expectsLoaderRepair = () =>
        assert.rejects(
          launch,
          (failure: unknown) =>
            failure instanceof LaunchFailure &&
            failure.issue.action === 'repair' &&
            failure.issue.summary.includes('generated Minecraft loader files'),
        );
      await assert.rejects(
        launch,
        (failure: unknown) => failure instanceof LaunchFailure && failure.issue.kind === 'account',
      );
      const relative = `dev/rezics/patched-${selection.loader}/1.0/patched-${selection.loader}-1.0.jar`;
      const generated = join(gameResources, 'libraries', ...relative.split('/'));
      const versionRoot = join(gameResources, 'versions', record.versionId);
      const cache = join(versionRoot, 'outputs.json');
      const pinned = join(versionRoot, `outputs-${loaderOutputsSha256}.json`);
      assert.equal(
        createHash('sha256')
          .update(await readFile(pinned))
          .digest('hex'),
        loaderOutputsSha256,
      );
      await writeFile(generated, 'generated:wrong');
      if (key === 'forge') await writeJson(cache, { [mappingsPath]: hash(mappings) });
      else {
        await writeJson(cache, { [relative]: hash('generated:wrong') });
        await rm(pinned);
      }
      await expectsLoaderRepair();
      await loaderJobs.start(key, 'repair');
      assert.equal((await loaderJobs.wait(key))?.state, 'ready');
      assert.equal(await readFile(generated, 'utf8'), 'generated:first');
      assert.equal(
        (await readJson<MinecraftInstallation>(loaderRecord(key)))?.loaderOutputsSha256,
        loaderOutputsSha256,
      );
      await assert.rejects(
        launch,
        (failure: unknown) => failure instanceof LaunchFailure && failure.issue.kind === 'account',
      );

      if (key === 'forge') {
        assert.equal(await readFile(join(gameResources, 'libraries', mappingsPath), 'utf8'), mappings);
        await rm(activeChild);
        await rm(cache);
        await assert.rejects(
          launch,
          (failure: unknown) => failure instanceof LaunchFailure && failure.issue.kind === 'account',
        );
        await assert.rejects(
          custom.start(gamePath, legacy, { loader: selection.loader, settings: { java } }),
          (failure: unknown) => failure instanceof LaunchFailure && failure.issue.action === 'repair',
        );
        await loaderJobs.start(key, 'repair');
        assert.equal((await loaderJobs.wait(key))?.state, 'ready');
        assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), {
          [mappingsPath]: hash(mappings),
          [relative]: hash('generated:first'),
        });
        await assert.rejects(readFile(activeChild));
        await assert.rejects(
          custom.start(gamePath, legacy, { loader: selection.loader, settings: { java } }),
          (failure: unknown) => failure instanceof LaunchFailure && failure.issue.kind === 'account',
        );
        await writeJson(loaderRecord(key), legacy);
        await loaderJobs.start(key, 'repair');
        assert.equal((await loaderJobs.wait(key))?.state, 'ready');
        assert.equal(
          (await readJson<MinecraftInstallation>(loaderRecord(key)))?.loaderOutputsSha256,
          loaderOutputsSha256,
        );
      }
    }
    await loaderJobs.start('wrong', 'install');
    const mismatch = await loaderJobs.wait('wrong');
    assert.equal(mismatch?.state, 'failed');
    assert.match(mismatch?.error ?? '', /requires Java 17/u);

    const sharedOutput = join(root, 'minecraft-resources', 'libraries', 'dev', 'rezics', 'patched-forge', '1.0');
    const generated = join(sharedOutput, 'patched-forge-1.0.jar');
    const forgeRecord = loaderRecord('forge');
    const previous = await readFile(forgeRecord, 'utf8');
    assert.equal(await readFile(generated, 'utf8'), 'generated:first');
    await rm(activeChild);
    await loaderJobs.start('forge', 'repair');
    assert.equal((await loaderJobs.wait('forge'))?.state, 'ready');
    await assert.rejects(readFile(activeChild));

    forgeRevision = await loaderArchive(forge, 'second');
    await writeFile(holdChild, 'stall');
    await loaderJobs.start('forge', 'repair');
    let processId: number | undefined;
    while (!processId) {
      const state = await loaderJobs.read('forge');
      assert.equal(state?.state, 'running', JSON.stringify(state));
      const marker = await readFile(activeChild, 'utf8').catch(() => undefined);
      if (marker) processId = Number(marker);
      else await setTimeout(10);
    }
    assert.equal((await loaderJobs.cancel('forge'))?.state, 'cancelling');
    assert.equal((await loaderJobs.wait('forge'))?.state, 'cancelled');
    assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' });
    assert.deepEqual(await readdir(sharedOutput), ['patched-forge-1.0.jar']);
    assert.deepEqual(await readdir(join(root, 'minecraft-resources', 'processor-staging')), []);
    assert.equal(await readFile(generated, 'utf8'), 'generated:first');
    assert.equal(await readFile(forgeRecord, 'utf8'), previous);
  }
} finally {
  server.closeAllConnections();
  server.close();
}
