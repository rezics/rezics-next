import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import fidelity from '../../../scripts/qa/cases/outcomes/catalogue/import-fidelity.ts';
import coverage from '../../../scripts/qa/cases/outcomes/catalogue/source-coverage.ts';
import { personas } from '../../../scripts/qa/cases/outcome-cells.ts';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { intakeChunks } from '../../../scripts/datasets/import.ts';
import { admissionRefusals, retainedAdmissionCases, type NativeFieldBasis,
  type RetainedConversionRequest, type RetainedFieldCoordinate, type RetainedSupportAdmission,
  type RetainedSupportRequest } from '../fixtures/catalogue/import-admission-contract.ts';
import { assertAdmissionRefusal, assertDispositionConservation, assertMatrix, assertRetainedBinding,
  assertRetainedFieldCoordinate, assertRetainedRecordInput, assertRetainedSupportAdmission,
  digest, exactRecords, matrix, supportAdmissionMutations } from '../support/import-outcomes.ts';

test('the executable import pin and specification retain the original audit product baseline', () => {
  const originalAuditBaseline = '69eac3ceeaf885be70205a70248bc951e9d81cc9';
  const specification = readFileSync(new URL('../../../docs/goals/audit-remediation-20261019/import-outcomes.md',
    import.meta.url), 'utf8');
  expect(matrix.baselineProduct).toBe(originalAuditBaseline);
  expect(specification.match(/original audit product baseline[^`]*`([a-f0-9]{40})`/)?.[1])
    .toBe(originalAuditBaseline);
});

test('both import rows retain six pending cells and the accepted inventory partition', () => {
  assertMatrix();
  for (const row of [fidelity, coverage]) {
    expect(Object.keys(row.cells).sort()).toEqual([...personas].sort());
    for (const cell of Object.values(row.cells)) expect(cell?.state).toBe('pending');
  }
  expect(matrix.relations.filter(row => row.sourceKey === 'vndb:vn:v11')).toHaveLength(50);
  expect(matrix.music.trackMilliseconds).not.toBe(matrix.music.recordingMilliseconds);
});

const original = (key: string): DatasetRecord => ({ key, provider: 'bangumi', kind: 'subject',
  externalId: key, title: 'Original unit fixture identity', language: 'ja', sourceUrl: 'https://example.invalid/source',
  data: {}, native: 'work' });

test('selection is order independent and refuses missing or duplicate original identities', () => {
  const a = original('a'), b = original('b'), excluded = original('excluded');
  expect(exactRecords([excluded, b, a], ['b', 'a'])).toEqual([a, b]);
  expect(exactRecords([a, excluded, b], ['a', 'b'])).toEqual([a, b]);
  expect(() => exactRecords([a], ['b'])).toThrow('Missing frozen source identity');
  expect(() => exactRecords([a, a], ['a'])).toThrow('Duplicate frozen source identity');
  expect(() => exactRecords([a], ['a', 'a'])).toThrow('Duplicate frozen source identity');
});

const expected = [
  { key: 'native-fact', sourceKey: 'retained-original', valueDigest: 'one', disposition: 'adopted' },
  { key: 'private-activity', sourceKey: 'retained-original', valueDigest: 'two', disposition: 'source-only' },
];
const actual = () => expected.map(row => ({ ...row,
  native: row.disposition === 'adopted' ? [{ resource: 'unit-native-fact', revision: 'unit-revision' }] : [],
  reason: row.disposition === 'adopted' ? null : 'Retain private source activity without native voters.' }));

test('the specification rejects blanket source-only and empty native positives', () => {
  expect(() => assertDispositionConservation(actual(), expected)).not.toThrow();
  const blanket = actual().map(row => ({ ...row, disposition: 'source-only', native: [], reason: 'Unsupported' }));
  expect(() => assertDispositionConservation(blanket, expected)).toThrow();
  const empty = actual(); empty[0]!.native = [];
  expect(() => assertDispositionConservation(empty, expected)).toThrow();
});

test('the specification rejects dropped, duplicated, extra, changed and falsely adopted evidence', () => {
  expect(() => assertDispositionConservation(actual().slice(0, 1), expected)).toThrow();
  expect(() => assertDispositionConservation([...actual(), actual()[0]!], expected)).toThrow();
  expect(() => assertDispositionConservation([...actual(), { ...actual()[0]!, key: 'unselected' }], expected)).toThrow();
  const changed = actual(); changed[0]!.valueDigest = 'different source value';
  expect(() => assertDispositionConservation(changed, expected)).toThrow();
  const published = actual(); published[1]!.native = [...published[0]!.native];
  expect(() => assertDispositionConservation(published, expected)).toThrow();
});

// These are counterexamples for test-oracle integrity, never captured provider
// data or successful Source/native receipts in an integration corpus.
const unitIri = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const byteDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pin = { id: 'unit-retained-snapshot', digest: digest('unit-logical-snapshot'), fileSha256: digest('unit-file') };
function retainedRequest(record: DatasetRecord, payload: unknown = record.data) {
  const buffers = intakeChunks(payload);
  const parts = buffers.map((bytes, index) => ({ record: unitIri(index + 1), observation: unitIri(index + 20),
    rawDigest: byteDigest(bytes), rawBytesBase64: bytes.toString('base64') }));
  const first = JSON.parse(buffers[0]!.toString()) as Record<string, unknown>;
  const request: RetainedConversionRequest = { profile: 'source-retained-record-conversion-v1',
    mappingRevision: 'unit-verified-normalization-v1', retained: {
      identity: { key: record.key, provider: record.provider, namespace: record.kind, externalId: record.externalId },
      snapshot: pin, record, recordDigest: digest(record),
      intakes: parts.map((part, index) => ({ index, record: part.record, observation: part.observation, byteDigest: part.rawDigest })),
      payload: first.format === 'rezics-dataset-chunk-v1'
        ? { format: 'rezics-dataset-chunk-v1', byteDigest: first.digest as string, byteLength: first.byteLength as number }
        : { format: 'json', byteDigest: byteDigest(buffers[0]!), byteLength: buffers[0]!.length },
    } };
  return { request, parts };
}

test('full-record evidence cannot substitute data-only, another source identity or a snapshot/byte digest', () => {
  const record = { ...original('unit-subject'), data: { title: 'provider title', summary: 'first\nsecond' } };
  const { request, parts } = retainedRequest(record);
  expect(() => assertRetainedRecordInput(request.retained, record, pin, parts)).not.toThrow();
  expect(request.retained.recordDigest).not.toBe(request.retained.payload.byteDigest);
  for (const change of [
    (copy: RetainedConversionRequest) => { copy.retained.record.title = 'A changed normalized title outside data'; },
    (copy: RetainedConversionRequest) => { copy.retained.record.language = 'en'; },
    (copy: RetainedConversionRequest) => { copy.retained.identity.externalId = 'another-record'; },
    (copy: RetainedConversionRequest) => { copy.retained.recordDigest = digest(record.data); },
    (copy: RetainedConversionRequest) => { copy.retained.recordDigest = pin.digest; },
    (copy: RetainedConversionRequest) => { copy.retained.intakes[0]!.byteDigest = copy.retained.recordDigest; },
  ]) {
    const copy = structuredClone(request); change(copy);
    expect(() => assertRetainedRecordInput(copy.retained, record, pin, parts)).toThrow();
  }
  const { record: _record, ...retained } = request.retained;
  const binding = { ...retained, profile: 'source-retained-record-binding-v1' as const,
    binding: unitIri(70), sourceRecord: unitIri(71), conversion: unitIri(72),
    mappingRevision: request.mappingRevision, normalizationRevision: 'unit-normalization-v1' };
  expect(() => assertRetainedBinding(binding, request, unitIri(72))).not.toThrow();
  expect(() => assertRetainedBinding({ ...binding, mappingRevision: 'wrong-map-v1' }, request, unitIri(72))).toThrow();
  expect(() => assertRetainedBinding({ ...binding, conversion: unitIri(73) }, request, unitIri(72))).toThrow();
});

test('multipart evidence preserves actual part records, order and distinct raw/assembled/record digests', () => {
  const record = { ...original('unit-multipart'), data: { summary: '汉\n'.repeat(35_000) } };
  const { request, parts } = retainedRequest(record, { format: 'rezics-dataset-record-v1', record, edges: [] });
  expect(parts.length).toBeGreaterThan(1);
  expect(() => assertRetainedRecordInput(request.retained, record, pin, parts)).not.toThrow();
  expect(request.retained.payload.byteDigest).not.toBe(parts[0]!.rawDigest);
  expect(request.retained.payload.byteDigest).not.toBe(request.retained.recordDigest);
  const reversed = structuredClone(request); reversed.retained.intakes.reverse();
  expect(() => assertRetainedRecordInput(reversed.retained, record, pin, parts)).toThrow();
  expect(() => assertRetainedRecordInput(request.retained, record, pin, [...parts].reverse())).toThrow();
  expect(() => assertRetainedRecordInput(request.retained, record, pin, parts.slice(1))).toThrow();
  const corrupt = structuredClone(parts); corrupt[0]!.rawDigest = digest('wrong raw bytes');
  expect(() => assertRetainedRecordInput(request.retained, record, pin, corrupt)).toThrow();
});

test('record coordinates preserve supplied language, multiline/oversized text, alias ordinal and exact precision', () => {
  const record = { ...original('unit-coordinates'), data: { alias: '  first alias  \r\n第二名\nthird',
    synopsis: `${'一'.repeat(8_001)}\n  final line  `, amount: '12345678901234567890.0100', date: '1982-10' } };
  const coordinate = (pointer: string, value: unknown, extra = {}): RetainedFieldCoordinate =>
    ({ pointer, presence: 'value', valueDigest: digest(value), ...extra });
  const alias = coordinate('/data/alias', record.data.alias, { ordinal: 1 });
  expect(assertRetainedFieldCoordinate(alias, record, { pointer: '/data/alias', ordinal: 1 })).toBe('第二名');
  expect(() => assertRetainedFieldCoordinate({ ...alias, pointer: '/data/alias/1' }, record,
    { pointer: '/data/alias', ordinal: 1 })).toThrow();
  expect(() => assertRetainedFieldCoordinate({ ...alias, ordinal: 0 }, record,
    { pointer: '/data/alias', ordinal: 1 })).toThrow();
  for (const [key, value] of Object.entries(record.data)) {
    const pointer = `/data/${key}`, exact = coordinate(pointer, value);
    expect(assertRetainedFieldCoordinate(exact, record, { pointer })).toBe(value);
    const changed: Record<string, unknown> = { alias: record.data.alias.trim(), synopsis: record.data.synopsis.slice(0, 100),
      amount: Number(record.data.amount), date: `${record.data.date}-01` };
    expect(() => assertRetainedFieldCoordinate({ ...exact, valueDigest: digest(changed[key]) }, record,
      { pointer })).toThrow();
  }
  const title = coordinate('/title', record.title, { language: 'JA' });
  expect(assertRetainedFieldCoordinate(title, record, { pointer: '/title', language: 'JA' })).toBe(record.title);
  expect(() => assertRetainedFieldCoordinate({ ...title, language: 'ja' }, record,
    { pointer: '/title', language: 'JA' })).toThrow();
  const untagged = coordinate('/data/synopsis', record.data.synopsis);
  expect(() => assertRetainedFieldCoordinate({ ...untagged, language: null }, record,
    { pointer: '/data/synopsis' })).toThrow();
  expect(() => assertRetainedFieldCoordinate({ ...untagged, language: 'en' }, record,
    { pointer: '/data/synopsis' })).toThrow();
});

test('omitted, null, empty text/array/object and measured zero have separate evidence dispositions', () => {
  const record = { ...original('unit-presence'), data: { null: null, text: '', array: [], object: {}, zero: 0 } };
  for (const [key, value, presence] of [
    ['missing', undefined, 'omitted'], ['null', null, 'null'], ['text', '', 'empty-string'],
    ['array', [], 'empty-array'], ['object', {}, 'empty-object'], ['zero', 0, 'value'],
  ] as const) {
    const field: RetainedFieldCoordinate = { pointer: `/data/${key}`, presence,
      ...(presence === 'omitted' ? {} : { valueDigest: digest(value) }) };
    expect(() => assertRetainedFieldCoordinate(field, record, { pointer: field.pointer })).not.toThrow();
    expect(() => assertRetainedFieldCoordinate({ ...field, presence: presence === 'value' ? 'null' : 'value' }, record,
      { pointer: field.pointer })).toThrow();
  }
});

const supportRequest = (native: NativeFieldBasis): RetainedSupportRequest => ({
  profile: 'source-field-support-attachment-v2', target: unitIri(90), slot: 'component-property-v1#https://schema.org/name',
  occurrence: null, context: 'global', sourceRecord: unitIri(71), conversion: unitIri(72), grain: 'artist', sourceField: 'name',
  sourceOccurrence: null, expectedHead: unitIri(91), actingSubject: unitIri(92),
  evidence: { binding: unitIri(70), recordDigest: digest('unit-record'), mappingRevision: 'unit-map-v1',
    field: { pointer: '/data/name', presence: 'value', valueDigest: digest('unit name') } }, native,
});
const unitNative: NativeFieldBasis = { kind: 'component-property', target: unitIri(90), revision: unitIri(91),
  property: { predicate: 'https://schema.org/name', value: { kind: 'string', lexical: 'unit name' } } };

test('source admission and native target/value/head verification cannot stand in for each other', async () => {
  const request = supportRequest(unitNative);
  const admission: RetainedSupportAdmission = { profile: 'source-field-support-admission-v1',
    sourceRecord: request.sourceRecord, conversion: request.conversion,
    correspondence: { normalizationRevision: 'unit-normalization-v1', rule: 'unit-name-v1',
      payloadPointers: ['/name'], selectedValueDigest: digest('unit name') },
    evidence: request.evidence, native: request.native, headGuarantee: 'verified-before-commit' };
  expect(() => assertRetainedSupportAdmission(admission, request)).not.toThrow();
  const mutations = supportAdmissionMutations(request, { record: unitIri(80), conversion: unitIri(81), target: unitIri(82), head: unitIri(83) });
  expect(mutations.map(([basis]) => basis)).toEqual([...admissionRefusals.support.bases]);
  for (const [basis, refused] of mutations) {
    expect(refused).not.toEqual(request);
    expect(() => assertRetainedSupportAdmission({ ...admission, sourceRecord: refused.sourceRecord,
      conversion: refused.conversion, evidence: refused.evidence, native: refused.native }, request)).toThrow();
    await assertAdmissionRefusal(Promise.resolve(Response.json({ code: 'source_support_changed', basis }, { status: 409 })),
      admissionRefusals.support, basis);
    await expect(assertAdmissionRefusal(Promise.resolve(Response.json({ code: 'source_support_changed', basis: 'other' }, { status: 409 })),
      admissionRefusals.support, basis)).rejects.toThrow();
  }
  expect(request).toEqual(supportRequest(unitNative));
  for (const key of retainedAdmissionCases) expect(matrix.sources.some(source => source.recordKeys.includes(key))).toBe(true);
});

test('native receipts preserve exact codecs, date precision, language and Statement ownership', () => {
  const bases: NativeFieldBasis[] = [
    { ...unitNative, property: { predicate: 'https://schema.org/description',
      value: { kind: 'language-string', lexical: 'first\n  第二行  ', language: 'zh-Hant' } } },
    { ...unitNative, property: { predicate: 'https://schema.org/amount',
      value: { kind: 'decimal', lexical: '12345678901234567890.01' } } },
    { ...unitNative, property: { predicate: 'https://schema.org/datePublished',
      value: { kind: 'temporal', lexical: '1982-10', precision: 'month', calendar: 'gregorian' } } },
    { kind: 'statement', target: unitIri(90), revision: unitIri(91), statement: unitIri(100),
      predicate: 'https://schema.org/datePublished', context: 'global',
      value: { kind: 'literal', lexical: '1982', datatype: 'http://www.w3.org/2001/XMLSchema#gYear', language: null },
      qualifiers: { applicability: [], interpretationDefinitions: [] }, acceptance: null },
  ];
  for (const native of bases) {
    const request = supportRequest(native);
    const admission: RetainedSupportAdmission = { profile: 'source-field-support-admission-v1',
      sourceRecord: request.sourceRecord, conversion: request.conversion,
      correspondence: { normalizationRevision: 'unit-normalization-v1', rule: 'unit-field-v1',
        payloadPointers: ['/field'], selectedValueDigest: digest('unit retained field') },
      evidence: request.evidence, native, headGuarantee: 'verified-before-commit' };
    expect(() => assertRetainedSupportAdmission(admission, request)).not.toThrow();
    const changed = structuredClone(admission);
    if (changed.native.kind === 'component-property') {
      const value = changed.native.property.value;
      if (value.kind === 'language-string') value.language = 'en';
      if (value.kind === 'decimal') value.lexical = String(Number(value.lexical));
      if (value.kind === 'temporal') { value.lexical += '-01'; value.precision = 'day'; }
    } else {
      changed.native.value = { kind: 'literal', lexical: '1982-01-01',
        datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null };
      changed.native.acceptance = { context: 'global', decision: unitIri(101), source: unitIri(102) };
    }
    expect(() => assertRetainedSupportAdmission(changed, request)).toThrow();
  }
});
