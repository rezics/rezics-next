import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { readFileSync } from 'node:fs';
import { verticalProfile } from '../../../services/kernel/test/support/manifests.ts';
import { bundledDigest, bundledRelease, bundledSources } from '../src/bundled.ts';
import { CatalogueError, compileCatalogue } from '../src/compile.ts';
import { RELEASE_LIMITS, releaseDigest, validateRelease, type LibraryProfilePin, type Release } from '../src/index.ts';
import { validateLibraryProfileSource } from '../src/library-profile.ts';
import { fixture, libraryProfile, sourcesFor } from './support/library-profiles.ts';

const selection = { imageAspect: 'portrait', keyFacts: ['schema:datePublished'] };
function inputWith(hint: unknown = selection) {
  const schema = {
    id: 'https://example.org/lists',
    name: 'lists',
    version: '1',
    prefixes: { linkml: 'https://w3id.org/linkml/', schema: 'http://schema.org/' },
    imports: ['linkml:types'],
    classes: {
      Base: {
        abstract: true,
        slots: ['published', 'code', 'text', 'document', 'media', 'identifier', 'item', 'amount'],
        annotations: { list_presentation: hint },
      },
      Bridge: { abstract: true, is_a: 'Base' },
      Book: {
        class_uri: 'schema:Book',
        is_a: 'Bridge',
        annotations: { cover_ratio: '5:7', schema_org_type: 'https://schema.org/Book' },
      },
      Other: { class_uri: 'schema:Other' },
    },
    slots: {
      published: { slot_uri: 'schema:datePublished', range: 'date', annotations: { datatype: 'time' } },
      code: { slot_uri: 'schema:code', range: 'string', pattern: '^[A-Z]{2}$', annotations: { datatype: 'string' } },
      text: { slot_uri: 'schema:text', range: 'string', annotations: { datatype: 'string' } },
      document: { slot_uri: 'schema:abstract', range: 'string', annotations: { datatype: 'document' } },
      media: { slot_uri: 'schema:image', range: 'string', annotations: { datatype: 'media' } },
      identifier: {
        slot_uri: 'schema:identifier',
        range: 'string',
        exact_mappings: ['wd:P1'],
        annotations: { datatype: 'external-id' },
      },
      item: { slot_uri: 'schema:about', range: 'Other', annotations: { datatype: 'wikibase-item' } },
      amount: { slot_uri: 'schema:amount', range: 'integer', annotations: { datatype: 'quantity', units: '1' } },
      foreign: { slot_uri: 'schema:foreign', range: 'date', annotations: { datatype: 'time' } },
    },
  };
  // Only this fixture's external-id mapping needs Wikidata.
  Object.assign(schema.prefixes, { wd: 'http://www.wikidata.org/entity/' });
  return {
    root: 'lists.yaml',
    schemas: { 'lists.yaml': JSON.stringify(schema) },
    presentation: { 'lists/en': 'types:\n  schema:Book: book\n  schema:Other: other\n' },
  };
}
async function errors(input: Parameters<typeof compileCatalogue>[0]) {
  try {
    await compileCatalogue(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueError);
    return (error as CatalogueError).violations;
  }
  throw new Error('Invalid list presentation compiled');
}

const invalid: [string, unknown, string][] = [
  ['null', null, ''],
  ['array', [], ''],
  ['missing frame', { keyFacts: [] }, '/imageAspect'],
  ['missing facts', { imageAspect: 'portrait' }, '/keyFacts'],
  ['ratio', { imageAspect: '3:4', keyFacts: [] }, '/imageAspect'],
  ['nonarray', { imageAspect: 'portrait', keyFacts: 'schema:datePublished' }, '/keyFacts'],
  ['nonstring', { imageAspect: 'portrait', keyFacts: [42] }, '/keyFacts/0'],
  ['duplicate', { imageAspect: 'portrait', keyFacts: ['schema:datePublished', 'schema:datePublished'] }, '/keyFacts/1'],
  [
    'limit',
    {
      imageAspect: 'portrait',
      keyFacts: ['schema:datePublished', 'schema:code', 'schema:about', 'schema:amount', 'schema:foreign'],
    },
    '/keyFacts',
  ],
  ['unknown property', { imageAspect: 'portrait', keyFacts: ['schema:missing'] }, '/keyFacts/0'],
  ['out of type', { imageAspect: 'portrait', keyFacts: ['schema:foreign'] }, '/keyFacts/0'],
  ['free text', { imageAspect: 'portrait', keyFacts: ['schema:text'] }, '/keyFacts/0'],
  ['document', { imageAspect: 'portrait', keyFacts: ['schema:abstract'] }, '/keyFacts/0'],
  ['media', { imageAspect: 'portrait', keyFacts: ['schema:image'] }, '/keyFacts/0'],
  ['external identifier', { imageAspect: 'portrait', keyFacts: ['schema:identifier'] }, '/keyFacts/0'],
  ['undeclared prefix', { imageAspect: 'portrait', keyFacts: ['private:field'] }, '/keyFacts/0'],
  ['formatter', { ...selection, formatter: 'eval' }, '/formatter'],
  ['private library field', { ...selection, library: {} }, '/library'],
];

test('compiler transports all four existing Fact kinds in author order and retains ordinary annotations', async () => {
  const input = inputWith({
    imageAspect: 'square',
    keyFacts: ['schema:code', 'schema:datePublished', 'schema:about', 'schema:amount'],
  });
  const before = structuredClone(input);
  const release = await compileCatalogue(input);
  expect(validateRelease(release)).toEqual([]);
  expect(release.types['schema:Book']!.listPresentation).toEqual({
    imageAspect: 'square',
    keyFacts: ['schema:code', 'schema:datePublished', 'schema:about', 'schema:amount'],
  });
  expect(release.types['schema:Book']!.coverRatio).toBe('5:7');
  expect(release.types['schema:Book']!.schemaOrgType).toBe('https://schema.org/Book');
  expect(release.types['schema:Other']!.listPresentation).toBeUndefined();
  expect(input).toEqual(before);
  const source = JSON.parse(input.schemas['lists.yaml']);
  source.classes.Book.is_a = 'NoSuchBase';
  input.schemas['lists.yaml'] = JSON.stringify(source);
  expect((await errors(input)).some((error) => error.code === 'linkml')).toBe(true);
});

test.each(invalid)('compiler rejects %s at the authored source pointer', async (_name, hint, suffix) => {
  expect(await errors(inputWith(hint))).toContainEqual(
    expect.objectContaining({
      file: 'lists.yaml',
      pointer: `/classes/Base/annotations/list_presentation${suffix}`,
    }),
  );
});

test('unused abstract declarations cannot hide invalid property references', async () => {
  const input = inputWith();
  const schema = JSON.parse(input.schemas['lists.yaml']);
  schema.classes.Unused = { abstract: true, annotations: { list_presentation: selection } };
  input.schemas['lists.yaml'] = JSON.stringify(schema);
  expect(await errors(input)).toContainEqual(
    expect.objectContaining({
      file: 'lists.yaml',
      pointer: '/classes/Unused/annotations/list_presentation/keyFacts/0',
    }),
  );
});

test('release validation reports closed hints and effective property failures with real release pointers', async () => {
  const base = await compileCatalogue(inputWith());
  for (const [name, hint, suffix] of invalid) {
    const release = structuredClone(base);
    Reflect.set(release.types['schema:Book']!, 'listPresentation', hint);
    const failures = validateRelease(release);
    expect(failures.length, name).toBeGreaterThan(0);
    // Native schema diagnostic budget may report the collection for uniqueness;
    // semantic references retain the exact selected property index.
    const expected = `/types/schema:Book/listPresentation${name === 'duplicate' ? '/keyFacts' : suffix}`;
    expect(
      failures.some(({ pointer }) => pointer === expected),
      `${name}: ${JSON.stringify(failures)}`,
    ).toBe(true);
  }
});

function withoutHints(release: Release) {
  const copy = structuredClone(release);
  for (const type of Object.values(copy.types)) delete type.listPresentation;
  return copy;
}
function growing(count: number, hints: boolean) {
  const input = sourcesFor(count, true);
  for (let i = 0; i < count; i++) {
    const v = verticalProfile(i);
    const schema = Bun.YAML.parse(input.schemas[v.schema]!) as Record<string, any>;
    const work = schema.classes[`V${i}Work`];
    schema.classes[`V${i}Base`] = {
      abstract: true,
      is_a: work.is_a,
      slots: work.slots,
      ...(hints
        ? { annotations: { list_presentation: { imageAspect: 'portrait', keyFacts: [v.published, v.cast, v.count] } } }
        : {}),
    };
    work.is_a = `V${i}Base`;
    schema.classes[`V${i}Edition`].is_a = `V${i}Base`;
    if (hints)
      schema.classes[`V${i}Edition`].annotations = {
        ...schema.classes[`V${i}Edition`].annotations,
        list_presentation: { imageAspect: 'landscape', keyFacts: [] },
      };
    input.schemas[v.schema] = JSON.stringify(schema);
  }
  return input;
}

test('ten and one hundred complete manifests retain inheritance clearing profiles bytes and invalid-reference admission', async () => {
  for (const count of [10, 100]) {
    const input = growing(count, true);
    const plain = await compileCatalogue(growing(count, false));
    const release = await compileCatalogue(input);
    expect(validateRelease(release)).toEqual([]);
    expect(withoutHints(release)).toEqual(withoutHints(plain));
    expect(Object.keys(release.types)).toHaveLength(Object.keys(bundledRelease.types).length + count * 3);
    expect(Object.keys(release.properties)).toHaveLength(Object.keys(bundledRelease.properties).length + count * 12);
    let charged = 0;
    for (const [id, type] of Object.entries(release.types)) {
      if (type.listPresentation)
        charged += Buffer.byteLength(',"listPresentation":') + Buffer.byteLength(canonicalize(type.listPresentation)!);
      expect(type.listPresentation?.keyFacts.length ?? 0).toBeLessThanOrEqual(4);
      if (bundledRelease.types[id]) expect(type).toEqual(bundledRelease.types[id]);
    }
    const bytes = Buffer.byteLength(canonicalize(release)!);
    expect(bytes - Buffer.byteLength(canonicalize(withoutHints(release))!)).toBe(charged);
    expect(bytes).toBeLessThanOrEqual(RELEASE_LIMITS.bytes);
    for (let i = 0; i < count; i++) {
      const v = verticalProfile(i);
      expect(release.types[v.work]!.listPresentation).toEqual({
        imageAspect: 'portrait',
        keyFacts: [v.published, v.cast, v.count],
      });
      expect(release.types[v.edition]!.listPresentation).toEqual({ imageAspect: 'landscape', keyFacts: [] });
    }
    const v = verticalProfile(count - 1);
    const schema = JSON.parse(input.schemas[v.schema]!);
    schema.classes[`V${count - 1}Base`].annotations.list_presentation.keyFacts = [verticalProfile(count).published];
    input.schemas[v.schema] = JSON.stringify(schema);
    expect(await errors(input)).toContainEqual(
      expect.objectContaining({
        file: v.schema,
        pointer: `/classes/V${count - 1}Base/annotations/list_presentation/keyFacts/0`,
      }),
    );
    const malformed = structuredClone(release);
    malformed.types[v.work]!.listPresentation!.keyFacts = [verticalProfile(count).published];
    expect(validateRelease(malformed)).toContainEqual({
      pointer: `/types/${v.work}/listPresentation/keyFacts/0`,
      code: 'invalid',
    });
  }
}, 120_000);

test('list hints never enter LibraryProfileSource or change retained personal pins', async () => {
  const input = fixture();
  const old = await compileCatalogue(input);
  const digest = releaseDigest(old);
  const bytes = canonicalize(old);
  const pin: LibraryProfilePin = {
    provenance: 'profile',
    releaseDigest: digest,
    acceptingType: 'ex:Child',
    profileId: 'fixture.reading',
  };
  const legacy: LibraryProfilePin = {
    provenance: 'legacy',
    releaseDigest: digest,
    acceptingType: null,
    profileId: 'legacy-fixed-v1',
  };
  const schema = JSON.parse(input.schemas['fixture.yaml']);
  schema.classes.Parent.annotations.list_presentation = { imageAspect: 'portrait', keyFacts: [] };
  input.schemas['fixture.yaml'] = JSON.stringify(schema);
  const current = await compileCatalogue(input);
  expect(current.libraryProfiles).toEqual(old.libraryProfiles);
  expect(withoutHints(current)).toEqual(old);
  expect(releaseDigest(current)).not.toBe(digest);
  const releases = new Map([
    [digest, old],
    [releaseDigest(current), current],
  ]);
  for (const accepted of [pin, legacy]) {
    const exact = releases.get(accepted.releaseDigest)!;
    expect(exact.libraryProfiles![accepted.profileId]).toEqual(old.libraryProfiles![accepted.profileId]);
    expect(releaseDigest(exact)).toBe(digest);
    expect(canonicalize(exact)).toBe(bytes);
  }
  expect(pin.acceptingType).toBe('ex:Child');
  expect(legacy.acceptingType).toBeNull();
  const pointers: string[] = [];
  expect(
    validateLibraryProfileSource({ ...libraryProfile(), listPresentation: selection }, (p) => pointers.push(p)),
  ).toBe(false);
  expect(pointers).toContain('/listPresentation');
});

test('published catalogue and both normal recordings share the new immutable release while historical bytes still load', async () => {
  expect(await compileCatalogue(bundledSources())).toEqual(bundledRelease);
  const active = await Bun.file(
    new URL('../../../apps/web/src/kernel/recorded/definitions-active.json', import.meta.url),
  ).json();
  const recorded = await Bun.file(
    new URL('../../../apps/web/src/kernel/recorded/definitions-release.json', import.meta.url),
  ).json();
  expect(active.status).toBe(200);
  expect(recorded.status).toBe(200);
  expect(active.digest).toBe(bundledDigest);
  expect(recorded.digest).toBe(bundledDigest);
  expect(recorded.release).toEqual(bundledRelease);
  const historical = JSON.parse(
    readFileSync(new URL('./fixtures/bundled-historical-construction.json', import.meta.url), 'utf8'),
  );
  expect(Object.values(historical.types).every((type) => !Object.hasOwn(type as object, 'listPresentation'))).toBe(
    true,
  );
  expect(validateRelease(historical)).toEqual([]);
});
