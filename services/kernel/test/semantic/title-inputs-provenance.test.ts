import { expect, test } from 'bun:test';
import type { SemanticTitleInputEntry } from '../../src/semantic/contract/title-inputs.ts';
import { bindSemanticTitleProvenanceRows } from '../../src/semantic/title-inputs-provenance.ts';
import { newId } from '../../src/route/route.ts';

const original = newId(0x1200);
const terminal = newId(0x3400);
const candidate = newId(0x3400);
const agent = newId(0x5600);
const slot = newId(0x3400);
const entry: SemanticTitleInputEntry = {
  subjectId: original,
  sourceId: terminal,
  sourceBasis: '7:9',
  labels: { en: 'Name', ja: '名前' },
  originalLanguage: 'ja',
};
type SourceRow = Readonly<{
  id: string;
  labelBindings: unknown;
  labelBindingsComplete: boolean;
  original: string | null;
  originalCandidate: string | null;
  originalSupportRevision: string | null;
  originalSource: unknown;
  redirect: string | null;
  revision: string | null;
}>;

function imported(source: string, external_id: string) {
  return {
    source,
    external_id,
    record_revision: '4',
    digest: 'a'.repeat(64),
    converter_revision: '2',
    field_group: 'facts',
  };
}

function row(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: terminal,
    labelBindingsComplete: true,
    labelBindings: {
      en: { value: 'Name', revision: '5', slot, sequence: 1, source: imported('catalogue', 'a-1') },
      ja: { value: '名前', revision: '6', slot, sequence: 2, source: imported('catalogue', 'b-2') },
    },
    original: 'ja',
    originalCandidate: candidate,
    originalSupportRevision: '8',
    originalSource: { kind: 'agent', subject: agent },
    redirect: null,
    revision: '9',
    ...overrides,
  };
}

test('binds each language tuple and the independent selected original-language candidate', () => {
  const entryRow = row();
  const result = bindSemanticTitleProvenanceRows([entry], [entryRow], (source, externalId) => {
    if (source !== 'catalogue') throw new Error('unexpected imported source');
    return externalId === 'a-1' ? 117 : externalId === 'b-2' ? 218 : 0;
  });

  expect(result?.[0]).toMatchObject({
    subjectId: original,
    source: { subjectId: terminal, identityEpoch: '7', terminalRevision: 9 },
    labels: {
      en: {
        value: 'Name',
        origin: { kind: 'imported', route: 117, source: 'catalogue', external_id: 'a-1', field_group: 'facts' },
        support: { kind: 'term', revision: 5, slot, sequence: 1 },
      },
      ja: {
        value: '名前',
        origin: { kind: 'imported', route: 218, source: 'catalogue', external_id: 'b-2', field_group: 'facts' },
        support: { kind: 'term', revision: 6, slot, sequence: 2 },
      },
    },
    originalLanguage: {
      value: 'ja',
      origin: { kind: 'agent', subject: agent },
      support: { kind: 'statement', candidate, revision: 8 },
    },
  });
});

test('a same-value source replacement binds the new support and cannot reuse the old tuple', () => {
  const replaced = row({
    revision: '10',
    labelBindings: {
      en: { value: 'Name', revision: '10', slot, sequence: 1, source: imported('catalogue', 'a-2') },
      ja: { value: '名前', revision: '6', slot, sequence: 2, source: imported('catalogue', 'b-2') },
    },
  });
  const updated = { ...entry, sourceBasis: '7:10' };
  const result = bindSemanticTitleProvenanceRows([updated], [replaced], (_source, externalId) =>
    externalId === 'a-2' ? 119 : externalId === 'b-2' ? 218 : 0,
  );

  expect(result?.[0]?.labels.en).toMatchObject({
    value: 'Name',
    origin: { kind: 'imported', route: 119, external_id: 'a-2' },
    support: { revision: 10 },
  });
});

test('certifies native term support and rejects a missing or mismatched origin', () => {
  const native = row({
    labelBindings: { en: { value: 'Name', revision: '5', slot, sequence: 1, source: null } },
    original: null,
    originalCandidate: null,
    originalSupportRevision: null,
    originalSource: null,
  });
  const withoutLanguage = { ...entry, labels: { en: 'Name' }, originalLanguage: null };
  const result = bindSemanticTitleProvenanceRows([withoutLanguage], [native], () => 1);
  expect(result?.[0]?.labels.en.origin).toEqual({ kind: 'native' });
  expect(result?.[0]?.labels.en.support).toEqual({ kind: 'term', revision: 5, slot, sequence: 1 });
  expect(
    bindSemanticTitleProvenanceRows(
      [withoutLanguage],
      [row({ labelBindings: { en: { value: 'Name', revision: null, slot, sequence: 1 } } })],
      () => 1,
    ),
  ).toBeNull();
  expect(
    bindSemanticTitleProvenanceRows(
      [entry],
      [
        row({
          labelBindings: {
            en: { value: 'Changed', revision: '5', slot, sequence: 1, source: imported('catalogue', 'a-1') },
            ja: { value: '名前', revision: '6', slot, sequence: 2, source: imported('catalogue', 'b-2') },
          },
        }),
      ],
      () => 1,
    ),
  ).toBeNull();
});
