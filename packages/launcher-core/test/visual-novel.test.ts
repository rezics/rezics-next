import type { VisualNovelRestoreChoice } from '@rezics/launcher-contract';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Instances } from '../src/instances.ts';
import { createLauncher } from '../src/index.ts';

const fixtures: string[] = [];

async function fixture() {
  const scratch = fileURLToPath(new URL('../.temp/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const folder = await mkdtemp(join(scratch, 'visual-novel-'));
  fixtures.push(folder);
  const executable = join(folder, 'story.exe');
  await writeFile(executable, 'fixture with no runnable code');
  return { folder, executable, instances: new Instances(join(folder, 'launcher')) };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((folder) => rm(folder, { force: true, recursive: true })));
});

test('reads literal Ren’Py metadata from the selected working folder and keeps manual save precedence', async () => {
  const { folder, executable, instances } = await fixture();
  const workingDirectory = join(folder, 'installation');
  await mkdir(join(workingDirectory, 'game'), { recursive: true });
  await writeFile(
    join(workingDirectory, 'game', 'options.rpy'),
    [
      'define config.name = _("星の物語: \\"After Dark\\"") # displayed title (default)',
      "define config.version = '1.2.0'",
      'define config.save_directory = "StarStory-1234"',
    ].join('\r\n'),
  );

  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
  expect(await instances.inspectVisualNovel({ executable, workingDirectory })).toEqual({
    engine: 'renpy',
    title: '星の物語: "After Dark"',
    version: '1.2.0',
    saveName: 'StarStory-1234',
    gameSaveDirectory: join(workingDirectory, 'game', 'saves'),
    detectedSaveDirectory: expect.stringMatching(/StarStory-1234$/u),
  });

  const input = { kind: 'visual-novel', name: 'Story', executable, workingDirectory } as const;
  const automatic = await instances.local(input);
  const manualName = await instances.local({ ...input, renpySaveName: 'ChosenName' });
  const saveDirectory = join(folder, 'manual-saves');
  await mkdir(saveDirectory);
  const manualPath = await instances.local({ ...input, saveDirectory, renpySaveName: 'ChosenName' });

  const roots = async (id: string) => instances.saveRoots(await instances.find(id));
  expect(await roots(automatic.id)).toEqual([
    { id: 'game', path: join(workingDirectory, 'game', 'saves') },
    { id: 'renpy', path: expect.stringMatching(/StarStory-1234$/) },
  ]);
  expect((await roots(manualName.id)).map(({ path }) => basename(path))).toEqual(['saves', 'ChosenName']);
  expect(await roots(manualPath.id)).toEqual([{ id: 'selected', path: saveDirectory }]);
});

test('discovers the Ren’Py save base in engine order and backs up the actual profile', async () => {
  const { folder, instances } = await fixture();
  const installation = join(folder, 'portable', 'installation');
  const executable = join(installation, 'Story.exe');
  const portable = join(folder, 'portable', "Ren'Py Data");
  const farther = join(folder, "Ren'Py Data");
  const dataDir = join(folder, 'launcher');
  const name = '星の物語 Saves';
  const profile = join(portable, name);
  const local = join(installation, 'game', 'saves');
  await mkdir(local, { recursive: true });
  await mkdir(portable, { recursive: true });
  await mkdir(farther, { recursive: true });
  await writeFile(executable, 'fixture');
  await writeFile(join(installation, 'game', 'options.rpy'), `define config.save_directory = "${name}"`);
  const previous = process.env.RENPY_PATH_TO_SAVES;
  try {
    delete process.env.RENPY_PATH_TO_SAVES;
    expect(await instances.inspectVisualNovel({ executable })).toMatchObject({
      engine: 'renpy',
      saveName: name,
      detectedSaveDirectory: profile,
    });
    await mkdir(profile);
    await writeFile(join(profile, 'persistent'), 'portable progress');
    await writeFile(join(local, 'slot.save'), 'original local slot');
    const launcher = createLauncher({
      dataDir,
      catalogUrl: 'https://api.example.invalid',
      webUrl: 'https://rezics.example.invalid',
      launcherVersion: '0.1.0',
      openExternal: async () => {},
    });
    const instance = await launcher.importInstance({ kind: 'visual-novel', name: 'Portable', executable });
    const backup = await launcher.createSnapshot(instance.id, 'Engine save folders');
    expect((await launcher.previewRestore(instance.id, backup.id)).targets.map(({ path }) => path)).toEqual([
      local,
      profile,
    ]);
    await writeFile(join(profile, 'persistent'), 'later progress');
    await launcher.restoreSnapshot(instance.id, backup.id);
    expect(await readFile(join(profile, 'persistent'), 'utf8')).toBe('portable progress');

    process.env.RENPY_PATH_TO_SAVES = '../override';
    const override = join(folder, 'portable', 'override', name);
    expect((await instances.inspectVisualNovel({ executable })).detectedSaveDirectory).toBe(override);
    expect((await launcher.previewRestore(instance.id, backup.id)).targets.map(({ path }) => path)).toEqual([
      local,
      override,
    ]);
    process.env.RENPY_PATH_TO_SAVES = dataDir;
    expect((await instances.inspectVisualNovel({ executable })).detectedSaveDirectory).toBeUndefined();
    expect(await instances.saveRoots(await instances.find(instance.id))).toEqual([{ id: 'game', path: local }]);
    process.env.RENPY_PATH_TO_SAVES = executable;
    expect(await instances.inspectVisualNovel({ executable })).toEqual({
      engine: 'renpy',
      saveName: name,
      gameSaveDirectory: local,
    });
  } finally {
    if (previous === undefined) delete process.env.RENPY_PATH_TO_SAVES;
    else process.env.RENPY_PATH_TO_SAVES = previous;
  }
});

test('uses the bundled Ren’Py package and the engine’s first content folder for inspection and restores', async () => {
  const { folder } = await fixture();
  const dataDir = join(folder, 'launcher-data');
  const instances = new Instances(dataDir);
  const executable = join(folder, 'Prefix_A Story.release.exe');
  const workingDirectory = join(folder, 'working');
  await writeFile(executable, 'fixture');
  await mkdir(join(folder, 'renpy', 'common'), { recursive: true });
  await mkdir(join(workingDirectory, 'game'), { recursive: true });
  await writeFile(join(workingDirectory, 'game', 'options.rpy'), 'define config.name = "Wrong working folder"');
  const candidates = ['Prefix_A Story', 'A Story', 'Story', 'game', 'data', 'launcher/game', ''];
  for (const candidate of candidates) {
    const content = join(folder, candidate);
    await mkdir(content, { recursive: true });
    if (candidate === 'data') {
      await mkdir(join(content, 'cache'));
      await writeFile(join(content, 'cache', 'build_info.json'), JSON.stringify({ name: candidate }));
    } else {
      await writeFile(join(content, 'options.rpy'), `define config.name = "${candidate || 'Package root'}"`);
    }
  }
  const original = join(folder, candidates[0]!, 'saves');
  await mkdir(original);
  await writeFile(join(original, 'slot.save'), 'saved in the original content folder');
  const launcher = createLauncher({
    dataDir,
    catalogUrl: 'https://api.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
  });
  const instance = await launcher.importInstance({ kind: 'visual-novel', name: 'VN', executable, workingDirectory });
  const backup = await launcher.createSnapshot(instance.id, 'Engine folder');
  const originalReview = (await launcher.previewRestore(instance.id, backup.id)).review;
  expect(originalReview).toBeDefined();
  for (const candidate of candidates) {
    const content = join(folder, candidate);
    const saves = join(content, 'saves');
    expect(await instances.inspectVisualNovel({ executable, workingDirectory })).toEqual({
      engine: 'renpy',
      title: candidate || 'Package root',
      gameSaveDirectory: saves,
    });
    const preview = await launcher.previewRestore(instance.id, backup.id);
    expect(preview.targets.map(({ path }) => path)).toEqual([saves]);
    if (candidate === 'data') {
      await expect(launcher.restoreSnapshot(instance.id, backup.id, undefined, originalReview)).rejects.toThrow(
        'The save destinations changed',
      );
      await launcher.restoreSnapshot(instance.id, backup.id, undefined, preview.review);
      expect(await readFile(join(saves, 'slot.save'), 'utf8')).toBe('saved in the original content folder');
    }
    if (candidate) await rm(content, { recursive: true });
  }
});

test('skips dynamic statements, multiline text, duplicate declarations and unsafe save names', async () => {
  const { folder, executable, instances } = await fixture();
  const game = join(folder, 'game');
  await mkdir(game);
  await writeFile(
    join(game, 'options.rpy'),
    [
      'define gui.about = _p("""',
      'define config.name = "Name from multiline text"',
      '""")',
      '# define config.name = "Name from a comment"',
      'define config.name = get_title()',
      'define config.version = "first"',
      'define config.version = "second"',
      'define config.save_directory = "../outside"',
    ].join('\n'),
  );

  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    gameSaveDirectory: join(game, 'saves'),
  });
});

test('reads build metadata for compiled Ren’Py games and ignores oversized source', async () => {
  const { folder, executable, instances } = await fixture();
  const game = join(folder, 'game');
  await mkdir(game);
  await writeFile(join(game, 'options.rpy'), 'define config.name = "Ignored"\n'.padEnd(65_537));
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
  await writeFile(join(game, 'options.rpyc'), Buffer.from([0, 255, 0]));

  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    gameSaveDirectory: join(game, 'saves'),
  });
  const cache = join(game, 'cache');
  await mkdir(cache);
  const build = join(cache, 'build_info.json');
  await writeFile(
    build,
    JSON.stringify({ info: { save_directory: 'AuthorDefined' }, time: 1750000000, name: '星の物語', version: '1.2.0' }),
  );
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    title: '星の物語',
    version: '1.2.0',
    gameSaveDirectory: join(game, 'saves'),
  });
  await rm(join(game, 'options.rpyc'));
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
  await mkdir(join(folder, 'renpy', 'common'), { recursive: true });
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    title: '星の物語',
    version: '1.2.0',
    gameSaveDirectory: join(game, 'saves'),
  });
  await writeFile(build, '{ malformed');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    gameSaveDirectory: join(game, 'saves'),
  });
});

test('prefers script literals and fills missing display fields from the Ren’Py build', async () => {
  const { folder, executable, instances } = await fixture();
  const game = join(folder, 'game');
  await mkdir(join(game, 'cache'), { recursive: true });
  await writeFile(join(game, 'cache', 'build_info.json'), JSON.stringify({ name: 'Package title', version: '7.0' }));
  await writeFile(
    join(game, 'options.rpy'),
    'define config.name = _("Script title")\ndefine config.save_directory = "Story-456"',
  );
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    title: 'Script title',
    version: '7.0',
    saveName: 'Story-456',
    gameSaveDirectory: join(game, 'saves'),
    detectedSaveDirectory: expect.stringMatching(/Story-456$/u),
  });
});

test('uses detected KAG saves and restores earlier snapshots through their existing save root', async () => {
  const { folder, executable, instances } = await fixture();
  const launcher = createLauncher({
    dataDir: join(folder, 'launcher'),
    catalogUrl: 'https://api.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
  });
  const previous = join(folder, 'game', 'saves');
  await mkdir(previous, { recursive: true });
  await writeFile(join(previous, 'slot'), 'original');
  const instance = await launcher.importInstance({ kind: 'visual-novel', name: 'Story', executable });
  const first = await launcher.createSnapshot(instance.id, 'Before discovery');

  const data = join(folder, 'data');
  await mkdir(join(data, 'system'), { recursive: true });
  await writeFile(join(data, 'startup.tjs'), 'Scripts.execStorage("system/Initialize.tjs");');
  await writeFile(join(data, 'system', 'Initialize.tjs'), '// Fixture');
  await writeFile(
    join(data, 'system', 'Config.tjs'),
    Buffer.concat([
      Buffer.from('/*\n;System.title = "Comment";\n*/\n;global.config_version = "";\n;System.title = "'),
      Buffer.from('90af82cc95a88cea', 'hex'),
      Buffer.from('";\n'),
    ]),
  );
  await writeFile(join(folder, 'story.cf'), 'datapath=$(exepath)\\LocalSaves\r\n');
  const detected = join(folder, 'LocalSaves');
  await mkdir(detected);
  await writeFile(join(detected, 'slot.kdt'), 'backup');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'kirikiri',
    title: '星の物語',
    detectedSaveDirectory: detected,
  });

  const second = await launcher.createSnapshot(instance.id, 'After discovery');
  await writeFile(join(previous, 'slot'), 'later');
  await writeFile(join(detected, 'slot.kdt'), 'untouched by earlier snapshot');
  await launcher.restoreSnapshot(instance.id, first.id);
  expect(await readFile(join(previous, 'slot'), 'utf8')).toBe('original');
  expect(await readFile(join(detected, 'slot.kdt'), 'utf8')).toBe('untouched by earlier snapshot');
  await rm(detected, { recursive: true });
  await launcher.restoreSnapshot(instance.id, second.id);
  expect(await readFile(join(detected, 'slot.kdt'), 'utf8')).toBe('backup');

  await writeFile(join(folder, 'story.cf'), 'datapath=$(exepath)\\game');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'kirikiri', title: '星の物語' });
  await writeFile(join(folder, 'story.cf'), 'datapath=$(exepath)\\game\\saves');
  expect((await instances.inspectVisualNovel({ executable })).detectedSaveDirectory).toBe(previous);

  const selected = join(folder, 'manual');
  await mkdir(selected);
  await launcher.updateVisualNovelSettings(instance.id, { saveDirectory: selected });
  expect(await instances.saveRoots(await instances.find(instance.id))).toEqual([{ id: 'selected', path: selected }]);
});

test('recognizes a standard XP3 header and limits inferred paths to explicit game-local settings', async () => {
  const { folder, executable, instances } = await fixture();
  const archive = join(folder, 'data.xp3');
  const config = join(folder, 'story.cf');
  const xp3 = Buffer.alloc(80_000);
  Buffer.from('5850330d0a200a1a8b6701', 'hex').copy(xp3);
  xp3.writeBigUInt64LE(80_000n, 11);
  await writeFile(archive, xp3);
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });

  xp3.writeBigUInt64LE(70_000n, 11);
  await writeFile(archive, xp3);
  for (const value of [
    'datapath=$(exepath)\\..\\outside',
    'datapath=$(appdatapath)\\Game',
    'datapath=$(exepath)\\$(appdatapath)\\Game',
    '\ufeffdatapath="$(exepath)/game-local/saves"',
    'datapath=$(exepath)\\One\ndatapath=$(exepath)\\Two',
  ]) {
    await writeFile(config, value);
    expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'kirikiri' });
  }
  await writeFile(config, 'datapath="$(exepath)/game-local/saves"\r\n');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'kirikiri',
    detectedSaveDirectory: join(folder, 'game-local', 'saves'),
  });
});

function xp3Chunk(name: string, body: Buffer) {
  const header = Buffer.alloc(12);
  header.write(name);
  header.writeBigUInt64LE(BigInt(body.length), 4);
  return Buffer.concat([header, body]);
}

function kagArchive({ protectedConfig = false, invalidIndexSize = false } = {}) {
  const header = Buffer.alloc(19);
  Buffer.from('5850330d0a200a1a8b6701', 'hex').copy(header);
  const scripts = [
    ['startup.tjs', 'Scripts.execStorage("system/Initialize.tjs");'],
    ['system/initialize.tjs', ''],
    [
      'SYSTEM\\Config.tjs',
      'global.config_version = "3";\nSystem.title = "星の小径";\nsaveDataLocation = "Packed Saves";',
    ],
  ] as const;
  const payloads = [header];
  let position = header.length;
  const entries = scripts.map(([path, source], index) => {
    const name = Buffer.from(path, 'utf16le');
    const raw = Buffer.from(source);
    const compressed = index === 2;
    const stored = compressed ? deflateSync(raw) : raw;
    const info = Buffer.alloc(22);
    const segment = Buffer.alloc(28);
    info.writeUInt32LE(compressed && protectedConfig ? 0x80000000 : 0);
    info.writeBigUInt64LE(BigInt(raw.length), 4);
    info.writeBigUInt64LE(BigInt(stored.length), 12);
    info.writeUInt16LE(name.length / 2, 20);
    segment.writeUInt32LE(Number(compressed));
    segment.writeBigUInt64LE(BigInt(position), 4);
    segment.writeBigUInt64LE(BigInt(raw.length), 12);
    segment.writeBigUInt64LE(BigInt(stored.length), 20);
    payloads.push(stored);
    position += stored.length;
    return xp3Chunk(
      'File',
      Buffer.concat([
        xp3Chunk('info', Buffer.concat([info, name])),
        xp3Chunk('segm', segment),
        xp3Chunk('adlr', Buffer.alloc(4)),
      ]),
    );
  });
  const index = Buffer.concat(entries);
  const encoded = deflateSync(index);
  const indexHeader = Buffer.alloc(17);
  indexHeader[0] = 1;
  indexHeader.writeBigUInt64LE(BigInt(encoded.length), 1);
  indexHeader.writeBigUInt64LE(invalidIndexSize ? 1n : BigInt(index.length), 9);
  header.writeBigUInt64LE(BigInt(position), 11);
  const continuation = Buffer.alloc(17);
  continuation[0] = 0x80;
  continuation.writeBigUInt64LE(BigInt(position + continuation.length), 9);
  return Buffer.concat([...payloads, continuation, indexHeader, encoded]);
}

test('reads packed KAG metadata from executable and companion archives in engine order', async () => {
  const { folder, executable, instances } = await fixture();
  const pe = Buffer.alloc(0x400);
  pe.write('MZ');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  pe.writeUInt16LE(1, 0x86);
  pe.writeUInt16LE(0xf0, 0x94);
  pe.writeUInt16LE(0x20b, 0x98);
  pe.writeUInt32LE(0x200, 0x198);
  pe.writeUInt32LE(0x200, 0x19c);
  const archive = join(folder, 'data.xp3');
  const companion = join(folder, 'data.exe');
  const metadata = {
    engine: 'kirikiri',
    title: '星の小径',
    detectedSaveDirectory: join(folder, 'Packed Saves'),
  } as const;
  const attached = Buffer.concat([pe, Buffer.alloc(16), kagArchive()]);
  await writeFile(executable, attached);
  expect(await instances.inspectVisualNovel({ executable })).toEqual(metadata);
  expect((await instances.discoverVisualNovels(folder)).installations[0]?.candidates[0]).toMatchObject({
    executable,
    launchEvidence: 'kirikiri-embedded-xp3',
  });
  await writeFile(companion, kagArchive());
  expect(await instances.inspectVisualNovel({ executable: companion })).toEqual({ engine: 'unknown' });
  await writeFile(executable, pe);
  expect(await instances.inspectVisualNovel({ executable })).toEqual(metadata);
  expect((await instances.discoverVisualNovels(folder)).installations[0]).toMatchObject({ status: 'single' });
  await writeFile(archive, kagArchive());
  expect(await instances.inspectVisualNovel({ executable })).toEqual(metadata);

  await writeFile(join(folder, 'story.cf'), 'datapath=$(exepath)\\Fallback');
  const fallback = { engine: 'kirikiri', detectedSaveDirectory: join(folder, 'Fallback') } as const;
  for (const options of [{ protectedConfig: true }, { invalidIndexSize: true }]) {
    await writeFile(archive, kagArchive(options));
    expect(await instances.inspectVisualNovel({ executable })).toEqual(fallback);
  }
  await writeFile(archive, 'Invalid sidecar');
  await writeFile(executable, attached);
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
});

test('discovers nested installations beside recognized games while skipping their package folders', async () => {
  const { folder, instances } = await fixture();
  const collection = join(folder, 'collection');
  const nested = join(collection, 'Bonus', 'Series two');
  const packed = join(collection, 'KiriKiri');
  const loose = join(packed, 'data');
  const looseContent = join(loose, 'content-data');
  const title = 'Nested Ren’Py release';

  async function renpy(directory: string, name: string, content = 'game') {
    await mkdir(join(directory, content), { recursive: true });
    const executable = join(directory, 'story.exe');
    await writeFile(executable, 'fixture');
    await writeFile(join(directory, content, 'options.rpy'), `define config.name = "${name}"`);
    return executable;
  }

  const parent = await renpy(collection, 'First release', 'launcher/game');
  const child = await renpy(nested, title);
  await mkdir(join(looseContent, 'system'), { recursive: true });
  await writeFile(join(packed, 'story.exe'), 'fixture');
  await writeFile(join(packed, 'data.xp3'), kagArchive());
  await writeFile(join(loose, 'story.exe'), 'fixture');
  await writeFile(join(looseContent, 'startup.tjs'), 'Scripts.execStorage("system/Initialize.tjs");');
  await writeFile(join(looseContent, 'system', 'Initialize.tjs'), '// Fixture');
  await writeFile(
    join(looseContent, 'system', 'Config.tjs'),
    'global.config_version = "3";\nSystem.title = "Standalone KAG";',
  );
  for (const directory of [
    join(collection, 'launcher', 'game', 'helpers'),
    join(collection, 'renpy', 'common'),
    join(collection, 'lib', 'py3-windows-x86_64'),
    join(packed, 'plugin64'),
    join(looseContent, 'helpers'),
  ]) {
    await renpy(directory, 'Package helper');
  }
  const installed = await instances.local({ kind: 'visual-novel', executable: child, name: title });

  const discovery = await instances.discoverVisualNovels(collection);
  expect(discovery.errors).toEqual([]);
  expect(discovery.installations.map(({ directory }) => directory)).toEqual([collection, nested, packed, loose]);
  expect(discovery.installations.map(({ status }) => status)).toEqual(['single', 'single', 'single', 'single']);
  expect(discovery.installations[0]?.candidates[0]).toEqual({
    executable: parent,
    workingDirectory: collection,
    platformMatch: process.platform === 'win32',
    metadata: {
      engine: 'renpy',
      title: 'First release',
      gameSaveDirectory: join(collection, 'launcher', 'game', 'saves'),
    },
  });
  expect(discovery.installations[1]?.candidates[0]).toMatchObject({ instance: { id: installed.id } });
  expect(discovery.installations[2]?.candidates[0]?.metadata.title).toBe('星の小径');
  expect(discovery.installations[3]?.candidates[0]?.metadata.title).toBe('Standalone KAG');
});

test('recommends a Ren’Py entry point for the current platform and preserves ambiguous choices', async () => {
  const { folder, instances } = await fixture();
  const packageFolder = join(folder, 'release');
  const game = join(packageFolder, 'game');
  await mkdir(game, { recursive: true });
  await writeFile(join(game, 'options.rpy'), 'define config.name = "A Novel"');
  const bootstrap = 'def path_to_gamedir(base, name):\n    return base\nrenpy.bootstrap.bootstrap(".")\n';
  const extension = process.platform === 'win32' ? 'exe' : 'sh';
  const otherPlatform = process.platform === 'win32' ? 'sh' : 'exe';
  const entryPoint = join(packageFolder, `Story.${extension}`);
  await writeFile(entryPoint, 'fixture', { mode: 0o755 });
  await writeFile(join(packageFolder, `Story.${otherPlatform}`), 'fixture', { mode: 0o755 });
  await writeFile(join(packageFolder, 'Story.py'), bootstrap, { mode: 0o644 });
  await writeFile(join(packageFolder, `Tools.${extension}`), 'fixture', { mode: 0o755 });
  await writeFile(join(packageFolder, 'Tools.py'), '# A helper script', { mode: 0o644 });
  const discover = async () => (await instances.discoverVisualNovels(packageFolder)).installations[0]!;

  const found = await discover();
  expect(found.status).toBe('multiple');
  expect(found.recommendedExecutable).toBe(entryPoint);
  expect(found.candidates.find(({ executable }) => executable === entryPoint)).toMatchObject({
    platformMatch: true,
    launchEvidence: 'renpy-bootstrap',
  });
  expect(found.candidates.find(({ executable }) => executable === join(packageFolder, 'Story.py'))?.platformMatch).toBe(
    false,
  );
  expect(
    found.candidates.find(({ executable }) => executable === join(packageFolder, `Tools.${extension}`)),
  ).toMatchObject({
    platformMatch: true,
  });
  expect(found.candidates).toHaveLength(5);

  await writeFile(join(packageFolder, 'Tools.py'), bootstrap);
  expect((await discover()).recommendedExecutable).toBeUndefined();
  await writeFile(join(packageFolder, 'Tools.py'), '# A helper script');
  await instances.local({ kind: 'visual-novel', executable: entryPoint, name: 'A Novel' });
  expect((await discover()).recommendedExecutable).toBeUndefined();
});

test('moves portable visual novel saves between detected and selected locations through a current preview', async () => {
  const { folder } = await fixture();
  const launcher = createLauncher({
    dataDir: join(folder, 'launcher'),
    catalogUrl: 'https://api.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async () => {},
  });
  const source = join(folder, 'source');
  const receiving = join(folder, 'receiving');
  const portable = join(folder, 'portable');
  const archive = Buffer.alloc(20);
  Buffer.from('5850330d0a200a1a8b6701', 'hex').copy(archive);
  archive.writeBigUInt64LE(19n, 11);
  await mkdir(portable);
  for (const installation of [source, receiving]) {
    await mkdir(join(installation, 'game', 'saves'), { recursive: true });
    await writeFile(join(installation, 'novel.exe'), 'fixture');
    await writeFile(join(installation, 'data.xp3'), archive);
    await writeFile(join(installation, 'novel.cf'), 'datapath=$(exepath)\\Auto');
    await mkdir(join(installation, 'Auto'));
  }
  await writeFile(join(source, 'Auto', 'slot.ksd'), 'KAG progress');
  await writeFile(join(source, 'game', 'saves', 'settings'), 'Keep in the backup');
  await writeFile(join(receiving, 'Auto', 'slot.ksd'), 'Keep detected save');
  await writeFile(join(receiving, 'game', 'saves', 'settings'), 'Keep receiving settings');
  const manual = join(receiving, 'Manual');
  await mkdir(manual);
  await writeFile(join(manual, 'slot.ksd'), 'Original manual save');

  const old = await launcher.importInstance({
    kind: 'visual-novel',
    name: 'Old',
    executable: join(source, 'novel.exe'),
  });
  const next = await launcher.importInstance({
    kind: 'visual-novel',
    name: 'New',
    executable: join(receiving, 'novel.exe'),
    saveDirectory: manual,
  });
  const backup = await launcher.createSnapshot(old.id, 'Original');
  const bundle = await launcher.exportSnapshot(old.id, backup.id, portable);
  const imported = await launcher.importSnapshot(next.id, bundle);
  expect(await launcher.previewRestore(next.id, imported.id)).toMatchObject({
    targets: [],
    visualNovel: { choices: [], destinations: [{ id: 'selected', path: manual }] },
  });
  expect(await readFile(join(manual, 'slot.ksd'), 'utf8')).toBe('Original manual save');
  await expect(
    launcher.previewRestore(next.id, imported.id, [
      { sourceId: 'game', targetId: 'selected' },
      { sourceId: 'kirikiri', targetId: 'selected' },
    ]),
  ).rejects.toThrow('different destination');
  const transfer: VisualNovelRestoreChoice[] = [
    { sourceId: 'game', targetId: null },
    { sourceId: 'kirikiri', targetId: 'selected' },
  ];
  const review = async () => (await launcher.previewRestore(next.id, imported.id, transfer)).review!;
  const stale = await review();
  await rename(manual, join(receiving, 'Earlier'));
  await mkdir(manual);
  await writeFile(join(manual, 'slot.ksd'), 'Replacement manual save');
  await expect(launcher.restoreSnapshot(next.id, imported.id, undefined, stale)).rejects.toThrow(
    'destinations changed',
  );
  expect(await readFile(join(manual, 'slot.ksd'), 'utf8')).toBe('Replacement manual save');
  expect(await launcher.listSnapshots(next.id)).toEqual([imported]);
  await launcher.restoreSnapshot(next.id, imported.id, undefined, await review());
  expect(await readFile(join(manual, 'slot.ksd'), 'utf8')).toBe('KAG progress');
  expect(await readFile(join(receiving, 'game', 'saves', 'settings'), 'utf8')).toBe('Keep receiving settings');
  const rescue = (await launcher.listSnapshots(next.id)).find(({ label }) => label === 'Before restore')!;
  const rescueBundle = await launcher.exportSnapshot(next.id, rescue.id, portable);
  expect(await readFile(join(rescueBundle, 'data', 'selected', 'slot.ksd'), 'utf8')).toBe('Replacement manual save');
  expect(await readFile(join(bundle, 'data', 'game', 'settings'), 'utf8')).toBe('Keep in the backup');

  await launcher.updateVisualNovelSettings(next.id, { saveDirectory: null });
  const relocated = await launcher.importSnapshot(next.id, rescueBundle);
  const automatic: VisualNovelRestoreChoice[] = [{ sourceId: 'selected', targetId: 'kirikiri' }];
  const originalPlan = await launcher.previewRestore(next.id, relocated.id, automatic);
  expect(originalPlan.targets[0]?.path).toBe(join(receiving, 'Auto'));
  await writeFile(join(receiving, 'novel.cf'), 'datapath=$(exepath)\\Relocated');
  await expect(launcher.restoreSnapshot(next.id, relocated.id, undefined, originalPlan.review)).rejects.toThrow(
    'destinations changed',
  );
  const latest = await launcher.previewRestore(next.id, relocated.id, automatic);
  expect(latest.targets[0]?.path).toBe(join(receiving, 'Relocated'));
  await launcher.restoreSnapshot(next.id, relocated.id, undefined, latest.review);
  expect(await readFile(join(receiving, 'Relocated', 'slot.ksd'), 'utf8')).toBe('Replacement manual save');
  expect(await readFile(join(receiving, 'Auto', 'slot.ksd'), 'utf8')).toBe('Keep detected save');
  expect(await readFile(join(source, 'Auto', 'slot.ksd'), 'utf8')).toBe('KAG progress');
});

test.skipIf(process.platform === 'win32')('ignores linked KAG save paths and linked XP3 archives', async () => {
  const { folder, executable, instances } = await fixture();
  const data = join(folder, 'content-data');
  const config = join(data, 'system', 'Config.tjs');
  await mkdir(join(data, 'system'), { recursive: true });
  await writeFile(join(data, 'startup.tjs'), 'Scripts.execStorage("system/Initialize.tjs");');
  await writeFile(join(data, 'system', 'Initialize.tjs'), '// Fixture');
  await writeFile(config, ';global.config_version = "3.32 stable";\n;saveDataLocation = "linked/saves";');
  await symlink(data, join(folder, 'linked'), 'dir');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'kirikiri' });
  await writeFile(config, ';global.config_version = "3.32 stable";\n;saveDataLocation = "local/saves";');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'kirikiri',
    detectedSaveDirectory: join(folder, 'local', 'saves'),
  });
  await rm(data, { recursive: true });
  const archive = Buffer.alloc(24);
  Buffer.from('5850330d0a200a1a8b6701', 'hex').copy(archive);
  archive.writeBigUInt64LE(19n, 11);
  await writeFile(join(folder, 'other.xp3'), archive);
  await symlink(join(folder, 'other.xp3'), join(folder, 'data.xp3'), 'file');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
});

test('relinks a moved visual novel while retaining its instance and save history', async () => {
  const { folder } = await fixture();
  const launcherData = join(folder, 'launcher');
  const opened: string[] = [];
  const launcher = createLauncher({
    dataDir: launcherData,
    catalogUrl: 'https://api.example.invalid',
    webUrl: 'https://rezics.example.invalid',
    launcherVersion: '0.1.0',
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  const old = join(folder, 'old-install');
  const next = join(folder, 'moved-install');
  const originalSubject = '018943aa-abcd-4abc-9abc-0123456789ab';
  const newSubject = '018943aa-abcd-4abc-9abc-0123456789ac';
  await mkdir(join(old, 'game'), { recursive: true });
  await mkdir(join(old, 'saves'));
  await writeFile(join(old, 'story.exe'), 'fixture');
  await writeFile(join(old, 'game', 'options.rpy'), 'define config.version = "1.2.0"');
  await writeFile(join(old, 'saves', 'slot'), 'original');
  const original = await launcher.importInstance({
    kind: 'visual-novel',
    name: 'Original',
    executable: join(old, 'story.exe'),
    saveDirectory: join(old, 'saves'),
    subjectId: originalSubject,
  });
  const backup = await launcher.createSnapshot(original.id, 'Before the move');
  await rename(old, next);
  await expect(launcher.launch(original.id)).rejects.toThrow('executable');
  expect(await launcher.readLaunchReport(original.id)).toMatchObject({
    issue: { kind: 'executable', action: 'settings' },
  });
  await expect(launcher.updateVisualNovelSettings(original.id, { saveDirectory: launcherData })).rejects.toThrow(
    'outside',
  );
  expect(await launcher.listInstances()).toEqual([original]);

  const updated = await launcher.updateVisualNovelSettings(original.id, {
    name: 'Moved VN',
    executable: join(next, 'story.exe'),
    saveDirectory: join(next, 'saves'),
    subjectId: newSubject,
  });
  expect(updated).toEqual({ ...original, name: 'Moved VN', subjectId: newSubject });
  expect(await launcher.readVisualNovelSettings(original.id)).toEqual({
    name: 'Moved VN',
    executable: join(next, 'story.exe'),
    saveDirectory: join(next, 'saves'),
    subjectId: newSubject,
    revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
    metadata: { engine: 'renpy', version: '1.2.0', gameSaveDirectory: join(next, 'game', 'saves') },
  });
  await launcher.openGameInfo(original.id);
  expect(opened).toEqual([`https://rezics.example.invalid/subjects/${newSubject}`]);
  await writeFile(join(next, 'saves', 'slot'), 'later');
  expect((await launcher.previewRestore(original.id, backup.id)).targets[0]?.path).toBe(join(next, 'saves'));
  await launcher.restoreSnapshot(original.id, backup.id);
  expect(await readFile(join(next, 'saves', 'slot'), 'utf8')).toBe('original');
  await launcher.updateVisualNovelSettings(original.id, { subjectId: null, saveDirectory: null });
  expect(await launcher.listInstances()).toEqual([{ id: original.id, kind: 'visual-novel', name: 'Moved VN' }]);
  expect((await launcher.listSnapshots(original.id)).map(({ id }) => id)).toContain(backup.id);
});

test.skipIf(process.platform === 'win32')('does not follow linked Ren’Py metadata files or folders', async () => {
  const { folder, executable, instances } = await fixture();
  const other = join(folder, 'other');
  await mkdir(other);
  await writeFile(join(other, 'options.rpy'), 'define config.name = "Other game"\n');
  const game = join(folder, 'game');
  await symlink(other, game, 'dir');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });
  await mkdir(join(folder, 'renpy', 'common'), { recursive: true });
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'renpy' });
  await rm(join(folder, 'renpy'), { recursive: true });

  await rm(game);
  await mkdir(game);
  await symlink(join(other, 'options.rpy'), join(game, 'options.rpy'), 'file');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({ engine: 'unknown' });

  await writeFile(join(game, 'options.rpyc'), 'compiled marker');
  const build = join(other, 'build_info.json');
  await writeFile(build, JSON.stringify({ name: 'Outside game', version: '4.5' }));
  await symlink(other, join(game, 'cache'), 'dir');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    gameSaveDirectory: join(game, 'saves'),
  });
  await rm(join(game, 'cache'));
  await mkdir(join(game, 'cache'));
  await symlink(build, join(game, 'cache', 'build_info.json'), 'file');
  expect(await instances.inspectVisualNovel({ executable })).toEqual({
    engine: 'renpy',
    gameSaveDirectory: join(game, 'saves'),
  });
});
