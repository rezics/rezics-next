import { expect, mock, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';
import { genericCreateSpecializedPath } from '../src/features/catalogue/generic-create-facts';
import { withConcreteReleaseDescriptors } from '../src/kernel/fake/release-fidelity';

mock.module('cloudflare:workers', () => ({ env: {} }));

const release = withConcreteReleaseDescriptors(bundledRelease);
const fileType = 'schema:MediaObject';
const groupType = 'rezics:ReleaseGroup';

function urlPart(content: string) {
  return { property: { id: 'schema:url' }, value: { type: 'value' as const, content } };
}
function groups(lengths: readonly number[]): StatementInput['references'] {
  return lengths.map((length, group) => ({
    parts: Array.from({ length }, (_, part) => urlPart(`https://example.org/g/${group}/${part}`)),
  }));
}
function fact(key: string, property: string, lengths: readonly number[]): { key: string; statement: StatementInput } {
  return {
    key,
    statement: {
      property: { id: property },
      value: { type: 'value', content: `https://example.org/${key}` },
      qualifiers: [],
      references: groups(lengths),
      rank: 'normal',
    },
  };
}

test('file and group creation offers released grains, grouped fields and the ordinary file reader', async () => {
  const {
    catalogueFileCreateAdmitReader,
    catalogueFileCreateControl,
    catalogueFileCreateDraft,
    catalogueFileCreateFields,
    catalogueFileCreateFieldGroups,
    catalogueFileCreateGrain,
    catalogueFileCreateHashNotice,
    catalogueFileCreateHolders,
    catalogueFileCreatePreparedFacts,
    catalogueFileCreateTypes,
  } = await import('../src/features/catalogue/catalogue-file-create');
  const { isCatalogueFileType, isReleaseGroupType } = await import(
    '../src/features/catalogue/catalogue-file-profile/model'
  );
  const offered = catalogueFileCreateTypes(release, 'en');
  expect(offered.map(({ id }) => id).sort()).toEqual(
    Object.keys(release.types)
      .filter((id) => isCatalogueFileType(release, id) || isReleaseGroupType(release, id))
      .sort(),
  );
  expect(offered.find((entry) => entry.id === fileType)?.grain).toBe('file');
  expect(offered.find((entry) => entry.id === groupType)?.grain).toBe('group');
  const both = structuredClone(release);
  both.types['rezics:FileAndGroup'] = {
    iri: 'https://rezics.com/vocab/FileAndGroup',
    labels: { en: 'file and group' },
    mappings: [],
    bases: ['schema:MediaObject', 'rezics:ReleaseGroup'],
    properties: release.types[fileType]!.properties,
    facets: [],
  };
  expect(catalogueFileCreateGrain(both, 'rezics:FileAndGroup')).toBe('file');
  expect(catalogueFileCreateFields(release, 'schema:Book')).toEqual([]);
  const fields = catalogueFileCreateFields(release, fileType);
  expect(fields.length).toBeGreaterThan(0);
  expect(fields.every((id) => release.types[fileType]!.properties.includes(id))).toBe(true);
  expect(fields.some((id) => id === 'schema:sha256' || id === 'schema:encodingFormat' || id === 'schema:sameAs')).toBe(
    true,
  );
  const grouped = catalogueFileCreateFieldGroups(release, fileType, 'en').flatMap((group) => group.properties);
  expect(grouped).toEqual(fields);
  expect(catalogueFileCreateHashNotice(release, fileType, 'schema:sha256')).toBe('hash');
  expect(catalogueFileCreateHashNotice(release, fileType, 'schema:encodingFormat')).toBe('codec');
  const empty = catalogueFileCreateDraft(release, { type: fileType, labels: { en: 'Empty file' } }, [
    {
      key: 'blank',
      statement: {
        property: { id: 'schema:sha256' },
        value: { type: 'value', content: '' },
        qualifiers: [],
        references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: '' } }] }],
        rank: 'normal',
      },
    },
  ]);
  expect(empty.item.statements).toEqual({});
  const entered = catalogueFileCreatePreparedFacts(
    [
      {
        key: 'hash',
        statement: {
          property: { id: 'schema:sha256' },
          value: { type: 'value', content: 'abc' },
          qualifiers: [],
          references: [],
          rank: 'preferred',
        },
      },
    ],
    release,
  );
  const ranked = catalogueFileCreateDraft(release, { type: fileType, labels: { en: 'Hashed' } }, entered);
  expect(ranked.errors.some((error) => error.pointer.includes('/rank'))).toBe(true);
  const reader = catalogueFileCreateAdmitReader(
    { state: 'ready', href: '/en/subjects/00000000-0000-4000-8000-00000000a201/episode-1-file-a', identity: { id: '00000000-0000-4000-8000-00000000a201', type: fileType, label: 'Episode 1 file A' } },
    '00000000-0000-4000-8000-00000000a201',
    release,
    fileType,
  );
  expect(reader).toMatchObject({ state: 'ready', href: '/en/subjects/00000000-0000-4000-8000-00000000a201/episode-1-file-a/file' });
  expect(
    catalogueFileCreateAdmitReader(
      { state: 'ready', href: '/en/subjects/x/x', identity: { id: 'x', type: 'schema:Book', label: 'x' } },
      'x',
      release,
    ).state,
  ).toBe('stale');
  const rows = [
    fact('a', 'schema:sameAs', [2]),
    fact('b', 'schema:sameAs', [1]),
  ];
  const captured = catalogueFileCreateHolders(rows);
  const nested = catalogueFileCreateControl(
    '/statements/schema:sameAs/0/references/0/parts/1/value/content',
    captured,
    rows,
    fileType,
    release,
    'en',
    'catalogue-file-initial-facts',
  );
  expect(nested?.id).toContain('catalogue-file-initial-a');
  const afterRemoval = catalogueFileCreateControl(
    '/statements/schema:sameAs/0/references/0/parts/1/value/content',
    captured,
    [rows[1]!],
    fileType,
    release,
    'en',
    'catalogue-file-initial-facts',
  );
  expect(afterRemoval?.id).toBe('catalogue-file-removed-a');
  expect(afterRemoval?.id).not.toContain(rows[1]!.key);
  expect(catalogueEntries.catalogueFile({ locale: 'fr' })).toMatchObject({
    group: 'create',
    href: '/fr/catalogue/file',
  });
  expect(catalogueEntries.catalogueFile({ id: '00000000-0000-4000-8000-00000000a201', type: 'bf:Instance', locale: 'en' })).toBeUndefined();
  expect(genericCreateSpecializedPath('schema:MediaObject')).toBe('/catalogue/file');
  expect(genericCreateSpecializedPath('rezics:ReleaseGroup')).toBe('/catalogue/file');
});

test('file creation preparation and reuse visit 32, 128 and 512 structured parts without native calls', async () => {
  const {
    applyCatalogueFileCreateReuse,
    captureCatalogueFileCreateReuse,
    catalogueFileCreateHolders,
    catalogueFileCreateStructuredParts,
    visitCatalogueFileCreateParts,
  } = await import('../src/features/catalogue/catalogue-file-create');
  const property = 'schema:sameAs';
  const scales: { parts: 32 | 128 | 512; lengths: readonly number[]; copied: 53 | 149 | 533 }[] = [
    { parts: 32, lengths: [7], copied: 53 },
    { parts: 128, lengths: [7, 16, 8], copied: 149 },
    { parts: 512, lengths: [7, 16, 16, 16, 16, 16, 16, 16, 8], copied: 533 },
  ];
  for (const scale of scales) {
    const facts = ['a', 'b', 'c', 'd'].map((key) => fact(key, property, scale.lengths));
    expect(catalogueFileCreateStructuredParts(facts)).toBe(scale.parts);
    let visited = 0;
    const counted = visitCatalogueFileCreateParts(facts, () => {
      visited += 1;
    });
    expect(counted).toBe(scale.parts);
    expect(visited).toBe(scale.parts);
    const reuse = captureCatalogueFileCreateReuse(facts, 'a', 0, release, fileType);
    expect(reuse).not.toBeNull();
    const selected = catalogueFileCreateHolders(facts)
      .slice(1)
      .map((holder) => `catalogue-file-initial-${holder.key}`);
    const copied = applyCatalogueFileCreateReuse(facts, { ...reuse!, selected }, release, fileType);
    expect(copied.reuse.applied).toHaveLength(3);
    expect(catalogueFileCreateStructuredParts(copied.facts)).toBe(scale.copied);
    expect(copied.facts[0]!.statement.references[0]?.parts).toHaveLength(7);
  }
});
