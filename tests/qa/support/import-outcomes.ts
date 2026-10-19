import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import matrix from '../fixtures/catalogue/import-outcomes.json';
import { canonicalJson } from '../../../scripts/lib/canonical-json.ts';
import type { DatasetRecord, DatasetSnapshot } from '../../../scripts/datasets/types.ts';
import { reconstructIntake } from '../../../scripts/datasets/import.ts';
import type { Persona, RowOutcomes } from '../../../scripts/qa/cases/outcome-cells.ts';
import type { PersonaSession, PersonaSessions, RetainedPersonaRealm } from './personas.ts';
import { assertAuditExecution } from './audit-execution.ts';
import { admissionRefusals, retainedAdmissionCases, type RetainedConversionRequest,
  type RetainedFieldCoordinate, type RetainedRecordBinding, type RetainedRecordInput, type RetainedSupportAdmission,
  type RetainedSupportRequest } from '../fixtures/catalogue/import-admission-contract.ts';

export { matrix };
export const short = (iri: string) => iri.slice(-36);
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const repository = resolve(import.meta.dir, '../../..');
const native = /^https:\/\/rezics\.com\/id\/[a-f0-9-]{36}$/;
export type Disposition = 'adopted' | 'source-only' | 'source-empty' | 'acquisition-failed'
  | 'unmapped' | 'pending-adoption' | 'unknown';
type Position = { datasetId: 'product'; dataEpoch: string; sequence: string };
export type Target = { resource: string; revision: string; mainVersion?: string; kind: string };
type Source = { record: string; observation: string; conversion?: string; proposal?: string;
  parts: Array<{ record?: string; observation: string; rawDigest: string; rawBytesBase64: string }>;
  /** Prepared request inputs need actual intake receipts, not a successful new
   * conversion. The proposed result is observed only in an outcome test body. */
  retainedRequest?: RetainedConversionRequest; retainedBinding?: RetainedRecordBinding };
type Command = { method: 'POST' | 'PUT'; path: string; body: Record<string, unknown>;
  key: string; status: number; identity: Record<string, string> };
type Control = { workHead: string; contentHead: string | null; controlHead: string | null;
  controlEpoch: string; protectionHead: string | null; mode: string; value: string | null };

/** Private fixture inputs, never an expected product answer. A producer must retain
 * actual successful public-command receipts and one consistent stopped-owner cut. */
export interface ImportCorpus {
  profile: 'import-outcomes-corpus-v1';
  phase: 'baseline' | 'candidate';
  productRevision: string;
  selectionDigest: string;
  runId: string;
  fixtureRoot: string;
  sourceRoot: string;
  realm: RetainedPersonaRealm;
  backup: { manifest: string; sha256: string; ownerStores: string[]; sourceRunId: string };
  preparation: { buildMs: number; restoreMs: number; startupMs: number; readinessMs: number; totalMs: number };
  authority: { operatorAccount: string; exposure: 'platform:catalogue-import';
    grants: Array<{ scope: string; action: string; receipt: string }> };
  targets: Record<string, Target>;
  relations: Record<string, { occurrence: string; definition: string; definitionRevision: string }>;
  sources: Record<string, Source>;
  selections: Array<{ name: string; commands: Command[] }>;
  hidden: { resource: string; observation: string; conversion: string; proposal: string; canary: string };
  music: { track?: Target; release?: Target; nameHead: string };
  /** Actual source-origin synopsis control command's support receipt, if the
   * product returned one. Missing support is observed in the test body. */
  synopsisSupport?: { support: string; supportIdentity: string };
  refresh: { sourceKey: string; baseConversion: string; candidateConversion: string;
    command: Command; oldGeneration: string; newGeneration: string };
}
export interface ImportFixture {
  corpus: ImportCorpus;
  people: PersonaSessions;
  records: Map<string, DatasetRecord>;
  staleSourceFieldBody?: Record<string, unknown>;
  close(): Promise<void>;
}

function localFile(path: string): string {
  const actual = realpathSync(resolve(path)), base = realpathSync(join(repository, '.temp'));
  const rel = relative(base, actual);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
    throw new Error('Import fixture bookkeeping must be inside this worktree .temp');
  return actual;
}

/** Selecting an exact set is invariant under input ordering. Reject partial closure
 * rather than silently dropping a missing selected identity or edge occurrence. */
export function exactRecords(records: readonly DatasetRecord[], keys: readonly string[]): DatasetRecord[] {
  const byKey = new Map(records.map(record => [record.key, record]));
  if (byKey.size !== records.length || new Set(keys).size !== keys.length)
    throw new Error('Duplicate frozen source identity');
  return [...keys].sort().map(key => {
    const record = byKey.get(key);
    if (!record) throw new Error(`Missing frozen source identity: ${key}`);
    return record;
  });
}

export function assertMatrix(): void {
  const keys = matrix.inventory.map(row => row.key);
  expect(new Set(keys).size, 'every elected disposition has one stable key').toBe(keys.length);
  const indexes = matrix.fieldRules.ownershipRules.flatMap(rule => rule.fieldIndexes);
  expect([...indexes].sort((a, b) => a - b), 'accepted structural inventory is a partition, not issue counts')
    .toEqual(Array.from({ length: matrix.fieldRules.structuralPathCount }, (_, index) => index));
  for (const rule of matrix.fieldRules.ownershipRules) expect(rule.fieldIndexes.length).toBe(rule.fieldCount);
  for (const selection of matrix.selections) {
    expect(selection.providers.length).toBe(2);
    expect(new Set(selection.providers).size).toBe(2);
  }
  expect(matrix.relations.length).toBeGreaterThan(20);
  expect(matrix.tags.filter(tag => tag.sourceKey.startsWith('bangumi:')).length).toBe(29);
  expect(matrix.tags.filter(tag => tag.sourceKey.startsWith('vndb:')).length).toBe(211);
  expect(new Set(matrix.inventory.map(row => row.disposition)))
    .toEqual(new Set<Disposition>(['adopted', 'source-only', 'source-empty', 'acquisition-failed',
      'unmapped', 'pending-adoption', 'unknown']));
}

function frozenRecords(sourceRoot: string): Map<string, DatasetRecord> {
  const selected = new Map<string, DatasetRecord>();
  for (const pin of matrix.sources) {
    // Read-only; no datasetRoot fallback, acquisition, image fetch or import here.
    const raw = readFileSync(join(sourceRoot, 'snapshots', pin.id, 'snapshot.json'));
    expect(bytesDigest(raw), `immutable ${pin.provider} snapshot bytes`).toBe(pin.fileSha256);
    const snapshot = JSON.parse(raw.toString()) as DatasetSnapshot;
    expect(snapshot.digest).toBe(pin.digest);
    expect(snapshot.id).toBe(pin.id);
    const source = snapshot.sources.find(value => value.provider === pin.provider);
    if (!source) throw new Error(`Frozen provider is absent: ${pin.provider}`);
    const recordDigests: Record<string, string | undefined> = pin.recordDigests;
    for (const record of exactRecords(source.records, pin.recordKeys)) {
      expect(digest(record)).toBe(recordDigests[record.key]!);
      selected.set(record.key, record);
    }
    const edges = pin.edgeIndexes.map(index => {
      const edge = source.edges[index];
      if (!edge || !pin.recordKeys.includes(edge.from) || !pin.recordKeys.includes(edge.to))
        throw new Error(`Frozen ${pin.provider} edge closure changed at ${index}`);
      return edge;
    });
    expect(edges.length).toBe(pin.edgeCount);
    expect(digest(edges)).toBe(pin.edgeDigest);
    expect(source.records.length - pin.recordKeys.length).toBe(pin.excludedRecordCount);
  }
  return selected;
}

export async function openImportFixture(row: RowOutcomes): Promise<ImportFixture> {
  assertMatrix();
  const path = Bun.env.REZICS_IMPORT_OUTCOME_FIXTURE;
  if (!path) throw new Error(`TEST PREMISE (${row.rowId}): missing REZICS_IMPORT_OUTCOME_FIXTURE; `
    + 'build a command-created isolated import corpus and restore its consistent backup; no product assertion reached');
  const manifest = localFile(path);
  expect(statSync(manifest).mode & 0o077, 'retained OAuth fixture credentials are private').toBe(0);
  const corpus = JSON.parse(readFileSync(manifest, 'utf8')) as ImportCorpus;
  expect(corpus.profile).toBe('import-outcomes-corpus-v1');
  expect(['baseline', 'candidate']).toContain(corpus.phase);
  expect(corpus.selectionDigest).toBe(digest(matrix));
  expect(corpus.productRevision).toMatch(/^[a-f0-9]{40}$/);
  assertAuditExecution(corpus, { checkout: repository, productBaseline: matrix.baselineProduct,
    productRevision: corpus.productRevision });
  if (corpus.phase === 'baseline') expect(corpus.productRevision).toBe(matrix.baselineProduct);
  const restoredRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!restoredRunId) throw new Error('TEST PREMISE: missing isolated restored REZICS_QA_RUN_ID');
  expect(corpus.runId).toBe(restoredRunId);
  expect(corpus.runId).not.toBe(corpus.backup.sourceRunId);
  expect(localFile(corpus.fixtureRoot)).toBe(localFile(Bun.env.REZICS_FIXTURE_ROOT ?? ''));
  const backup = readFileSync(localFile(corpus.backup.manifest));
  expect(bytesDigest(backup)).toBe(corpus.backup.sha256);
  const savedBackup = JSON.parse(backup.toString()) as { format: string; runId: string; preparationMs: number };
  expect(savedBackup.format).toBe('command-catalogue-backup-v1');
  expect(savedBackup.runId).toBe(corpus.backup.sourceRunId);
  expect(savedBackup.preparationMs).toBeLessThanOrEqual(600_000);
  expect(new Set(corpus.backup.ownerStores).size).toBe(corpus.backup.ownerStores.length);
  expect([...corpus.backup.ownerStores].sort()).toEqual(['fuseki_data', 'postgres_data', 'rustfs_data']);
  for (const milliseconds of Object.values(corpus.preparation)) {
    expect(Number.isFinite(milliseconds) && milliseconds >= 0).toBe(true);
  }
  expect(corpus.preparation.buildMs).toBeLessThanOrEqual(600_000);
  expect(corpus.preparation.restoreMs + corpus.preparation.startupMs + corpus.preparation.readinessMs)
    .toBeLessThanOrEqual(corpus.preparation.totalMs);
  expect(corpus.preparation.totalMs).toBeLessThanOrEqual(600_000);
  expect(corpus.authority.operatorAccount).toBe(corpus.realm.identities.operator.accountId);
  expect(corpus.authority.exposure).toBe('platform:catalogue-import');
  expect(corpus.authority.grants).toEqual(expect.arrayContaining([
    expect.objectContaining({ scope: 'work:create:catalogue-import', action: 'work.create' }),
  ]));
  const records = frozenRecords(corpus.sourceRoot);
  for (const [key, source] of Object.entries(corpus.sources)) {
    const record = records.get(key);
    if (!record) throw new Error(`TEST PREMISE: source binding is outside the named selection: ${key}`);
    expect(source.parts.length).toBeGreaterThan(0);
    const buffers = source.parts.map(part => {
      const bytes = Buffer.from(part.rawBytesBase64, 'base64');
      expect(bytesDigest(bytes)).toBe(part.rawDigest);
      return bytes;
    });
    const payload = reconstructIntake(buffers) as Record<string, unknown>;
    if (payload.format === 'rezics-dataset-record-v1') expect(digest(payload.record)).toBe(digest(record));
    else if (key.startsWith('bangumi:') && record.data.api_subject) expect(digest(payload)).toBe(digest(record.data.api_subject));
    else expect(digest(payload)).toBe(digest(record.data));
  }
  for (const key of records.keys()) {
    // Releases and source-only records need not be Works. The required grains below
    // do need native bindings, and may not point at a synthetic same-name substitute.
    const target = corpus.targets[key];
    if (target) expect(target.resource).toMatch(native);
  }
  expect(corpus.selections.map(value => value.name).sort())
    .toEqual(matrix.selections.map(value => value.name).sort());
  const { restorePersonaRealms } = await import('./personas.ts');
  const [people] = await restorePersonaRealms([corpus.realm]);
  if (!people) throw new Error('Retained import personas could not be restored');
  return { corpus, people, records, close: () => people.close() };
}

export async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request, body = await response.text();
  expect(response.status, `HTTP ${status} required; got ${response.status}: ${body.slice(0, 800)}`).toBe(status);
  return JSON.parse(body) as T;
}

/** Independent test oracle for the two coordinate spaces. It does not perform
 * Source's normalization/admission or manufacture any server receipt. */
export function assertRetainedRecordInput(input: RetainedRecordInput, record: DatasetRecord,
  pin: { id: string; digest: string; fileSha256: string }, parts: Source['parts']): void {
  expect(input.identity).toEqual({ key: record.key, provider: record.provider,
    namespace: record.kind, externalId: record.externalId });
  expect(input.snapshot).toEqual({ id: pin.id, digest: pin.digest, fileSha256: pin.fileSha256 });
  expect(input.record, 'all normalized fields, including title/language/native, remain exact').toEqual(record);
  expect(input.recordDigest).toBe(digest(record));
  expect(parts.length).toBeGreaterThan(0);
  const buffers = parts.map(part => Buffer.from(part.rawBytesBase64, 'base64'));
  // This existing reader checks framing, ordered indexes, decoded byte length
  // and the assembled byte digest. Parsing does not make a record/data pointer
  // equivalent to an observation pointer.
  reconstructIntake(buffers);
  expect(input.intakes).toEqual(parts.map((part, index) => {
    if (!part.record) throw new Error('TEST PREMISE: missing actual Source record in an intake receipt');
    expect(part.record, 'retain the actual Source record in every intake receipt').toMatch(native);
    expect(bytesDigest(buffers[index]!)).toBe(part.rawDigest);
    return { index, record: part.record, observation: part.observation, byteDigest: part.rawDigest };
  }));
  const first = JSON.parse(buffers[0]!.toString()) as Record<string, unknown>;
  if (first.format === 'rezics-dataset-chunk-v1') {
    if (typeof first.digest !== 'string' || typeof first.byteLength !== 'number') {
      throw new Error('TEST PREMISE: invalid retained chunk digest or byte length');
    }
    expect(input.payload).toEqual({ format: 'rezics-dataset-chunk-v1',
      byteDigest: first.digest, byteLength: first.byteLength });
  } else {
    expect(input.payload).toEqual({ format: 'json',
      byteDigest: bytesDigest(buffers[0]!), byteLength: buffers[0]!.length });
  }
}

export function assertRetainedBinding(binding: RetainedRecordBinding, request: RetainedConversionRequest,
  conversion: string): void {
  const { record: _record, ...retained } = request.retained;
  expect(binding).toMatchObject({ ...retained, profile: 'source-retained-record-binding-v1',
    conversion, mappingRevision: request.mappingRevision });
  expect(binding.binding).toMatch(native);
  expect(binding.sourceRecord).toMatch(native);
  expect(binding.normalizationRevision.length).toBeGreaterThan(0);
}

/** Missing proposed conversion/admission results are outcome-body observations.
 * Never require their successful receipts in openImportFixture. */
export async function assertRetainedRecordAdmissions(fixture: ImportFixture): Promise<void> {
  const operator = fixture.people.operator;
  for (const sourceKey of retainedAdmissionCases) {
    const source = fixture.corpus.sources[sourceKey];
    expect(source, `TEST PREMISE: retain real intake receipts for ${sourceKey}`).toBeDefined();
    const request = source!.retainedRequest;
    expect(request, `TEST PREMISE: supply the proposed request using exact retained inputs for ${sourceKey}`).toBeDefined();
    const record = fixture.records.get(sourceKey)!;
    const pin = matrix.sources.find(value => value.provider === record.provider)!;
    assertRetainedRecordInput(request!.retained, record, pin, source!.parts);
    const path = `/v1/sources/observations/${short(source!.parts[0]!.observation)}/conversions`;
    const response = await operator.main('POST', path, request!, `import-retained-${sourceKey}`);
    expect([200, 201], 'the existing Source route verifies the complete normalized record').toContain(response.status);
    const result = await response.json() as { conversion: { conversion: string;
      retainedRecord: RetainedRecordBinding }; replayed: boolean };
    expect(result.conversion.retainedRecord).toBeDefined();
    assertRetainedBinding(result.conversion.retainedRecord, request!, result.conversion.conversion);
    const binding = result.conversion.retainedRecord;
    // Only an actual command result can introduce the canonical original record.
    // A multipart intake's part-record identity is never silently that original.
    if (source!.retainedBinding) expect(binding).toEqual(source!.retainedBinding);
    source!.retainedBinding = binding;
    const replay = await answer<typeof result>(operator.main('POST', path, request!, `import-retained-${sourceKey}`));
    expect(replay).toEqual({ ...result, replayed: true });
    const other = fixture.records.get(retainedAdmissionCases.find(key => key !== sourceKey)!)!;
    const wrongRecord = structuredClone(request!);
    wrongRecord.retained.record = other;
    wrongRecord.retained.recordDigest = digest(other);
    const wrongDigest = structuredClone(request!);
    wrongDigest.retained.recordDigest = differentDigest(request!.retained.recordDigest);
    const wrongBytes = structuredClone(request!);
    wrongBytes.retained.intakes[0]!.byteDigest = differentDigest(request!.retained.intakes[0]!.byteDigest);
    const mutations: Array<[string, RetainedConversionRequest]> = [
      ['record', wrongRecord], ['record-digest', wrongDigest], ['byte-digest', wrongBytes],
    ];
    if (request!.retained.intakes.length > 1) {
      const wrongOrder = structuredClone(request!);
      wrongOrder.retained.intakes.reverse();
      mutations.push(['part-order', wrongOrder]);
    }
    for (const [basis, body] of mutations) {
      await assertAdmissionRefusal(operator.main('POST', path, body,
        `import-retained-refuse-${sourceKey}-${basis}`), admissionRefusals.conversion, basis);
      const after = await answer<{ retainedRecord: RetainedRecordBinding }>(operator.main('GET',
        `/v1/sources/conversions/${short(binding.conversion)}`));
      expect(after.retainedRecord, 'a refusal cannot replace the admitted record binding').toEqual(binding);
    }
    const unsupported = structuredClone(request!);
    unsupported.mappingRevision = 'unregistered-import-field-map-v1';
    await assertAdmissionRefusal(operator.main('POST', path, unsupported,
      `import-retained-refuse-${sourceKey}-unverified`), admissionRefusals.unverified);
    expect((await answer<{ retainedRecord: RetainedRecordBinding }>(operator.main('GET',
      `/v1/sources/conversions/${short(binding.conversion)}`))).retainedRecord).toEqual(binding);
  }
}

const differentDigest = (value: string) => `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
export async function assertAdmissionRefusal(request: Promise<Response>,
  contract: { status: number; code: string }, basis?: string): Promise<void> {
  const response = await request;
  expect(response.status).toBe(contract.status);
  expect(await response.json()).toMatchObject({ code: contract.code, ...(basis ? { basis } : {}) });
}
export function query(person: PersonaSession, values: Record<string, string> = {}): string {
  return new URLSearchParams({ ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}), ...values }).toString();
}
export function target(fixture: ImportFixture, sourceKey: string): Target {
  const value = fixture.corpus.targets[sourceKey];
  if (!value) throw new Error(`TEST PREMISE: missing command-created native binding for ${sourceKey}`);
  expect(value.resource).toMatch(native);
  return value;
}

/** Bounded page contract: no fixed first-N, repeated cursor, changing cut or count
 * substituted for actually reaching the end. Existing reads use their own cursor key. */
export async function allPages<T>(person: PersonaSession, path: string,
  options: { cursor?: 'cursor' | 'after'; next?: 'nextCursor' | 'next'; limit?: number; collection?: 'items' | 'parts';
    parameters?: Record<string, string> } = {},
): Promise<{ items: T[]; position: Position; pages: number; generation?: string }> {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | null = null, position: Position | undefined, pages = 0, generation: string | undefined;
  do {
    const values: Record<string, string> = { ...options.parameters, limit: String(options.limit ?? 20) };
    if (cursor) values[options.cursor ?? 'cursor'] = cursor;
    const response = await person.main('GET', `${path}?${query(person, values)}`);
    if (response.status === 409 && path.endsWith('/source-coverage')) {
      const problem = await response.json() as { code: string; retry: { allowed: boolean; afterMs: number } };
      expect(problem.code).toBe('source_coverage_changed');
      expect(problem.retry.allowed).toBe(true);
      expect(problem.retry.afterMs).toBeGreaterThanOrEqual(0);
      expect(problem.retry.afterMs).toBeLessThanOrEqual(300_000);
      throw new CoverageRestart();
    }
    const page: { items?: T[]; parts?: T[]; nextCursor?: string | null; next?: string | null;
      sourcePosition: Position; generation?: string } = await answer(Promise.resolve(response));
    const entries = page[options.collection ?? 'items'];
    expect(Array.isArray(entries), 'bounded read returns its declared inventory').toBe(true);
    expect(entries!.length).toBeLessThanOrEqual(options.limit ?? 20);
    expect(page.sourcePosition.datasetId).toBe('product');
    if (position) expect(page.sourcePosition).toEqual(position);
    else position = page.sourcePosition;
    if (generation !== undefined) expect(page.generation).toBe(generation);
    else generation = page.generation;
    items.push(...entries!);
    expect(Object.hasOwn(page, options.next ?? 'nextCursor'), 'bounded read supplies an explicit end or continuation').toBe(true);
    cursor = page[options.next ?? 'nextCursor'] ?? null;
    if (cursor) {
      expect(seen.has(cursor), 'continuation must advance').toBe(false);
      seen.add(cursor);
    }
    pages++;
    expect(pages, 'bounded selected corpus must finish').toBeLessThanOrEqual(128);
  } while (cursor);
  if (!position) throw new Error('Read returned no source position');
  return { items, position, pages, ...(generation === undefined ? {} : { generation }) };
}
class CoverageRestart extends Error {}

type Binding = { role: string; participant: { kind: string; iri?: string; ref?: string } };
export type Relation = { relation: string; kind: string; revision: string | null;
  rendering: { meaning: { definition: string; revision: string }; viewingRole: string;
    bindings: Binding[] } | null; counterparts: Array<{ reference: string }> };
export type Coverage = { key: string; state: Disposition; native: Array<{ resource: string; revision: string }>;
  source: { provider: string; url: string; licence: string | null } | null;
  retry: { allowed: boolean; afterMs: number } | null };
export type Inventory = { key: string; sourceKey: string; valueDigest: string; disposition: Disposition;
  source: { provider: string; namespace: string; externalId: string; snapshotDigest: string;
    pointer: string | null; edgeIndex: number | null };
  native: Array<{ resource: string; revision: string; sourceKind?: string;
    qualifiers?: Record<string, unknown> }>; reason: string | null };

export function publicSafe(value: unknown, fixture: ImportFixture): void {
  const text = JSON.stringify(value);
  for (const secret of Object.values(fixture.corpus.hidden)) expect(text).not.toContain(secret);
  for (const key of ['rawBytesBase64', 'sourcePointer', 'byteDigest', 'captureCount', 'omittedFields',
    'retainedRecord', 'normalizationRevision', 'recordDigest', 'sourceOccurrence', 'intakes',
    'observation', 'conversion', 'proposal', 'privateCount', 'uid']) expect(text).not.toMatch(new RegExp(`"${key}"\\s*:`));
}

export async function coverage(person: PersonaSession, fixture: ImportFixture, sourceKey: string) {
  const resource = target(fixture, sourceKey).resource;
  const page = await answer<{ target: { resource: string }; sourceCoverage: { href: string } }>(
    person.main('GET', `/v1/resources/${short(resource)}/page?${query(person)}`));
  expect(page.target.resource).toBe(resource);
  expect(page.sourceCoverage.href).toBe(`/v1/resources/${short(resource)}/source-coverage`);
  const result = await allPages<Coverage>(person, page.sourceCoverage.href);
  expect(result.generation?.length, 'public projection has a stable opaque generation').toBeGreaterThan(0);
  expect(new Set(result.items.map(item => item.key)).size).toBe(result.items.length);
  publicSafe(result, fixture);
  for (const entry of result.items) {
    for (const binding of entry.native) {
      expect(binding.resource).toMatch(native);
      expect(binding.revision).toMatch(native);
    }
    if (entry.state === 'adopted') {
      expect(entry.native.length).toBeGreaterThan(0);
      expect(entry.source?.provider).toBe(fixture.records.get(sourceKey)!.provider);
      expect(entry.source?.url).toBe(fixture.records.get(sourceKey)!.sourceUrl);
    }
    else expect(entry.native).toEqual([]);
    if (entry.state === 'unknown') {
      // An unknown public state reveals neither whether evidence exists nor a retry/capture count.
      expect(entry.source).toBeNull();
      expect(entry.retry).toBeNull();
    }
  }
  return result;
}

export async function deniedSourceCommands(persona: Persona, fixture: ImportFixture): Promise<void> {
  if (persona === 'operator') return;
  const person = fixture.people[persona], selected = fixture.corpus.sources['bangumi:subject:1014'];
  if (!selected?.proposal) throw new Error('TEST PREMISE: missing real Bangumi proposal');
  if (!selected.conversion) throw new Error('TEST PREMISE: missing the real conversion behind the Bangumi proposal');
  const paths = [
    `/v1/sources/observations/${short(selected.observation)}`,
    `/v1/sources/conversions/${short(selected.conversion)}`,
    `/v1/sources/conversions/${short(selected.conversion)}/source-graph`,
    `/v1/sources/proposals/${short(selected.proposal)}`,
  ];
  const status = persona === 'visitor' ? 401 : 403;
  for (const path of paths) {
    const response = await person.main('GET', path);
    expect(response.status, `${persona} must not acquire import exposure from its role`).toBe(status);
    publicSafe(await response.json(), fixture);
  }
  const real = fixture.records.get('bangumi:subject:1014')!;
  const body = { profile: 'source-manual-intake-v1', provider: 'bangumi', namespace: 'subject',
    externalId: real.externalId, sourceRevision: matrix.sources.find(source => source.provider === 'bangumi')!.digest,
    mediaType: 'application/json', retention: 'retained',
    rawBytesBase64: Buffer.from(JSON.stringify(real.data.api_subject)).toString('base64'),
    coverage: { scope: 'bangumi-subject-response-v1', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: 'Retained bytes; authority is separately required.' } };
  const response = await person.main('POST', '/v1/sources/intakes', body, `import-denied-${persona}`);
  expect(response.status).toBe(status);
  publicSafe(await response.json(), fixture);
  const adoption = await person.main('POST', `/v1/sources/proposals/${short(selected.proposal)}/adoption/native-work`, {
    profile: 'source-native-work-adoption-v1', actingSubject: person.actingSubject ?? fixture.people.operator.actingSubject,
    confirmedTitle: real.title, titleLanguage: real.language,
  }, `adoption-denied-${persona}`);
  expect(adoption.status).toBe(status);
  publicSafe(await adoption.json(), fixture);
}

export async function assertOriginals(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  const keys = ['vndb:vn:v11', 'bangumi:subject:1014', matrix.music.album, matrix.music.recording, matrix.music.composition];
  const works: string[] = [], versions: string[] = [];
  for (const key of keys) {
    const binding = target(fixture, key), record = fixture.records.get(key)!;
    const work = await answer<{ id: string; mainVersion: string; title: { value: string; language: string };
      types: string[]; verification: string }>(person.main('GET', `/v1/works/${short(binding.resource)}?${query(person)}`));
    expect(work.id).toBe(binding.resource);
    expect(work.mainVersion).toBe(binding.mainVersion!);
    expect(work.title.value).toBe(record.title);
    if (key === 'vndb:vn:v11' || key === 'bangumi:subject:1014') expect(work.title.language).toBe('ja');
    if (key === matrix.music.album) expect(work.types).toContain('https://schema.org/MusicAlbum');
    if (key === matrix.music.recording) expect(work.types).toContain('https://schema.org/MusicRecording');
    const page = await answer<{ target: { resource: string }; work: { id: string } }>(
      person.main('GET', `/v1/resources/${short(binding.resource)}/page?${query(person)}`));
    expect(page.target.resource).toBe(binding.resource);
    expect(page.work.id).toBe(binding.resource);
    works.push(work.id); versions.push(work.mainVersion);
  }
  expect(new Set(works).size, 'composition, recording and album must not collapse by title').toBe(keys.length);
  expect(new Set(versions).size).toBe(keys.length);
}

type Statement = { kind: string; statement?: string; predicate: string; value: { kind: string; lexical?: string;
  iri?: string; datatype?: string; language?: string | null }; sources: unknown[] };
async function statements(person: PersonaSession, resource: string): Promise<Statement[]> {
  const values: Statement[] = [], seen = new Set<string>();
  let cursor: string | null = null, position: Position | undefined;
  do {
    const parameters: Record<string, string> = { limit: '20' };
    if (cursor) parameters.cursor = cursor;
    const page: { groups: Array<{ items: Statement[] }>; nextCursor: string | null; sourcePosition: Position } =
      await answer(person.main('GET', `/v1/resources/${short(resource)}/statements?${query(person, parameters)}`));
    if (position) expect(page.sourcePosition).toEqual(position);
    else position = page.sourcePosition;
    values.push(...page.groups.flatMap(group => group.items));
    expect(Object.hasOwn(page, 'nextCursor')).toBe(true);
    cursor = page.nextCursor;
    if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); }
    expect(seen.size).toBeLessThan(128);
  } while (cursor);
  return values;
}

export async function assertNativeFacts(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  const pages = new Map<string, Statement[]>();
  for (const fact of matrix.facts) {
    let items = pages.get(fact.sourceKey);
    if (!items) { items = await statements(person, target(fixture, fact.sourceKey).resource); pages.set(fact.sourceKey, items); }
    const matching = items.filter(item => item.predicate === fact.predicate
      && item.value.kind === 'literal' && item.value.lexical === String(fact.value));
    expect(matching.length, `positive native fact: ${fact.sourceKey} ${fact.predicate}=${fact.value}`).toBe(1);
    expect(matching[0]!.sources.length, 'adopted fact keeps visible attribution').toBeGreaterThan(0);
    if (typeof fact.value === 'number') expect(matching[0]!.value.datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
    if (fact.publicKey === 'duration') expect(matching[0]!.value.datatype).toBe('http://www.w3.org/2001/XMLSchema#duration');
  }
  const index = target(fixture, 'bangumi:subject:1014').resource;
  expect((pages.get('bangumi:subject:1014') ?? []).some(item => item.predicate === 'https://schema.org/numberOfVolumes'
    && item.value.lexical === '0'), 'source zero sentinel is not a known zero volume count').toBe(false);
  const synopsis = await answer<{ description: { value: string; language: string } | null;
    descriptionObligations: unknown[] }>(person.main('GET', `/v1/works/${short(index)}?${query(person)}`));
  const raw = fixture.records.get('bangumi:subject:1014')!.data.api_subject as { summary: string };
  expect(synopsis.description?.value).toBe(raw.summary);
  expect(JSON.stringify(synopsis.descriptionObligations)).toContain('Bangumi');
  expect(JSON.stringify(synopsis.descriptionObligations)).toMatch(/CC-BY-SA-3\.0|creativecommons\.org\/licenses\/by-sa\/3\.0/);
  const localized = await answer<{ title: { value: string; language: string } }>(person.main('GET',
    `/v1/works/${short(index)}?${query(person, { language: 'zh' })}`));
  expect(localized.title).toMatchObject({ value: (fixture.records.get('bangumi:subject:1014')!.data.api_subject as { name_cn: string }).name_cn,
    language: 'zh' });
  const aliases = String(fixture.records.get('vndb:vn:v11')!.data.alias).split('\n');
  const fate = pages.get('vndb:vn:v11')!;
  for (const alias of aliases) expect(fate.some(item => item.predicate === 'https://schema.org/alternateName'
    && item.value.lexical === alias), `native alias retains the exact source spelling: ${alias}`).toBe(true);
}

export async function assertNativeRelations(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  const cache = new Map<string, Awaited<ReturnType<typeof allPages<Relation>>>>();
  const pageFor = async (key: string) => {
    let value = cache.get(key);
    if (!value) {
      value = await allPages<Relation>(person, `/v1/resources/${short(target(fixture, key).resource)}/relations`,
        { cursor: 'after', next: 'next', limit: 20 });
      expect(new Set(value.items.map(item => item.relation)).size).toBe(value.items.length);
      cache.set(key, value);
    }
    return value;
  };
  const meaningByKind = new Map<string, string>();
  for (const expected of matrix.relations) {
    const binding = fixture.corpus.relations[expected.inventoryKey];
    const source = target(fixture, expected.sourceKey).resource, destination = target(fixture, expected.targetSourceKey).resource;
    const forward = await pageFor(expected.sourceKey), inverse = await pageFor(expected.targetSourceKey);
    const relation = forward.items.find(item => binding ? item.relation === binding.occurrence
      : item.rendering?.bindings.some(value => value.participant.kind === 'resource' && value.participant.ref === destination));
    expect(relation, `native occurrence for ${expected.kind} -> ${expected.targetSourceKey}`).toBeDefined();
    expect(relation!.kind).toBe('occurrence');
    expect(relation!.revision).toMatch(native);
    expect(relation!.rendering).not.toBeNull();
    if (binding) expect(relation!.rendering!.meaning).toMatchObject({ definition: binding.definition, revision: binding.definitionRevision });
    expect(relation!.rendering?.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: expected.fromRole, participant: { kind: 'resource', ref: source } }),
      expect.objectContaining({ role: expected.toRole, participant: { kind: 'resource', ref: destination } }),
    ]));
    expect(relation!.rendering!.viewingRole).toBe(expected.fromRole);
    const inverseOccurrence = inverse.items.find(item => item.relation === relation!.relation);
    expect(inverseOccurrence, 'same exact occurrence is navigable in reverse').toBeDefined();
    expect(inverseOccurrence!.rendering?.viewingRole).toBe(expected.toRole);
    const priorMeaning = meaningByKind.get(expected.kind);
    if (priorMeaning) expect(relation!.rendering!.meaning.definition).toBe(priorMeaning);
    meaningByKind.set(expected.kind, relation!.rendering!.meaning.definition);
  }
  expect(new Set(meaningByKind.values()).size, 'different source relation types cannot become one generic related meaning')
    .toBe(meaningByKind.size);
  expect((await pageFor('vndb:vn:v11')).pages).toBeGreaterThan(1);
}

export async function assertNativeTags(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  for (const key of ['vndb:vn:v11', 'bangumi:subject:1014']) {
    const expected = matrix.tags.filter(tag => tag.sourceKey === key && (!('nativeRequired' in tag) || tag.nativeRequired));
    const result = await allPages<{ concept: string; sense: string; name: { value: string }; decision: string;
      relevanceStatus: string; relevance: unknown }>(person, `/v1/works/${short(target(fixture, key).resource)}/classifications`);
    const concepts = result.items.map(item => item.concept);
    for (const tag of expected) {
      expect(concepts.filter(value => value === target(fixture, tag.tagKey).resource).length,
        `accepted tag identity and meaning survive: ${tag.tagKey}`).toBe(1);
      expect(result.items.find(item => item.concept === target(fixture, tag.tagKey).resource)?.name.value).toBe(tag.name);
    }
    if (key.startsWith('bangumi:')) expect(result.pages, 'all 29 accepted tags pass the first page').toBeGreaterThan(1);
    for (const entry of result.items) {
      expect(entry.sense).toMatch(native);
      expect(entry.decision).toBe('accepted');
      expect(entry.relevanceStatus, 'imported source aggregate is not a native editor assessment').toBe('unrecorded');
      expect(entry.relevance).toBeNull();
    }
    if (person.accountId) {
      const accepted = await statements(person, target(fixture, key).resource);
      const tagStatements = accepted.filter(item => item.kind === 'statement'
        && item.predicate === 'https://rezics.com/vocab/classifiedAs'
        && item.value.kind === 'resource' && concepts.includes(item.value.iri!));
      expect(tagStatements.length).toBeGreaterThanOrEqual(expected.length);
      for (const statement of tagStatements) {
        const judgment = await answer<{ fit: { sampleSize: number }; spoiler: { sampleSize: number } }>(
          person.main('GET', `/v1/statements/${short(statement.statement!)}/judgments`));
        expect(judgment.fit.sampleSize, 'retained source votes must not become native voters').toBe(0);
        expect(judgment.spoiler.sampleSize).toBe(0);
      }
    }
  }
}

export async function assertMusicGrain(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  const music = matrix.music, album = target(fixture, music.album), composition = target(fixture, music.composition);
  const recording = target(fixture, music.recording);
  const releases = await allPages<{ id: string; kind: string; status: string; titleLanguage: string | null;
    publicationYear: number | null; territory: string | null; identifiers: Array<{ provider: string; value: string }>;
    coverage: Array<{ realization: string | null; completeness: string }> }>(person,
  `/v1/works/${short(album.resource)}/releases`);
  const selected = releases.items.find(value => value.identifiers.some(identifier => identifier.provider === 'musicbrainz'
    && identifier.value === music.release.split(':').at(-1)));
  expect(selected, 'retained release must be a selectable native release, not only a PublicationEvent label').toBeDefined();
  const release = selected!.id;
  if (fixture.corpus.music.release) expect(release).toBe(fixture.corpus.music.release.resource);
  expect(selected).toMatchObject({ status: 'official', titleLanguage: music.titleLanguage,
    publicationYear: music.releaseYear, territory: music.territory });
  expect(selected!.identifiers).toContainEqual({ provider: 'musicbrainz', value: music.release.split(':').at(-1)! });
  expect(selected!.coverage.some(value => value.realization !== null && value.completeness === 'complete'),
    'descriptive release capture proves no full playable realization').toBe(false);
  type Part = { occurrence: string; parent: string; role: string; orderKey: string; labels: Array<{ value: string }>;
    work: string | null; mainVersion: string | null };
  const media = await allPages<Part>(person, `/v1/resources/${short(release)}/parts`,
    { cursor: 'after', next: 'next', collection: 'parts' });
  const groups = media.items.filter(value => value.role === 'group');
  expect(groups.length, 'one elected medium remains a distinct ordered group').toBe(1);
  const parts = await allPages<Part>(person, `/v1/resources/${short(release)}/parts`,
    { cursor: 'after', next: 'next', collection: 'parts', parameters: { parent: groups[0]!.occurrence } });
  const occurrence = parts.items.find(value => value.work === recording.resource
    && value.labels.some(label => label.value === music.trackTitle));
  expect(occurrence, 'track is a release/medium occurrence, not the recording Work').toBeDefined();
  if (fixture.corpus.music.track) expect(occurrence!.occurrence).toBe(fixture.corpus.music.track.resource);
  expect(new Set([album.resource, composition.resource, recording.resource, release, occurrence!.occurrence]).size).toBe(5);
  expect(occurrence).toMatchObject({ role: 'part', parent: groups[0]!.occurrence,
    work: recording.resource, mainVersion: recording.mainVersion });
  expect(occurrence!.orderKey.length).toBeGreaterThan(0);
  expect(occurrence!.labels.some(label => label.value === music.trackTitle)).toBe(true);
  const trackFacts = await statements(person, occurrence!.occurrence);
  expect(trackFacts.some(item => item.predicate === 'https://schema.org/duration'
    && item.value.lexical === 'PT3079.093S'), 'track and recording durations retain different exact values').toBe(true);
  for (const [resource, ordinal] of [[groups[0]!.occurrence, music.medium], [occurrence!.occurrence, music.position]] as const) {
    const facts = await statements(person, resource);
    expect(facts.some(item => item.predicate === 'https://schema.org/position' && item.value.lexical === String(ordinal))).toBe(true);
  }
  const unknown = await coverage(person, fixture, music.unknownRelease);
  expect(unknown.items.find(item => item.key === 'release-status')?.state).toBe('unknown');
}

function pointerValue(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object') throw new Error(`Retained pointer is absent: ${pointer}`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export async function replaySelections(fixture: ImportFixture): Promise<void> {
  const person = fixture.people.operator;
  for (const selected of fixture.corpus.selections) {
    expect(selected.commands.length, 'selection must have actual public command receipts').toBeGreaterThan(0);
    for (const command of selected.commands) {
      expect(command.path).toMatch(/^\/v1\/(?:sources\/|semantic\/changes|works(?:\/|$)|relations\/changes|compositions(?:\/|$))/);
      expect(Object.keys(command.identity).length, 'replay must compare actual returned identities').toBeGreaterThan(0);
      const response = await person.main(command.method, command.path, command.body, command.key);
      expect([200, 201]).toContain(response.status);
      const body = await response.json();
      for (const [pointer, identity] of Object.entries(command.identity)) expect(pointerValue(body, pointer)).toBe(identity);
    }
  }
  await assertOriginals(person, fixture);
}

export async function assertCoverageStates(person: PersonaSession, fixture: ImportFixture): Promise<void> {
  const bySource = new Map<string, Coverage[]>();
  for (const row of matrix.inventory) {
    if (!('publicKey' in row) || !row.publicKey) continue;
    let items = bySource.get(row.sourceKey);
    if (!items) { items = (await coverage(person, fixture, row.sourceKey)).items; bySource.set(row.sourceKey, items); }
    const entry = items.find(item => item.key === row.publicKey);
    expect(entry, `public field coverage is discoverable: ${row.sourceKey} ${row.publicKey}`).toBeDefined();
    expect(row.disposition).toBe(entry!.state);
    if (row.disposition === 'acquisition-failed') {
      expect(entry!.retry).toMatchObject({ allowed: true });
      expect(entry!.retry!.afterMs).toBeGreaterThanOrEqual(0);
      expect(entry!.retry!.afterMs).toBeLessThanOrEqual(300_000);
      const binding = target(fixture, row.sourceKey);
      const identity = await answer<{ id: string; title: { value: string } }>(
        person.main('GET', `/v1/works/${short(binding.resource)}?${query(person)}`));
      expect(identity.id).toBe(binding.resource);
      expect(identity.title.value).toBe(fixture.records.get(row.sourceKey)!.title);
    }
  }
  const status = await answer<{ profile: string; importState: string; contentReady: boolean }>(person.main('GET',
    `/v1/resources/${short(target(fixture, matrix.music.album).resource)}/source-coverage?${query(person, { limit: '20' })}`));
  expect(status.profile).toBe('resource-source-coverage-v1');
  expect(status.importState).toBe('completed');
  expect(status.contentReady, 'a descriptive completed import has no proven audio realization').toBe(false);
  const hidden = await person.main('GET', `/v1/resources/${short(fixture.corpus.hidden.resource)}/source-coverage?${query(person)}`);
  const absent = await person.main('GET', `/v1/resources/00000000-0000-4000-8000-000000000000/source-coverage?${query(person)}`);
  expect(hidden.status).toBe(404); expect(absent.status).toBe(404);
  const unavailable = await hidden.json();
  expect(unavailable).toEqual(await absent.json());
  publicSafe(unavailable, fixture);
}

export async function assertInventory(fixture: ImportFixture): Promise<void> {
  const person = fixture.people.operator, observed: Inventory[] = [];
  for (const sourceKey of new Set(matrix.inventory.map(row => row.sourceKey))) {
    const source = fixture.corpus.sources[sourceKey];
    if (!source) throw new Error(`TEST PREMISE: missing retained conversion for ${sourceKey}`);
    expect(source.conversion, `retained ${sourceKey} has a real Source conversion`).toBeDefined();
    const page = await allPages<Inventory>(person, `/v1/sources/conversions/${short(source.conversion!)}/inventory`);
    expect(page.items.every(item => item.sourceKey === sourceKey)).toBe(true);
    observed.push(...page.items);
    // Exact-byte readback is the existing export of the retained observation. It is
    // not replaced with a public coverage summary or a guessed native equivalent.
    for (const part of source.parts) {
      const evidence = await answer<{ rawBytesBase64: string; byteDigest: string }>(
        person.main('GET', `/v1/sources/observations/${short(part.observation)}`));
      expect(evidence.rawBytesBase64).toBe(part.rawBytesBase64);
      expect(bytesDigest(Buffer.from(evidence.rawBytesBase64, 'base64'))).toBe(part.rawDigest);
      expect(evidence.byteDigest).toBe(part.rawDigest);
    }
  }
  assertDispositionConservation(observed, matrix.inventory);
  for (const expected of matrix.inventory) {
    const actual = observed.find(row => row.key === expected.key)!;
    expect(actual).toMatchObject({ sourceKey: expected.sourceKey, valueDigest: expected.valueDigest,
      disposition: expected.disposition });
    for (const binding of actual.native) {
      expect(binding.resource).toMatch(native);
      expect(binding.revision).toMatch(native);
    }
    const record = fixture.records.get(expected.sourceKey)!;
    const pin = matrix.sources.find(source => source.provider === record.provider)!;
    expect(actual.source).toMatchObject({ provider: record.provider, namespace: record.kind,
      externalId: record.externalId, snapshotDigest: pin.digest,
      pointer: 'pointer' in expected ? expected.pointer : null,
      edgeIndex: 'edgeIndex' in expected ? expected.edgeIndex : null });
    if (expected.disposition === 'adopted') expect(actual.native.length).toBeGreaterThan(0);
    else { expect(actual.native).toEqual([]); expect(actual.reason?.length).toBeGreaterThan(0); }
    const relation = matrix.relations.find(row => row.inventoryKey === expected.key);
    if (relation) {
      const receipt = fixture.corpus.relations[expected.key];
      expect(actual.native).toContainEqual(expect.objectContaining({
        ...(receipt ? { resource: receipt.occurrence } : {}),
        sourceKind: relation.kind, qualifiers: relation.qualifiers,
      }));
    }
  }
  // Operator exposure does not publish another principal's evidence.
  for (const [path, absent] of [
    [`/v1/sources/observations/${short(fixture.corpus.hidden.observation)}`, '/v1/sources/observations/00000000-0000-4000-8000-000000000000'],
    [`/v1/sources/conversions/${short(fixture.corpus.hidden.conversion)}`, '/v1/sources/conversions/00000000-0000-4000-8000-000000000000'],
  ]) {
    const denied = await person.main('GET', path!), missing = await person.main('GET', absent!);
    expect(denied.status).toBe(404); expect(missing.status).toBe(404);
    expect(await denied.json()).toEqual(await missing.json());
  }
}

export async function confirmHumanValue(fixture: ImportFixture): Promise<void> {
  const owner = fixture.people.owner, work = target(fixture, 'bangumi:subject:1014').resource;
  const path = `/v1/works/${short(work)}/fields/synopsis/control`;
  const before = await answer<Control>(owner.main('GET', `${path}?${query(owner)}`));
  const sourceValue = (fixture.records.get('bangumi:subject:1014')!.data.api_subject as { summary: string }).summary;
  expect(before.value).toBe(sourceValue);
  if (before.mode === 'human-controlled' && fixture.staleSourceFieldBody) return;
  expect(before.mode, 'restore starts with an actual source-managed synopsis').toBe('source-managed');
  const source = fixture.corpus.sources['bangumi:subject:1014']!;
  expect(source.conversion, 'the source-managed synopsis retains its actual conversion').toBeDefined();
  const conversion = await answer<{ mappingRevision: string }>(fixture.people.operator.main('GET',
    `/v1/sources/conversions/${short(source.conversion!)}`));
  fixture.staleSourceFieldBody = { profile: 'work-editorial-field-control-v1', field: 'synopsis',
    expectedWorkHead: before.workHead, basis: { contentHead: before.contentHead, head: before.controlHead,
      epoch: before.controlEpoch, protection: before.protectionHead }, value: sourceValue, origin: 'source',
    source: { record: source.record, observation: source.observation, conversion: source.conversion,
      mapping: conversion.mappingRevision }, actingSubject: fixture.people.operator.actingSubject };
  const body = { profile: 'work-editorial-field-control-v1', field: 'synopsis', expectedWorkHead: before.workHead,
    basis: { contentHead: before.contentHead, head: before.controlHead, epoch: before.controlEpoch,
      protection: before.protectionHead }, value: before.value, origin: 'human', source: null, actingSubject: owner.actingSubject };
  expect(before.value, 'human confirms the exact source value; no invented replacement source').not.toBeNull();
  const confirmed = await answer<{ content: string; control: string }>(owner.main('POST', path, body, 'import-human-same-value'), 201);
  const after = await answer<Control>(owner.main('GET', `${path}?${query(owner)}`));
  expect(after).toMatchObject({ value: before.value, mode: 'human-controlled', contentHead: confirmed.content,
    controlHead: confirmed.control });
  const second = await answer<{ replayed: boolean; content: string; control: string }>(
    owner.main('POST', path, body, 'import-human-same-value'));
  expect(second).toMatchObject({ replayed: true, content: confirmed.content, control: confirmed.control });
}

type Support = { support: string; supportIdentity: string; sourceRecord: string; state: string;
  nativeRevision: string; withdrawal: { nativeEffect: string } | null; admission?: RetainedSupportAdmission };

export function assertRetainedSupportAdmission(admission: RetainedSupportAdmission,
  request: RetainedSupportRequest): void {
  expect(admission.profile).toBe('source-field-support-admission-v1');
  expect(admission.sourceRecord).toBe(request.sourceRecord);
  expect(admission.conversion).toBe(request.conversion);
  expect(admission.evidence).toEqual(request.evidence);
  expect(admission.correspondence.normalizationRevision.length).toBeGreaterThan(0);
  expect(admission.correspondence.rule.length).toBeGreaterThan(0);
  expect(admission.correspondence.payloadPointers.length).toBeGreaterThan(0);
  expect(admission.native).toEqual(request.native);
  expect(['transaction-guarded', 'verified-before-commit']).toContain(admission.headGuarantee);
  expect(request.native.target).toBe(request.target);
  expect(request.native.revision).toBe(request.expectedHead);
}

export function assertRetainedFieldCoordinate(actual: RetainedFieldCoordinate, record: DatasetRecord,
  expected: { pointer: string; language?: string | null; ordinal?: number }): unknown {
  expect(actual.pointer).toBe(expected.pointer);
  for (const optional of ['language', 'ordinal'] as const) {
    expect(Object.hasOwn(actual, optional), `${optional}: omitted is distinct from null or a supplied value`)
      .toBe(Object.hasOwn(expected, optional));
    expect(actual[optional]).toEqual(expected[optional]);
  }
  const value = pointerValue(record, expected.pointer);
  const presence = value === undefined ? 'omitted' : value === null ? 'null' : value === '' ? 'empty-string'
    : Array.isArray(value) && !value.length ? 'empty-array'
      : value && typeof value === 'object' && !Object.keys(value).length ? 'empty-object' : 'value';
  expect(actual.presence).toBe(presence);
  expect(Object.hasOwn(actual, 'valueDigest')).toBe(presence !== 'omitted');
  if (presence !== 'omitted') expect(actual.valueDigest).toBe(digest(value));
  if (expected.ordinal === undefined) return value;
  expect(typeof value).toBe('string');
  expect(Number.isSafeInteger(expected.ordinal) && expected.ordinal >= 0).toBe(true);
  const lines = (value as string).split(/\r?\n/);
  expect(expected.ordinal).toBeLessThan(lines.length);
  return lines[expected.ordinal];
}

export function supportAdmissionMutations(body: RetainedSupportRequest,
  other: { record: string; conversion: string; target: string; head: string }): Array<[string, RetainedSupportRequest]> {
  const mutation = (basis: string, change: (copy: RetainedSupportRequest) => void): [string, RetainedSupportRequest] => {
    const copy = structuredClone(body); change(copy); return [basis, copy];
  };
  return [
    mutation('record', copy => { copy.sourceRecord = other.record; }),
    mutation('record-digest', copy => { copy.evidence.recordDigest = differentDigest(copy.evidence.recordDigest); }),
    mutation('conversion', copy => { copy.conversion = other.conversion; }),
    mutation('value-digest', copy => { copy.evidence.field.valueDigest = differentDigest(copy.evidence.field.valueDigest!); }),
    mutation('native-target', copy => { copy.native.target = other.target; }),
    mutation('native-value', copy => {
      if (copy.native.kind === 'component-property') copy.native.property.value = { kind: 'string', lexical: 'Deliberately wrong native value' };
      else copy.native.value = { kind: 'literal', lexical: 'Deliberately wrong native value',
        datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null };
    }),
    mutation('native-head', copy => { copy.expectedHead = other.head; copy.native.revision = other.head; }),
  ];
}

export async function assertIndependentWithdrawal(fixture: ImportFixture): Promise<void> {
  const operator = fixture.people.operator, contract = matrix.independentSupport;
  if (!operator.actingSubject) throw new Error('TEST PREMISE: the authorized fixture operator must have an acting subject');
  const resource = target(fixture, contract.targetSourceKey).resource;
  const supports: Support[] = [];
  // Different records whose exact retained references denote the same artist. This
  // asserts independence of support bindings, not epistemic independence of mirrors.
  for (const [index, evidence] of contract.evidence.entries()) {
    const source = fixture.corpus.sources[evidence.sourceKey];
    if (!source) throw new Error(`TEST PREMISE: missing independent real evidence ${evidence.sourceKey}`);
    expect(pointerValue(fixture.records.get(evidence.sourceKey)!.data, evidence.pointer)).toBe(contract.value);
    expect(source.retainedBinding, 'Source admitted the exact normalized record, not a guessed observation path').toBeDefined();
    const binding = source.retainedBinding!;
    const body: RetainedSupportRequest = { profile: 'source-field-support-attachment-v2', target: resource, slot: contract.slot,
      occurrence: null, context: 'global', sourceRecord: binding.sourceRecord, conversion: binding.conversion,
      grain: evidence.grain, sourceField: evidence.field, sourceOccurrence: null,
      expectedHead: fixture.corpus.music.nameHead, actingSubject: operator.actingSubject,
      evidence: { binding: binding.binding, recordDigest: binding.recordDigest, mappingRevision: binding.mappingRevision,
        field: { pointer: `/data${evidence.pointer}`, presence: 'value', valueDigest: digest(contract.value) } },
      native: { kind: 'component-property', target: resource, revision: fixture.corpus.music.nameHead,
        property: { predicate: 'https://schema.org/name', value: { kind: 'string', lexical: contract.value } } } };
    expect(assertRetainedFieldCoordinate(body.evidence.field, fixture.records.get(evidence.sourceKey)!,
      { pointer: `/data${evidence.pointer}` })).toBe(contract.value);
    const attached = await answer<{ support: Support; replayed: boolean }>(operator.main('POST',
      '/v1/sources/field-supports', body, `import-independent-${index}`), 201);
    expect(attached.support).toMatchObject({ state: 'recorded', sourceRecord: binding.sourceRecord,
      nativeRevision: fixture.corpus.music.nameHead });
    expect(attached.support.admission).toBeDefined();
    assertRetainedSupportAdmission(attached.support.admission!, body);
    const payload = reconstructIntake(source.parts.map(part => Buffer.from(part.rawBytesBase64, 'base64'))) as Record<string, unknown>;
    const payloadPointer = payload.format === 'rezics-dataset-record-v1'
      ? `/record/data${evidence.pointer}` : evidence.pointer;
    expect(pointerValue(payload, payloadPointer), 'actual retained MusicBrainz payload at its own coordinate').toBe(contract.value);
    expect(attached.support.admission!.correspondence).toMatchObject({ normalizationRevision: binding.normalizationRevision,
      payloadPointers: [payloadPointer], selectedValueDigest: digest(contract.value) });
    const duplicate = await answer<typeof attached>(operator.main('POST', '/v1/sources/field-supports', body, `import-independent-${index}`));
    expect(duplicate).toEqual({ ...attached, replayed: true });
    // A new request key for the same source record still names one support binding.
    const repeated = await operator.main('POST', '/v1/sources/field-supports', body, `import-independent-repeat-${index}`);
    expect([200, 201]).toContain(repeated.status);
    const sameRecord = await repeated.json() as typeof attached;
    expect(sameRecord.support.support).toBe(attached.support.support);
    expect(sameRecord.support.supportIdentity).toBe(attached.support.supportIdentity);
    const otherEvidence = contract.evidence.find(value => value.sourceKey !== evidence.sourceKey)!;
    const otherSource = fixture.corpus.sources[otherEvidence.sourceKey]!;
    const otherTarget = target(fixture, 'bangumi:subject:1014');
    expect(otherSource.retainedBinding).toBeDefined();
    for (const [basis, refused] of supportAdmissionMutations(body, { record: otherSource.retainedBinding!.sourceRecord,
      conversion: otherSource.retainedBinding!.conversion, target: otherTarget.resource, head: otherTarget.revision })) {
      await assertAdmissionRefusal(operator.main('POST', '/v1/sources/field-supports', refused,
        `import-independent-refuse-${index}-${basis}`), admissionRefusals.support, basis);
      expect(await answer<Support>(operator.main('GET', `/v1/sources/field-supports/${short(attached.support.support)}`)))
        .toEqual(attached.support);
    }
    const wrongPointer = structuredClone(body); wrongPointer.evidence.field.pointer += '/0';
    const wrongOrdinal = structuredClone(body); wrongOrdinal.evidence.field.ordinal = 0;
    const wrongOccurrence = structuredClone(body); wrongOccurrence.sourceOccurrence = `urn:rezics:source-occurrence:${digest('wrong occurrence basis')}`;
    const unsupported = structuredClone(body); unsupported.slot = 'semantic-property-v1#https://schema.org/unregisteredImportField';
    for (const [label, refused, refusal] of [
      ['pointer', wrongPointer, admissionRefusals.coordinate],
      ['ordinal', wrongOrdinal, admissionRefusals.coordinate],
      ['occurrence', wrongOccurrence, admissionRefusals.coordinate],
      ['unverified', unsupported, admissionRefusals.unverified],
    ] as const) {
      await assertAdmissionRefusal(operator.main('POST', '/v1/sources/field-supports', refused,
        `import-independent-refuse-${index}-${label}`), refusal);
      expect(await answer<Support>(operator.main('GET', `/v1/sources/field-supports/${short(attached.support.support)}`)))
        .toEqual(attached.support);
    }
    supports.push(attached.support);
  }
  expect(supports[0]!.sourceRecord).not.toBe(supports[1]!.sourceRecord);
  expect(supports[0]!.support).not.toBe(supports[1]!.support);
  const first = supports[0]!, body = { profile: 'source-support-withdrawal-v1', support: first.support,
    expectedSupport: first.supportIdentity, reason: 'Withdraw this elected record support; preserve the other binding.' };
  const withdrawn = await answer<{ support: Support; replayed: boolean }>(operator.main('POST',
    '/v1/sources/withdrawals', body, 'import-withdraw-one'), 201);
  expect(withdrawn.support).toMatchObject({ state: 'withdrawn', withdrawal: { nativeEffect: 'none' } });
  expect(await answer(operator.main('POST', '/v1/sources/withdrawals', body, 'import-withdraw-one')))
    .toEqual({ ...withdrawn, replayed: true });
  const remaining = await answer<Support>(operator.main('GET', `/v1/sources/field-supports/${short(supports[1]!.support)}`));
  expect(remaining).toMatchObject({ support: supports[1]!.support, state: 'recorded', withdrawal: null });
  const page = await answer<{ summary: { name: { value: string } } }>(fixture.people.visitor.main('GET',
    `/v1/resources/${short(resource)}/page`));
  expect(page.summary.name.value).toBe(contract.value);
}

export async function assertHumanSupportWithdrawal(fixture: ImportFixture): Promise<void> {
  const support = fixture.corpus.synopsisSupport;
  expect(support, 'source-origin synopsis retains its real independently withdrawable support').toBeDefined();
  const work = target(fixture, 'bangumi:subject:1014').resource, owner = fixture.people.owner;
  const path = `/v1/works/${short(work)}/fields/synopsis/control?${query(owner)}`;
  const before = await answer<Control>(owner.main('GET', path));
  expect(before.mode).toBe('human-controlled');
  expect(before.value).toBe((fixture.records.get('bangumi:subject:1014')!.data.api_subject as { summary: string }).summary);
  const body = { profile: 'source-support-withdrawal-v1', support: support!.support,
    expectedSupport: support!.supportIdentity, reason: 'Withdraw source support after same-value human confirmation.' };
  const withdrawn = await answer<{ support: Support; replayed: boolean }>(fixture.people.operator.main('POST',
    '/v1/sources/withdrawals', body, 'import-withdraw-human-confirmed-source'), 201);
  expect(withdrawn.support).toMatchObject({ support: support!.support, state: 'withdrawn', withdrawal: { nativeEffect: 'none' } });
  expect(await answer(owner.main('GET', path)), 'withdrawing source support does not revoke the human confirmation').toEqual(before);
  expect(await answer(fixture.people.operator.main('POST', '/v1/sources/withdrawals', body, 'import-withdraw-human-confirmed-source')))
    .toEqual({ ...withdrawn, replayed: true });
  await assertNativeFacts(fixture.people.visitor, fixture);
}

export async function assertAtomicRefresh(fixture: ImportFixture): Promise<void> {
  const operator = fixture.people.operator, refresh = fixture.corpus.refresh;
  const synopsis = `/v1/works/${short(target(fixture, 'bangumi:subject:1014').resource)}/fields/synopsis/control`;
  const humanBefore = await answer<Control>(fixture.people.owner.main('GET', `${synopsis}?${query(fixture.people.owner)}`));
  expect(fixture.staleSourceFieldBody).toBeDefined();
  const stale = await operator.main('POST', synopsis, fixture.staleSourceFieldBody!, 'import-source-before-human');
  expect(stale.status, 'same-value human confirmation invalidates the preceding source control basis').toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'field_control_changed' });
  expect(await answer(fixture.people.owner.main('GET', `${synopsis}?${query(fixture.people.owner)}`))).toEqual(humanBefore);
  expect(refresh.baseConversion).not.toBe(refresh.candidateConversion);
  expect(refresh.oldGeneration).not.toBe(refresh.newGeneration);
  const prior = await answer(operator.main('GET', `/v1/sources/conversions/${short(refresh.baseConversion)}/source-graph`));
  const source = target(fixture, refresh.sourceKey).resource;
  const historical = await coverage(fixture.people.visitor, fixture, refresh.sourceKey);
  expect(historical.generation).toBe(refresh.oldGeneration);
  const command = refresh.command;
  expect(command.path).toMatch(/^\/v1\/works\/[a-f0-9-]{36}\/source-title-applications\/[a-f0-9-]{36}$/);
  const [write, read] = await Promise.all([
    operator.main(command.method, command.path, command.body, command.key),
    coverage(fixture.people.visitor, fixture, refresh.sourceKey).catch((error: unknown) => {
      if (error instanceof CoverageRestart) return null;
      throw error;
    }),
  ]);
  expect([200, 201]).toContain(write.status);
  if (read) expect([refresh.oldGeneration, refresh.newGeneration]).toContain(read.generation!);
  // allPages pins the cut and checks generation on every page; a mixed old/new
  // projection cannot pass by happening to leave the final count unchanged.
  const after = await coverage(fixture.people.visitor, fixture, refresh.sourceKey);
  expect(after.generation).toBe(refresh.newGeneration);
  const replay = await operator.main(command.method, command.path, command.body, command.key);
  expect(replay.status).toBe(200);
  expect(await answer(operator.main('GET', `/v1/sources/conversions/${short(refresh.baseConversion)}/source-graph`))).toEqual(prior);
  const identity = await answer<{ id: string; mainVersion: string }>(fixture.people.visitor.main('GET', `/v1/works/${short(source)}`));
  expect(identity).toMatchObject({ id: source, mainVersion: target(fixture, refresh.sourceKey).mainVersion });
  const human = await answer<Control>(fixture.people.owner.main('GET',
    `/v1/works/${short(target(fixture, 'bangumi:subject:1014').resource)}/fields/synopsis/control?${query(fixture.people.owner)}`));
  expect(human.mode, 'source refresh preserves the independently confirmed field').toBe('human-controlled');
  expect(human).toEqual(humanBefore);
}

export function assertDispositionConservation(actual: Array<{ key: string; sourceKey: string; valueDigest: string;
  disposition: string; native: unknown[]; reason: string | null }>, expected: Array<{ key: string; sourceKey: string;
  valueDigest: string; disposition: string }>): void {
  expect(actual.map(row => row.key).sort(), 'no skipped, extra or duplicate selected disposition')
    .toEqual(expected.map(row => row.key).sort());
  for (const row of expected) {
    const found = actual.find(item => item.key === row.key)!;
    expect(found).toMatchObject({ key: row.key, sourceKey: row.sourceKey, valueDigest: row.valueDigest,
      disposition: row.disposition });
    if (row.disposition === 'adopted') expect(found.native.length, 'required native positives cannot become source-only').toBeGreaterThan(0);
    else { expect(found.native).toEqual([]); expect(found.reason?.length).toBeGreaterThan(0); }
  }
}
