import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { ZipFile } from 'yazl';
import { createLauncher } from '../src/index.ts';
import type { MinecraftModTarget, ModVersion } from '../src/modrinth.ts';

const temporary = join(import.meta.dir, '../.temp');
const directories: string[] = [];
const forge = { loader: 'forge', version: '1.20.1' } as const;
const neoforge = { loader: 'neoforge', version: '1.21.1' } as const;
const manifest = { forge: 'META-INF/mods.toml', neoforge: 'META-INF/neoforge.mods.toml' } as const;

function jar(entries: Record<string, string>) {
  const archive = new ZipFile();
  for (const [path, contents] of Object.entries(entries)) archive.addBuffer(Buffer.from(contents), path);
  archive.end();
  return buffer(archive.outputStream);
}

function loaderJar(loader: keyof typeof manifest, ...ids: string[]) {
  const mods = ids.map((id) => `[[mods]]\nmodId = "${id}"\nversion = '\${file.jarVersion}'\n`).join('');
  return jar({
    [manifest[loader]]: `modLoader = "javafml"\nloaderVersion = "[1,)"\nlicense = "MIT"\n${mods}`,
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Version: 2.4.\r\n 1\r\n\r\n',
  });
}

async function fixture() {
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'minecraft-loader-mods-'));
  directories.push(directory);
  const dataDir = join(directory, 'launcher');
  const mods = new Map<string, { release: ModVersion; data: Buffer }>();
  const pauseRelease = new Map<string, () => Promise<void>>();
  const requests: URL[] = [];
  const fetcher = (async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === 'piston-meta.mojang.com') {
      return Response.json({
        versions: [forge.version, neoforge.version].map((id) => ({
          id,
          type: 'release',
          url: `https://piston-meta.mojang.com/v1/packages/fixture/${id}.json`,
        })),
      });
    }
    if (url.pathname.endsWith('/maven-metadata.json')) return Response.json({ '1.20.1': ['1.20.1-47.4.10'] });
    if (url.pathname.startsWith('/api/maven/versions/')) return Response.json({ versions: ['21.1.206'] });
    if (url.hostname === 'cdn.modrinth.com') {
      const item = mods.get(url.pathname.split('/')[1]!);
      return item ? new Response(new Uint8Array(item.data)) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/v2/search') {
      return Response.json({ hits: [{ project_id: 'feature', title: 'Feature', description: '' }] });
    }
    if (url.pathname.startsWith('/v2/project/')) {
      return Response.json([...mods.values()].map(({ release }) => release));
    }
    const releaseId = url.pathname.split('/').at(-1)!;
    await pauseRelease.get(releaseId)?.();
    const item = mods.get(releaseId);
    return item ? Response.json(item.release) : new Response(null, { status: 404 });
  }) as typeof fetch;

  const launcher = createLauncher({
    dataDir,
    catalogUrl: 'https://catalog.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    fetch: fetcher,
    openExternal: async () => {},
  });
  const forgeInstance = await launcher.createMinecraft({ ...forge, name: 'Forge' });
  const neoInstance = await launcher.createMinecraft({ ...neoforge, name: 'NeoForge' });

  function publish(
    id: string,
    project: string,
    target: MinecraftModTarget,
    data: Buffer,
    dependencies: ModVersion['dependencies'] = [],
  ) {
    mods.set(id, {
      data,
      release: {
        id,
        project_id: project,
        name: project,
        version_number: id,
        version_type: 'release',
        game_versions: [target.version],
        loaders: [target.loader],
        dependencies,
        files: [
          {
            primary: true,
            filename: 'fixture.jar',
            url: `https://cdn.modrinth.com/${id}/fixture.jar`,
            size: data.length,
            hashes: { sha512: createHash('sha512').update(data).digest('hex') },
          },
        ],
      },
    });
  }

  return {
    launcher,
    forgeId: forgeInstance.id,
    neoId: neoInstance.id,
    directory,
    publish,
    pauseRelease,
    requests,
    modFolder: (id: string) => join(dataDir, 'instances', id, 'game', 'mods'),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('filters exact mod and dependency releases and checks downloaded JARs before updating either loader', async () => {
  const { launcher, forgeId, neoId, modFolder, publish, pauseRelease, requests } = await fixture();
  const forgeJar = await loaderJar('forge', 'feature_mod');
  const neoJar = await loaderJar('neoforge', 'feature_mod');
  publish('forge-support', 'support', forge, await loaderJar('forge', 'support_mod'));
  publish('neo-support', 'support', neoforge, await loaderJar('neoforge', 'support_mod'));
  publish('forge-feature', 'feature', forge, forgeJar, [
    { project_id: 'support', version_id: 'forge-support', dependency_type: 'required' },
  ]);
  const neoRequirements: ModVersion['dependencies'] = [
    { project_id: 'support', version_id: null, dependency_type: 'required' },
  ];
  publish('neo-feature', 'feature', neoforge, neoJar, neoRequirements);
  publish('different-game', 'feature', { ...forge, version: '1.20.2' }, forgeJar);
  publish('different-project', 'unrelated', forge, forgeJar);

  for (const [id, target, release] of [
    [forgeId, forge, 'forge-feature'],
    [neoId, neoforge, 'neo-feature'],
  ] as const) {
    expect((await launcher.searchMods(id, ' Feature '))[0]?.id).toBe('feature');
    const search = requests.at(-1)!;
    expect(search.searchParams.get('query')).toBe('Feature');
    expect(JSON.parse(search.searchParams.get('facets')!)).toContainEqual([`categories:${target.loader}`]);
    expect(JSON.parse(search.searchParams.get('facets')!)).toContainEqual([`versions:${target.version}`]);
    expect((await launcher.modVersions(id, 'feature')).map(({ id }) => id)).toEqual([release]);
    const versions = requests.at(-1)!;
    expect(versions.searchParams.get('loaders')).toBe(JSON.stringify([target.loader]));
    expect(versions.searchParams.get('game_versions')).toBe(JSON.stringify([target.version]));
  }

  await expect(launcher.installMod(forgeId, 'neo-feature')).rejects.toThrow('Minecraft 1.20.1 with Forge');
  await expect(launcher.installMod(neoId, 'forge-feature')).rejects.toThrow('Minecraft 1.21.1 with NeoForge');
  const reachedProvider = Promise.withResolvers<void>();
  const resumeProvider = Promise.withResolvers<void>();
  pauseRelease.set('forge-feature', () => {
    reachedProvider.resolve();
    return resumeProvider.promise;
  });
  const reviewing = launcher.previewModInstall(forgeId, 'forge-feature');
  await reachedProvider.promise;
  try {
    expect(await launcher.listInstalled(forgeId)).toEqual([]);
  } finally {
    pauseRelease.delete('forge-feature');
    resumeProvider.resolve();
  }
  const preview = await reviewing;
  expect(preview.release).toMatchObject({ id: 'forge-feature', projectId: 'feature' });
  expect(preview.changes.map(({ id, action }) => [id, action])).toEqual([
    ['forge-support', 'install'],
    ['forge-feature', 'install'],
  ]);
  expect(requests.some(({ hostname }) => hostname === 'cdn.modrinth.com')).toBe(false);
  await launcher.installMod(forgeId, 'forge-support');
  const lastRequest = requests.length;
  await expect(launcher.installMod(forgeId, 'forge-feature', preview.revision)).rejects.toThrow('Refresh the preview');
  expect(requests.slice(lastRequest).some(({ hostname }) => hostname === 'cdn.modrinth.com')).toBe(false);
  const updated = await launcher.previewModInstall(forgeId, 'forge-feature');
  expect(updated.changes[0]).toMatchObject({ action: 'reinstall', installedVersion: 'forge-support' });
  expect(await launcher.listInstalled(forgeId)).toHaveLength(1);
  await launcher.installMod(forgeId, 'forge-feature', updated.revision);
  const neoReview = await launcher.previewModInstall(neoId, 'neo-feature');
  const replacement = Buffer.from(neoJar);
  replacement[0] ^= 1;
  publish('neo-feature', 'feature', neoforge, replacement, neoRequirements);
  const neoRequests = requests.length;
  await expect(launcher.installMod(neoId, 'neo-feature', neoReview.revision)).rejects.toThrow('Refresh the preview');
  expect(requests.slice(neoRequests).some(({ hostname }) => hostname === 'cdn.modrinth.com')).toBe(false);
  publish('neo-feature', 'feature', neoforge, neoJar, neoRequirements);
  await launcher.installMod(neoId, 'neo-feature', neoReview.revision);
  expect((await launcher.listInstalled(forgeId)).map(({ version }) => version)).toEqual([
    'forge-support',
    'forge-feature',
  ]);
  expect((await launcher.listInstalled(neoId)).map(({ version }) => version)).toEqual(['neo-support', 'neo-feature']);
  const files = await readdir(modFolder(forgeId));
  expect(files).toHaveLength(2);
  expect(await readdir(modFolder(neoId))).toHaveLength(2);

  publish('bad-dependency', 'feature', forge, forgeJar, [
    { project_id: 'support', version_id: 'neo-support', dependency_type: 'required' },
  ]);
  await expect(launcher.installMod(forgeId, 'bad-dependency')).rejects.toThrow('Minecraft 1.20.1 with Forge');
  publish('wrong-jar', 'feature', forge, neoJar);
  await expect(launcher.installMod(forgeId, 'wrong-jar')).rejects.toThrow('Forge mod manifest');
  expect(await readdir(modFolder(forgeId))).toEqual(files);
  expect(
    (await Promise.all(files.map((file) => readFile(join(modFolder(forgeId), file))))).some((data) =>
      data.equals(forgeJar),
    ),
  ).toBe(true);
  expect((await launcher.listInstalled(forgeId)).map(({ version }) => version)).toEqual([
    'forge-support',
    'forge-feature',
  ]);
  await expect(launcher.setPackageEnabled('modrinth:support', false, forgeId)).rejects.toThrow(
    'requires modrinth:support',
  );

  const archive = `rezics-${createHash('sha256').update('modrinth:feature').digest('hex')}.jar`;
  const artifact = join(modFolder(forgeId), archive);
  const changed = Buffer.from(forgeJar);
  changed[0] = 0;
  await writeFile(artifact, changed);
  expect(await launcher.listInstalled(forgeId)).toContainEqual(
    expect.objectContaining({ title: 'feature', fileIssue: 'damaged' }),
  );
  const instance = join(dirname(dirname(modFolder(forgeId))), 'instance.json');
  await writeFile(
    instance,
    JSON.stringify({ ...JSON.parse(await readFile(instance, 'utf8')), installation: { versionId: 'fixture-forge' } }),
  );
  await expect(launcher.launch(forgeId)).rejects.toThrow('feature: its installed file is damaged');
  expect(await launcher.readLaunchReport(forgeId)).toMatchObject({ issue: { kind: 'mods', action: 'mods' } });

  publish('forge-feature', 'feature', forge, await loaderJar('forge', 'different_mod'));
  await expect(launcher.repairMod(forgeId, 'modrinth:feature')).rejects.toThrow('digest');
  expect(await readFile(artifact)).toEqual(changed);
  publish('forge-feature', 'feature', forge, forgeJar);
  await launcher.repairMod(forgeId, 'modrinth:feature');
  expect(await readFile(artifact)).toEqual(forgeJar);
  await expect(launcher.uninstallPackage('modrinth:support', forgeId)).rejects.toThrow('requires modrinth:support');
});

test('imports only the instance loader manifest, validates all provided IDs and supports enable and uninstall', async () => {
  const { launcher, forgeId, neoId, directory, modFolder } = await fixture();
  const forgeJar = join(directory, 'forge.jar');
  const neoJar = join(directory, 'neoforge.jar');
  const conflict = join(directory, 'conflict.jar');
  const invalid = join(directory, 'invalid.jar');
  await Promise.all([
    writeFile(forgeJar, await loaderJar('forge', 'primary_mod', 'secondary_mod')),
    writeFile(neoJar, await loaderJar('neoforge', 'neo_mod')),
    writeFile(conflict, await loaderJar('forge', 'other_mod', 'secondary_mod')),
    writeFile(invalid, await jar({ [manifest.forge]: '[[mods]]\nmodId = [' })),
  ]);

  await expect(launcher.importMod(forgeId, neoJar)).rejects.toThrow('Forge mod manifest');
  await expect(launcher.importMod(neoId, forgeJar)).rejects.toThrow('NeoForge mod manifest');
  await expect(launcher.importMod(forgeId, invalid)).rejects.toThrow('invalid Forge mod manifest');
  await launcher.importMod(forgeId, forgeJar);
  await launcher.importMod(neoId, neoJar);
  await expect(launcher.importMod(forgeId, conflict)).rejects.toThrow('both provide mod secondary_mod');
  expect(await launcher.listInstalled(forgeId)).toEqual([
    { id: 'local:primary_mod', title: 'primary_mod', version: '2.4.1', source: 'local', enabled: true },
  ]);
  expect(await launcher.listInstalled(neoId)).toHaveLength(1);
  const [file] = await readdir(modFolder(forgeId));
  await launcher.setPackageEnabled('local:primary_mod', false, forgeId);
  expect(await readdir(modFolder(forgeId))).toEqual([`${file}.disabled`]);
  await launcher.setPackageEnabled('local:primary_mod', true, forgeId);
  expect(await readdir(modFolder(forgeId))).toEqual([file!]);
  await rm(join(modFolder(forgeId), file!));
  expect((await launcher.listInstalled(forgeId))[0]?.fileIssue).toBe('missing');
  await launcher.setPackageEnabled('local:primary_mod', false, forgeId);
  await expect(launcher.setPackageEnabled('local:primary_mod', true, forgeId)).rejects.toThrow('before enabling');
  const recompiled = join(directory, 'recompiled.jar');
  await writeFile(recompiled, await loaderJar('forge', 'primary_mod', 'different_mod'));
  await expect(launcher.repairMod(forgeId, 'local:primary_mod', recompiled)).rejects.toThrow('digest');
  await launcher.repairMod(forgeId, 'local:primary_mod', forgeJar);
  expect((await launcher.listInstalled(forgeId))[0]).toMatchObject({ enabled: false });
  expect(await readFile(join(modFolder(forgeId), `${file}.disabled`))).toEqual(await readFile(forgeJar));
  expect(await readdir(modFolder(forgeId))).toEqual([`${file}.disabled`]);
  await launcher.uninstallPackage('local:primary_mod', forgeId);
  expect(await readdir(modFolder(forgeId))).toEqual([]);
  expect(await readdir(modFolder(neoId))).toHaveLength(1);
});
