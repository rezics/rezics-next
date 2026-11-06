import { expect, test } from 'bun:test';
import { checkBatchWrite } from '@rezics/definitions/bulk';
import bangumi from '../../../specs/fixtures/imports/bangumi/subject.json';
import vndb from '../../../specs/fixtures/imports/vndb/record.json';
import wikidata from '../../../specs/fixtures/imports/wikidata/entity.json';
import { converter_revision as wikidataRevision } from '@rezics/conversion/wikidata';
import { createSourceRegistration } from '../src/source-registry';

test('Wikidata registration consumes the current exported recipe converter revision', () => {
  const registration = createSourceRegistration('wikidata');
  expect(registration.converter_revision).toBe(wikidataRevision);
  const output = registration.convert(
    { external_id: wikidata.id, record_revision: String(wikidata.lastrevid), record: wikidata },
    { source: registration.source },
  );
  expect(output.proposals).toHaveLength(1);
  expect(output.proposals.every((command) => command.source.converter_revision === wikidataRevision)).toBe(true);
});

const fixtures = [
  { kind: 'bangumi' as const, id: String(bangumi.id), revision: '7', record: bangumi },
  { kind: 'vndb' as const, id: vndb.vn.id, revision: String(vndb.entry_meta.revision), record: vndb },
  { kind: 'wikidata' as const, id: wikidata.id, revision: String(wikidata.lastrevid), record: wikidata },
];

test('source registration forwards real pure converters with isolated trusted feed configuration', () => {
  for (const fixture of fixtures) {
    const registration = createSourceRegistration(fixture.kind, {
      source: 'test-feed',
      converterRevision: 'registered-test',
    });
    expect(registration.sourceKind).toBe(fixture.kind);
    expect(registration.source).toBe('test-feed');
    expect(registration.converter_revision).toBe('registered-test');
    const input = { external_id: fixture.id, record_revision: fixture.revision, record: fixture.record };
    const output = registration.convert(input, {
      source: 'test-feed',
      subjectId: '00000000-0000-4000-8000-000000000001',
    });
    expect(checkBatchWrite({ commands: output.proposals })).toEqual([]);
    expect(output.proposals.length).toBeGreaterThan(0);
    expect(output.proposals.every((command) => command.source.source === 'test-feed')).toBe(true);
    expect(output.proposals.every((command) => command.source.converter_revision === 'registered-test')).toBe(true);
    expect(output.normalized).toBeDefined();
    expect(
      registration.convert(
        { ...input, record: output.normalized },
        { source: 'test-feed', subjectId: '00000000-0000-4000-8000-000000000001' },
      ),
    ).toEqual(output);
    expect(() => registration.convert(input, { source: 'different-feed' })).toThrow();
  }
  const library = createSourceRegistration('openlibrary');
  expect(library.sourceKind).toBe('openlibrary');
  expect(library.source).toBe('open-library');
  expect(library.converter_revision.length).toBeGreaterThan(0);
  for (const source of ['', 'Bad Alias', 'x'.repeat(33)])
    expect(() => createSourceRegistration('wikidata', { source })).toThrow();
});

test('source registration forwards Open Library work and edition converter outputs', async () => {
  const [workModule, editionModule, converterModule] = await Promise.all([
    import('../../../specs/fixtures/imports/open-library/work.json'),
    import('../../../specs/fixtures/imports/open-library/edition.json'),
    import('@rezics/conversion/open-library'),
  ]);
  const openLibraryFixtures = [workModule.default, editionModule.default];
  const { convertOpenLibrary } = converterModule;
  const subjectId = '00000000-0000-4000-8000-000000000001';
  const mediaId = '00000000-0000-4000-8000-000000000002';
  const resolvedReferences = {
    '/authors/OL900000001A': '00000000-0000-4000-8000-000000000003',
    '/works/OL900000001W': '00000000-0000-4000-8000-000000000004',
  };
  const mediaIds = { 'https://covers.openlibrary.org/b/id/900000001-L.jpg': mediaId };
  const configured = createSourceRegistration('openlibrary', {
    source: 'reader-test',
    converterRevision: 'registered-library',
  });
  const native = createSourceRegistration('openlibrary');

  for (const record of openLibraryFixtures) {
    const input = {
      external_id: record.key,
      record_revision: String(record.revision),
      record,
    };
    const configuredContext = { source: configured.source, subjectId, resolvedReferences, mediaIds };
    const configuredNativeOutput = convertOpenLibrary(input, configuredContext, {
      converterRevision: configured.converter_revision,
    });
    const configuredOutput = configured.convert(input, configuredContext);
    expect(configuredOutput).toEqual({
      ...configuredNativeOutput,
      normalized: configuredNativeOutput.normalizedRecord,
    });
    expect(configuredOutput.normalized).toBe(Reflect.get(configuredOutput, 'normalizedRecord'));
    expect(configuredOutput.coverAssets).toEqual(configuredNativeOutput.coverAssets);
    expect(configuredOutput.mediaImportIntents).toEqual(configuredNativeOutput.mediaImportIntents);

    const nativeContext = { source: native.source, subjectId, resolvedReferences, mediaIds };
    const nativeOutput = native.convert(input, nativeContext);
    expect(nativeOutput.source).toBe('openlibrary');
    expect(nativeOutput.proposals.every((command) => command.source.source === 'open-library')).toBe(true);
    expect(configuredOutput.digest).toBe(nativeOutput.digest);
    expect(configuredOutput.proposals.map((command) => command.key)).not.toEqual(
      nativeOutput.proposals.map((command) => command.key),
    );
    expect(configuredOutput.proposals.every((command) => command.source.source === 'reader-test')).toBe(true);
    expect(
      configuredOutput.proposals.every((command) => command.source.converter_revision === 'registered-library'),
    ).toBe(true);
  }
});
