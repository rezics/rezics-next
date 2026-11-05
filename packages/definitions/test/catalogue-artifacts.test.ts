import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCatalogue } from '../src/compile.ts';
import { releaseDigest, validateRelease, publicationLimits, RELEASE_LIMITS, type Release } from '../src/index.ts';
import historical from './fixtures/bundled-historical-construction.json';
import {
  buildCatalogue,
  lookupCatalogueKind,
  verifyCatalogue,
  compatibilityKind,
  catalogueBytes,
  catalogueDigest,
  parseCatalogueJson,
  parseKindDeclaration,
  parseCatalogueNode,
  KIND_FORMAT,
  CATALOGUE_NODE_FORMAT,
  CATALOGUE_FORMAT,
  KIND_REDUCTION,
  type CatalogueArtifactReader,
  type CatalogueNodeV1,
  type CatalogueRootV2,
  type KindCataloguePin,
} from '../src/catalogue-artifacts.ts';
import { publishCatalogueRoot, readCatalogueRootFile } from '../src/catalogue-files.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const workspace = join(root, 'packages/definitions');
async function cli(...args: string[]) {
  const process = Bun.spawn([Bun.which('bun')!, 'run', '--cwd', workspace, 'catalogue', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
async function authoredRelease(shard: number): Promise<Release> {
  const classes: Record<string, object> = {};
  const labels: Record<string, string> = {};
  for (let i = 0; i < 384; i++) {
    const local = `T${String(shard * 384 + i).padStart(4, '0')}`;
    classes[local] = {
      class_uri: `scale:${local}`,
      annotations: {
        library: { id: 'fixture.catalogue' },
        list_presentation: { imageAspect: 'square', keyFacts: [] },
      },
    };
    labels[`scale:${local}`] = `Type ${local}`;
  }
  return compileCatalogue({
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: `https://catalogue.example/shard/${shard}`,
        name: `shard${shard}`,
        version: '1',
        prefixes: { scale: 'https://catalogue.example/types/', linkml: 'https://w3id.org/linkml/' },
        imports: ['linkml:types'],
        classes,
        slots: {},
      }),
    },
    presentation: { en: JSON.stringify({ types: labels, properties: {} }) },
  });
}

// One authored regression owns the complete real package journey, its bounded selected read and refusal matrix.
// It is intentionally not a native, authority, browser or whole-Goal proof.
test('Definition authors build and verify more than 1024 Types, resolve a noninitial exact Kind and retain original release/profile pins', async () => {
  await mkdir(join(root, '.temp'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.temp/catalogue-artifacts-'));
  try {
    const releases: Release[] = [await authoredRelease(0), await authoredRelease(1), await authoredRelease(2)];
    expect(validateRelease(historical)).toEqual([]);
    for (const release of releases) {
      expect(validateRelease(release)).toEqual([]);
      expect(Object.keys(release.types).length).toBeLessThanOrEqual(RELEASE_LIMITS.types);
    }
    const historicBytes = catalogueBytes(historical);
    const historicDigest = catalogueDigest(historicBytes);
    const paths: string[] = [];
    for (let i = 0; i < releases.length; i++) {
      paths.push(`release-${i}.json`);
      await writeFile(join(temporary, paths.at(-1)!), JSON.stringify(releases[i], null, 2));
    }
    paths.push('historical.json');
    await writeFile(join(temporary, 'historical.json'), JSON.stringify(historical));
    const selected = releases[2]!;
    const selectedDigest = releaseDigest(selected);
    const selectedId = 'scale:T1151';
    // A custom Kind proves stable Kind, condition Type and presentation Type are independently pinned.
    const custom = {
      ...compatibilityKind(selected, selectedDigest, selectedId),
      id: 'kind:Featured',
      auto: { eligible: false, precedence: -2147483648 },
      presentation: { type: { releaseDigest: releaseDigest(releases[0]!), typeId: 'scale:T0000' } },
    };
    await writeFile(join(temporary, 'kind.json'), JSON.stringify(custom));
    await writeFile(
      join(temporary, 'inputs.json'),
      JSON.stringify({ releases: paths, declarations: ['kind.json'], compatibility: 'all' }),
    );
    const output = join(temporary, 'output');
    const built = await cli('build', '--input', join(temporary, 'inputs.json'), '--output', output);
    expect(built.stderr.includes('catalogue:')).toBe(false);
    expect(built.code, built.stderr).toBe(0);
    const rootFile = join(output, 'root.json');
    const { pin, store } = await readCatalogueRootFile(rootFile);
    const verified = await cli('verify', '--root', rootFile);
    expect(verified.code, verified.stderr).toBe(0);
    const report = await verifyCatalogue(pin, store);
    const total = releases.reduce((n, r) => n + Object.keys(r.types).length, Object.keys(historical.types).length);
    expect(total).toBeGreaterThan(1024);
    expect(report.declarations).toBe(total + 1);
    expect(report.releases).toBe(4);
    expect(report.nodes).toBeGreaterThan(4);
    expect(await store.read(historicDigest)).toEqual(historicBytes);
    const oldId = Object.entries(historical.types).find(([, type]) => !Object.hasOwn(type, 'library'))![0];
    const old = await lookupCatalogueKind(pin, oldId, store);
    expect(old.status).toBe('found');
    if (old.status !== 'found') throw new Error('Historical exact Kind absent');
    expect(catalogueBytes(old.presentation.release)).toEqual(historicBytes);
    expect(old.presentation.pin.releaseDigest).toBe(historicDigest);
    expect(old.presentation.library).toBeNull(); // Unknown stays unknown; never manufacture a legacy/no-profile pin.

    const reads: string[] = [];
    const reader: CatalogueArtifactReader = {
      async read(digest) {
        reads.push(digest);
        return store.read(digest);
      },
    };
    const found = await lookupCatalogueKind(pin, selectedId, reader);
    expect(found.status).toBe('found');
    if (found.status !== 'found') throw new Error('Selected noninitial Kind absent');
    expect(found.catalogue).toEqual(pin);
    expect(found.declaration.id).toBe(selectedId);
    expect(found.declarationDigest).toBe(catalogueDigest(catalogueBytes(found.declaration)));
    expect(found.presentation.release).toEqual(selected);
    expect(found.condition.pin).toEqual({ releaseDigest: selectedDigest, typeId: selectedId });
    expect(found.presentation.listPresentation).toEqual({ imageAspect: 'square', keyFacts: [] });
    expect(found.presentation.library?.pin).toEqual({
      provenance: 'profile',
      releaseDigest: selectedDigest,
      acceptingType: selectedId,
      profileId: 'fixture.catalogue',
    });
    expect(found.presentation.library?.profile).toEqual(selected.libraryProfiles!['fixture.catalogue']);
    expect(reads.length).toBeLessThanOrEqual(9); // Root + two height-two addressed paths + declaration + one Release.
    expect(reads).not.toContain(releaseDigest(releases[0]!));
    expect(reads).not.toContain(releaseDigest(releases[1]!));
    expect(reads).not.toContain(historicDigest);
    const absent = await lookupCatalogueKind(pin, 'scale:Absent', store);
    expect(absent.status).toBe('not-found');
    expect((await lookupCatalogueKind(pin, selectedId.toLowerCase(), store)).status).toBe('not-found');
    const customFound = await lookupCatalogueKind(pin, custom.id, store);
    expect(customFound.status).toBe('found');
    if (customFound.status !== 'found') throw new Error('Custom Kind absent');
    expect(customFound.condition.pin.typeId).toBe(selectedId);
    expect(customFound.presentation.pin.typeId).toBe('scale:T0000');
    const cliFound = await cli('lookup', '--root', rootFile, '--id', selectedId);
    expect(cliFound.code, cliFound.stderr).toBe(0);
    expect(JSON.parse(cliFound.stdout).presentation.pin.releaseDigest).toBe(selectedDigest);
    expect((await cli('lookup', '--root', rootFile, '--id', 'scale:Absent')).code).toBe(2);

    const firstRoot = await readFile(rootFile);
    const firstObjects = (await readdir(join(output, 'objects'))).sort();
    await writeFile(
      join(temporary, 'reversed.json'),
      JSON.stringify({ releases: [...paths].reverse(), declarations: ['kind.json'], compatibility: 'all' }),
    );
    const repeated = await cli('build', '--input', join(temporary, 'reversed.json'), '--output', output);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(await readFile(rootFile)).toEqual(firstRoot);
    expect((await readdir(join(output, 'objects'))).sort()).toEqual(firstObjects);

    // Re-address malformed artifacts so version/schema/closure checks, not only hash mismatches, must reject.
    async function storeValue(value: unknown) {
      const bytes = catalogueBytes(value),
        digest = catalogueDigest(bytes);
      await store.put(digest, bytes);
      return digest;
    }
    const rootValue = parseCatalogueJson((await store.read(pin.rootDigest))!, 262144) as CatalogueRootV2;
    const nodeValue = parseCatalogueJson((await store.read(rootValue.directoryDigest))!, 262144) as CatalogueNodeV1;
    async function withDirectory(value: unknown): Promise<KindCataloguePin> {
      const directoryDigest = await storeValue(value);
      return { ...pin, rootDigest: await storeValue({ ...rootValue, directoryDigest }) };
    }
    const badVersion = {
      ...pin,
      rootDigest: await storeValue({ ...rootValue, format: 'https://rezics.com/definitions/catalogue/3' }),
    };
    await expect(verifyCatalogue(badVersion, store)).rejects.toThrow('version');
    await expect(
      verifyCatalogue(
        await withDirectory({ ...nodeValue, format: 'https://rezics.com/definitions/catalogue-node/2' }),
        store,
      ),
    ).rejects.toThrow('version');
    await expect(verifyCatalogue({ ...pin, rootDigest: `sha256:${'A'.repeat(64)}` }, store)).rejects.toThrow('digest');
    const corrupt: CatalogueArtifactReader = {
      async read(digest) {
        return digest === selectedDigest ? new TextEncoder().encode('{}') : store.read(digest);
      },
    };
    await expect(verifyCatalogue(pin, corrupt)).rejects.toThrow('Corrupt');
    await expect(lookupCatalogueKind(pin, selectedId, corrupt)).rejects.toThrow('Corrupt');
    const missing: CatalogueArtifactReader = {
      async read(digest) {
        return digest === selectedDigest ? undefined : store.read(digest);
      },
    };
    await expect(verifyCatalogue(pin, missing)).rejects.toThrow('Missing artifact');
    await expect(lookupCatalogueKind(pin, selectedId, missing)).rejects.toThrow('Missing artifact');
    const missingDeclaration: CatalogueArtifactReader = {
      async read(digest) {
        return digest === found.declarationDigest ? undefined : store.read(digest);
      },
    };
    await expect(verifyCatalogue(pin, missingDeclaration)).rejects.toThrow('Missing artifact');
    const missingNode: CatalogueArtifactReader = {
      async read(digest) {
        return digest === rootValue.directoryDigest ? undefined : store.read(digest);
      },
    };
    await expect(verifyCatalogue(pin, missingNode)).rejects.toThrow('Missing artifact');
    await expect(publishCatalogueRoot(output, badVersion)).rejects.toThrow();
    expect(await readFile(rootFile)).toEqual(firstRoot); // Failed/incomplete build cannot replace the previous complete pin.
    const leaf = {
      format: CATALOGUE_NODE_FORMAT,
      node: 'leaf',
      entries: [{ key: `declaration:${selectedId}`, kind: 'declaration', digest: found.declarationDigest }],
    };
    await expect(verifyCatalogue(await withDirectory(leaf), store)).rejects.toThrow('no Release1');
    const unclosed = await storeValue({
      ...custom,
      condition: { op: 'exact-type', type: { releaseDigest: `sha256:${'0'.repeat(64)}`, typeId: selectedId } },
    });
    await expect(
      verifyCatalogue(
        await withDirectory({
          format: CATALOGUE_NODE_FORMAT,
          node: 'leaf',
          entries: [
            { key: `declaration:${custom.id}`, kind: 'declaration', digest: unclosed },
            { key: `release:${selectedDigest}`, kind: 'release', digest: selectedDigest },
          ],
        }),
        store,
      ),
    ).rejects.toThrow('Missing exact release closure');
    if (nodeValue.node !== 'branch') throw new Error('Expected segmented catalogue');
    await expect(
      verifyCatalogue(await withDirectory({ ...nodeValue, children: [...nodeValue.children].reverse() }), store),
    ).rejects.toThrow('sorted');
    const badRange = nodeValue.children.map((c, i) => (i === 0 ? { ...c, first: 'declaration:a:A' } : c));
    await expect(verifyCatalogue(await withDirectory({ ...nodeValue, children: badRange }), store)).rejects.toThrow(
      'range',
    );
    expect(() => parseCatalogueNode({ ...leaf, entries: [leaf.entries[0], leaf.entries[0]] })).toThrow('sorted');
    expect(() => parseCatalogueJson(new TextEncoder().encode('{"format":1,"for\\u006dat":2}'), 1024)).toThrow(
      'duplicate-key',
    );
    expect(() => parseKindDeclaration({ ...custom, format: `${KIND_FORMAT}0` })).toThrow('version');
    expect(() => parseKindDeclaration({ ...custom, extra: true })).toThrow('closed');
    expect(() => parseKindDeclaration({ ...custom, auto: { eligible: true, precedence: 2147483648 } })).toThrow();
    expect(() => parseKindDeclaration({ ...custom, labels: { en: 'x'.repeat(257) } })).toThrow();
    let accessorReads = 0;
    const accessor = { ...custom };
    Object.defineProperty(accessor, 'labels', {
      enumerable: true,
      get() {
        accessorReads++;
        return { en: 'bad' };
      },
    });
    expect(() => parseKindDeclaration(accessor)).toThrow('inert');
    expect(accessorReads).toBe(0);
    const filter = {
      ...custom,
      condition: {
        op: 'filter',
        language: 'https://rezics.com/filter/1',
        document: { type: { in: [selectedId] } },
        vocabulary: { types: [{ releaseDigest: selectedDigest, typeId: selectedId }], properties: [] },
      },
    };
    expect(parseKindDeclaration(filter).condition.op).toBe('filter');
    await expect(buildCatalogue({ releases: [selected], declarations: [filter] }, store)).rejects.toThrow(
      'actual native producer',
    );
    expect(() =>
      parseKindDeclaration({
        ...filter,
        condition: {
          ...filter.condition,
          vocabulary: {
            ...filter.condition.vocabulary,
            types: [...filter.condition.vocabulary.types, ...filter.condition.vocabulary.types],
          },
        },
      }),
    ).toThrow('Repeated');
    expect(() =>
      parseKindDeclaration({ ...filter, condition: { ...filter.condition, document: { kind: { in: [custom.id] } } } }),
    ).toThrow();
    expect(() =>
      parseKindDeclaration({
        ...filter,
        condition: { ...filter.condition, document: { type: { in: Array(65).fill(selectedId) } } },
      }),
    ).toThrow();
    const badReleaseVersion = { ...selected, format: 'https://rezics.com/definitions/release/2' };
    await expect(buildCatalogue({ releases: [badReleaseVersion] }, store)).rejects.toThrow('Invalid Release1');
    const historicalConstruction = structuredClone(selected);
    historicalConstruction.catalogue.version = 'historical-construction';
    historicalConstruction.types[selectedId]!.mappings = Array.from(
      { length: 257 },
      (_, i) => `scale:M${String(i).padStart(4, '0')}`,
    );
    expect(validateRelease(historicalConstruction)).toEqual([]);
    expect(publicationLimits(historicalConstruction)).not.toEqual([]);
    const historicalPin = await buildCatalogue(
      {
        releases: [historicalConstruction],
        compatibility: [{ releaseDigest: releaseDigest(historicalConstruction), typeId: selectedId }],
      },
      store,
    );
    expect((await verifyCatalogue(historicalPin, store)).declarations).toBe(1);
    const badProfile = structuredClone(selected);
    delete badProfile.libraryProfiles;
    await expect(buildCatalogue({ releases: [badProfile], compatibility: 'all' }, store)).rejects.toThrow(
      'Invalid Release1',
    );
    const conflicting = structuredClone(selected);
    conflicting.catalogue.version = '2';
    conflicting.types[selectedId]!.labels.en = 'Changed identity';
    await expect(buildCatalogue({ releases: [selected, conflicting] }, store)).rejects.toThrow(
      'Conflicting repeated identity',
    );
    await expect(buildCatalogue({ releases: [selected, selected] }, store)).rejects.toThrow('Duplicate typed key');
    await expect(buildCatalogue({ releases: [selected], declarations: [custom, custom] }, store)).rejects.toThrow(
      'Duplicate typed key',
    );
    const objectFile = join(output, 'objects', `${selectedDigest.slice(7)}.json`);
    const original = await readFile(objectFile);
    try {
      await writeFile(objectFile, '{}');
      await expect(buildCatalogue({ releases: [selected] }, store)).rejects.toThrow('Conflicting stored bytes');
      expect(await readFile(rootFile)).toEqual(firstRoot);
    } finally {
      await writeFile(objectFile, original);
    }
    // Pin format remains closed and binds exact spec/reduction independently of directory content.
    await expect(
      verifyCatalogue({ ...pin, reduction: `${KIND_REDUCTION}0` } as unknown as KindCataloguePin, store),
    ).rejects.toThrow('version');
    expect(pin.format).toBe(CATALOGUE_FORMAT);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);
