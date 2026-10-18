import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonicalJson } from '../../../../scripts/lib/canonical-json.ts';
import type { SemanticValue } from '../../../../services/main/src/modules/semantic/value.ts';
import { sectionIds } from '../../../../services/main/src/modules/entity-page/contract.ts';
import {
  collectionCases, fieldStates, informationMatrix, nativeAttachmentRefusals, nativeReadCases,
  orderCases, supportingRecords, type CollectionKey, type FieldState, type NativeReadKey, type NativeRefusalKey,
  type SupportingKey,
} from '../../fixtures/catalogue-information-matrix.ts';
import {
  restorePersonaRealms, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../support/personas.ts';

import type {
  FactValue, Support, FrozenSupport, FactExpectation, EdgeExpectation, PartExpectation,
  CollectionFixture, InformationCorpus, Qualifiers, Acceptance, FixtureCommand,
  NativeAdmissionFixture, NativeReadFixture, NativeSupportAttachment, NativeSupportReceipt,
  ReadableEvidence,
} from '../../fixtures/catalogue-information-contract.ts';
export type {
  FactValue, Support, FrozenSupport, FactExpectation, ResourceFixture, EdgeExpectation,
  PartExpectation, OrderedFixture, CollectionFixture, InformationCorpus,
} from '../../fixtures/catalogue-information-contract.ts';

export interface EntityPage {
  profile: string;
  target: { resource: string; revision: string; base: string; types: string[] };
  registry: { type: string; default: boolean; labels: { en: { one: string } } };
  summary: { reference: string; status: string; name?: { value: string } };
  sections: { id: typeof sectionIds[number]; href: string; actions: string[];
    count?: { value: number; precision: string; context: string; target: string } }[];
}
export interface FactItem {
  kind: string; statement?: string; revision: string; predicate: string; value: FactValue | SemanticValue;
  relationDefinition?: string;
  qualifiers: Qualifiers;
  sources: string[]; evidence?: (Support & Partial<Pick<ReadableEvidence, 'attribution' | 'language'>>)[];
  acceptance?: Acceptance | null;
}
export interface FactGroup {
  predicate: string; display: { label: { value: string; language: string }; order: number };
  coverage: { state: FieldState; sources: string[]; retry: { href: string; afterMs: number } | null };
  items: FactItem[];
}
interface StatementPage {
  profile: string; resource: string; groups: FactGroup[]; nextCursor: string | null;
  count: { value: number; kind: string; total: null };
}
export interface RelationEntry {
  relation: string; revision: string | null; kind: string;
  citations?: Support[];
  rendering: null | {
    meaning: { definition: string }; viewingRole: string;
    bindings: { role: string; participant: unknown }[];
    projections: { fromRole: string; toRole: string; labels: { heading: string | null } | null }[];
  };
  // Exact qualification survives both directions; no context is inferred from a name.
  applicability: string[];
  counterparts: { reference: string; status: string; base?: string }[];
  collectionPurpose?: CollectionFixture['purpose'];
}
export interface PartsPage {
  resource: string; structure: string; revision: string;
  parts: (Omit<PartExpectation, 'source' | 'labelSource'> & { segmentKey: string; orderKey: string })[];
  next: string | null;
}

function localFile(path: string): string {
  const file = realpathSync(resolve(path));
  const local = relative(realpathSync(process.cwd()), file);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Corpus file must stay in this worktree');
  return file;
}
function checkedBytes(path: string, digest: string): Buffer {
  const bytes = readFileSync(localFile(path));
  if (!/^[a-f0-9]{64}$/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error(`Frozen corpus digest mismatch: ${path}`);
  return bytes;
}
function sourceAtom(source: FrozenSupport): unknown {
  let value: unknown = JSON.parse(checkedBytes(source.file, source.representationSha256).toString());
  if (!source.locator.pointer.startsWith('/')) throw new Error('A field needs an exact non-root JSON pointer');
  for (const token of source.locator.pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error(`Frozen source pointer is absent: ${source.locator.pointer}`);
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function checkFieldPremise(field: FactExpectation): void {
  expect(fieldStates).toContain(field.state);
  for (const source of field.sources) sourceAtom(source);
  for (const { kind, value, source } of field.values) {
    expect(['statement', 'component-property']).toContain(kind);
    if (kind === 'statement') expect(['literal', 'resource', 'some-value', 'no-value']).toContain(value.kind);
    else expect(['integer', 'decimal', 'rational', 'boolean', 'string', 'language-string', 'temporal',
      'quantity', 'resource', 'external', 'unknown', 'no-value']).toContain(value.kind);
    const atom = sourceAtom(source);
    if ('lexical' in value) {
      expect(['string', 'number', 'boolean']).toContain(typeof atom);
      expect(value.lexical).toBe(String(atom).normalize('NFC'));
    }
    if (value.kind === 'resource') expect(typeof atom).toBe('string');
    if (value.kind === 'some-value' || value.kind === 'unknown') expect(atom).toBe('somevalue');
    if (value.kind === 'no-value') expect(atom).toBe('novalue');
    expect(field.sources.map(support => support.id)).toContain(source.id);
  }
  if (field.state !== 'adopted') expect(field.values).toEqual([]);
}

/** Read before starting a stack. Missing preparation is a setup blocker, never a
 * successful proof or an invented product failure. No network acquisition here. */
export function loadInformationCorpus(): InformationCorpus {
  const path = Bun.env.REZICS_INFORMATION_CORPUS ?? informationMatrix.sourceFixture.path;
  let corpus: InformationCorpus;
  try { corpus = JSON.parse(readFileSync(localFile(path), 'utf8')) as InformationCorpus; }
  catch (cause) {
    throw new Error(`Missing retained catalogue-information corpus: ${path}. ${informationMatrix.sourceFixture.requirement}`, { cause });
  }
  expect(corpus.profile).toBe('catalogue-information-corpus-v1');
  expect(corpus.productBaseline).toBe(informationMatrix.baselineProduct);
  expect(corpus.preparation.stopped).toBe(true);
  expect(corpus.preparation.elapsedMs).toBeGreaterThan(0);
  expect(corpus.preparation.elapsedMs).toBeLessThanOrEqual(informationMatrix.preparationLimitMs);
  expect(corpus.preparation.owners.toSorted()).toEqual(['access', 'account', 'content', 'graph', 'objects']);
  checkedBytes(corpus.preparation.backup, corpus.preparation.backupSha256);
  expect(corpus.preparation.receipts.length).toBeGreaterThan(0);
  for (const receipt of corpus.preparation.receipts) checkedBytes(receipt.file, receipt.sha256);
  for (const [key, specification] of Object.entries(supportingRecords)) {
    const record = corpus.records[key as SupportingKey];
    expect(record.source.provider, key).toBe(specification.provider);
    expect(record.registryType, key).toBe(specification.type);
    expect(Object.keys(record.sectionCounts).toSorted(), key).toEqual([...sectionIds].toSorted());
    for (const count of Object.values(record.sectionCounts)) {
      expect(Number.isInteger(count.value)).toBe(true);
      expect(count.value).toBeGreaterThanOrEqual(0);
      expect(count.context).toMatch(/^https:\/\/rezics\.com\/id\//);
      expect(count.target).toMatch(/^https:\/\/rezics\.com\/id\//);
    }
    expect(record.source.externalId.length, key).toBeGreaterThan(0);
    expect(record.source.key.length, key).toBeGreaterThan(0);
    expect(record.name.length, key).toBeGreaterThan(0);
    expect(String(sourceAtom({ ...record.source.snapshot, locator: { pointer: record.source.identityPointer } })))
      .toBe(record.source.externalId);
    expect(sourceAtom({ ...record.source.snapshot, locator: { pointer: record.source.namePointer } }))
      .toBe(record.name);
    expect(record.fields.map(field => field.key).toSorted(), key).toEqual([...specification.fields].toSorted());
    expect(record.fields.some(field => field.state === 'adopted' && field.values.length > 0), key).toBe(true);
    expect(record.fields.some(field => !['name', 'identifier'].includes(field.key)
      && field.state === 'adopted' && field.values.length > 0), `${key} must exceed an identity shell`).toBe(true);
    for (const field of record.fields) checkFieldPremise(field);
  }
  expect(corpus.records.nativeRelease.work).toMatch(/^https:\/\/rezics\.com\/id\//);
  expect(Object.values(corpus.records).some(record => record.fields.some(field =>
    field.values.some(value => value.qualifiers.applicability.length > 0)))).toBe(true);
  for (const key of ['character', 'person', 'organization', 'concept'] as const) {
    for (const field of ['aliases', 'description'])
      expect(corpus.records[key].fields.find(item => item.key === field)?.state).toBe('adopted');
  }
  for (const [key, edges] of Object.entries(corpus.inverse)) {
    expect(edges.length, `${key} needs real inverse paths and a continuation`).toBeGreaterThanOrEqual(2);
    for (const edge of edges) sourceAtom(edge.source);
  }
  expect(Object.keys(corpus.inverse).toSorted()).toEqual(
    ['character', 'person', 'organization', 'concept', 'artist', 'recording', 'composition', 'label'].toSorted());
  for (const state of fieldStates) {
    expect(corpus.controls.states[state].field.state).toBe(state);
    checkFieldPremise(corpus.controls.states[state].field);
  }
  for (const value of Object.values(corpus.controls.values)) checkFieldPremise(value.field);
  expect(Object.keys(corpus.controls.values).toSorted()).toEqual(
    ['zero', 'empty-literal', 'some-value', 'no-value', 'null-language', 'non-english'].toSorted());
  expect(corpus.controls.values.zero.field.values[0]?.value).toMatchObject({ kind: 'literal', lexical: '0' });
  expect(corpus.controls.values['empty-literal'].field.values[0]?.value).toMatchObject({ kind: 'literal', lexical: '' });
  expect(corpus.controls.values['some-value'].field.values[0]?.value).toEqual({ kind: 'some-value' });
  expect(corpus.controls.values['no-value'].field.values[0]?.value).toEqual({ kind: 'no-value' });
  expect(corpus.controls.values['null-language'].field.values[0]?.value).toMatchObject({ kind: 'literal', language: null });
  const nonEnglish = corpus.controls.values['non-english'].field.values[0]?.value;
  expect(nonEnglish?.kind).toBe('literal');
  if (nonEnglish?.kind === 'literal') {
    expect(nonEnglish.language).not.toBeNull();
    expect(nonEnglish.language).not.toBe('en');
  }
  for (const key of orderCases) {
    const order = corpus.orders[key];
    expect(order.items.length, key).toBeGreaterThanOrEqual(3);
    expect(new Set(order.items.map(item => item.occurrence)).size).toBe(order.items.length);
    for (const item of order.items) {
      expect(String(sourceAtom(item.source))).toBe(String(item.sourceOrder.position));
      expect(item.sourceOrder.source).toBe(item.source.id);
      if (item.sourceOrder.label !== null) {
        expect(item.labelSource).not.toBeNull();
        expect(String(sourceAtom(item.labelSource!))).toBe(item.sourceOrder.label);
      }
    }
  }
  // A real release has two distinct track placements of one recording, plus
  // another recording. This prevents substituting unique recordings for tracks.
  const tracks = corpus.orders.tracks.items.flatMap(item => item.target ? [item.target.resource] : []);
  expect(new Set(tracks).size).toBeLessThan(tracks.length);
  expect(new Set(tracks).size).toBeGreaterThanOrEqual(2);
  expect(corpus.orders.tracks.parent).toBeTruthy();
  expect(corpus.orders.tracks.items.every(track => track.parent === corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.tracks.items.every(track => track.target?.base === 'work'
    && track.target.resource !== corpus.records.composition.resource
    && track.target.types.includes('https://schema.org/MusicRecording'))).toBe(true);
  expect(corpus.orders.media.items.some(medium => medium.occurrence === corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.media.items.some(medium => medium.occurrence !== corpus.orders.tracks.parent)).toBe(true);
  expect(corpus.orders.episodes.items.every(episode => episode.target?.types.includes('https://schema.org/TVEpisode'))).toBe(true);
  for (const key of Object.keys(collectionCases) as CollectionKey[]) {
    const collection = corpus.collections[key];
    expect(collection.purpose?.kind ?? null, key).toBe(collectionCases[key].kind);
    expect(collection.occurrences.length, key).toBeGreaterThanOrEqual(3);
    expect(new Set(collection.occurrences.map(item => item.occurrence)).size).toBe(collection.occurrences.length);
  }
  expect(corpus.collections.bookList.member).toBe(corpus.records.book.resource);
  expect(corpus.collections.recipes.member).toBe(corpus.records.recipe.resource);
  expect(corpus.collections.ordinary.name).toContain('Series');
  for (const kind of ['recipe', 'chapter'] as const) {
    const section = corpus.controls.recovery[kind];
    expect(section.resource).toBe(corpus.records[kind === 'recipe' ? 'recipe' : 'book'].resource);
    expect(section.queryReference.length).toBeGreaterThan(0);
    expect(Object.keys(section.identity).length).toBeGreaterThan(0);
  }
  for (const values of Object.values(corpus.controls.hidden)) {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.length).toBeGreaterThan(0);
  }
  return corpus;
}

export async function openInformationCorpus(corpus: InformationCorpus, graphEndpoint?: string): Promise<PersonaSessions> {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test on an isolated restored QA stack');
  const previous = Bun.env.FUSEKI_URL;
  if (graphEndpoint) Bun.env.FUSEKI_URL = graphEndpoint;
  try {
    const [sessions] = await restorePersonaRealms([corpus.realm]);
    if (!sessions) throw new Error('Retained corpus Realm did not restore');
    expect(sessions.owner.actingSubject).toBe(corpus.realm.identities.owner.actingSubject);
    return sessions;
  } finally { Bun.env.FUSEKI_URL = previous; }
}

export const resourcePath = (resource: string, suffix: string) => `/v1/resources/${resource.slice(-36)}/${suffix}`;
export type Read = (path: string, status?: number) => Promise<Response>;
export function publicRead(session: PersonaSession): Read {
  // Deliberately omit actingSubject: even an owning/operator identity consumes
  // the pinned public view. Management reads have their own profile and route.
  return (path) => session.main('GET', path, undefined, undefined,
    { headers: { 'accept-language': 'en' } });
}
export async function body<T>(read: Read, path: string, status = 200): Promise<T> {
  const response = await read(path, status);
  const raw = await response.text();
  expect(response.status, `${path}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
export function noHidden(value: unknown, corpus: InformationCorpus): void {
  const text = JSON.stringify(value);
  for (const hidden of Object.values(corpus.controls.hidden).flat()) expect(text).not.toContain(hidden);
}
export function assertIdentity(page: EntityPage, key: SupportingKey, corpus: InformationCorpus): void {
  const expected = corpus.records[key], specification = supportingRecords[key];
  expect(page.profile).toBe('entity-page-v1');
  expect(page.target).toMatchObject({ resource: expected.resource, revision: expected.revision, base: specification.base });
  expect(page.target.types).toContain(specification.type);
  expect(page.registry.type).toBe(expected.registryType);
  expect(page.registry.default).toBe(false);
  expect(page.registry.labels.en.one).not.toBe('Resource');
  expect(page.summary.reference).toBe(expected.resource);
  expect(page.sections.find(section => section.id === 'statements')?.href)
    .toBe(resourcePath(expected.resource, 'statements'));
  expect(page.sections.find(section => section.id === 'relations')?.href)
    .toBe(resourcePath(expected.resource, 'relations'));
  for (const section of page.sections) {
    if (section.count) expect(section.count).toEqual({ ...expected.sectionCounts[section.id], precision: 'exact' });
  }
  noHidden(page, corpus);
}

export async function factGroups(read: Read, resource: string, corpus: InformationCorpus): Promise<FactGroup[]> {
  const groups: FactGroup[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '2', ...(after ? { after } : {}) });
    const page = await body<StatementPage>(read, `${resourcePath(resource, 'statements')}?${query}`);
    expect(page.profile).toBe('subject-statements-v1');
    expect(page.resource).toBe(resource);
    expect(page.count).toMatchObject({ kind: 'exact-page', total: null });
    expect(page.count.value).toBe(page.groups.reduce((count, group) => count + group.items.length, 0));
    noHidden(page, corpus);
    for (const group of page.groups) {
      const previous = groups.at(-1);
      if (previous?.predicate === group.predicate) {
        expect(group.display).toEqual(previous.display);
        expect(group.coverage).toEqual(previous.coverage);
        previous.items.push(...group.items);
      } else groups.push(group);
    }
    after = page.nextCursor;
    if (after) {
      expect(cursors.has(after), 'continuation must advance').toBe(false);
      cursors.add(after);
      expect(cursors.size, 'small corpus continuation must terminate').toBeLessThan(64);
    }
  } while (after);
  expect(new Set(groups.flatMap(group => group.items.map(item =>
    `${item.kind}:${item.statement ?? JSON.stringify([item.revision, item.predicate, item.value])}`))).size)
    .toBe(groups.reduce((count, group) => count + group.items.length, 0));
  return groups;
}

export function assertField(groups: FactGroup[], expected: FactExpectation): void {
  const group = groups.find(item => item.predicate === expected.predicate);
  expect(group, expected.key).toBeDefined();
  if (!group) throw new Error(`Missing ${expected.key}`);
  expect(group.display.label.language).toBe('en');
  expect(group.display.label.value.trim().length).toBeGreaterThan(0);
  expect(group.display.label.value).not.toMatch(/^(?:https?:|urn:)/);
  expect(group.display.order).toBe(expected.order);
  expect(group.coverage.state).toBe(expected.state);
  expect(group.coverage.sources.toSorted()).toEqual(expected.sources.map(source => source.id).toSorted());
  expect(group.items.map(item => item.value)).toEqual(expected.values.map(item => item.value));
  if (expected.state !== 'adopted') expect(group.items).toEqual([]);
  if (expected.state === 'acquisition-failed') {
    expect(group.coverage.retry?.href).toMatch(/^\/v1\/resources\//);
    expect(group.coverage.retry?.afterMs).toBeGreaterThanOrEqual(0);
    expect(group.coverage.retry?.afterMs).toBeLessThanOrEqual(30_000);
  } else expect(group.coverage.retry).toBeNull();
  for (const [index, item] of group.items.entries()) {
    const expectation = expected.values[index]!;
    const { kind, value, source, qualifiers } = expectation;
    expect(item.kind).toBe(kind);
    expect(item.value).toEqual(value);
    expect(item.qualifiers).toEqual(qualifiers);
    expect(item.sources).toContain(source.id);
    if (kind === 'statement') {
      expect(item.statement).toMatch(/^https:\/\/rezics\.com\/id\//);
      expect(item.acceptance).toEqual(expectation.acceptance);
    } else {
      expect(item).not.toHaveProperty('statement');
      expect(item).not.toHaveProperty('acceptance');
    }
    expect(item.evidence?.find(evidence => evidence.id === source.id)).toMatchObject({
      id: source.id, sourceWork: source.sourceWork, representationSha256: source.representationSha256,
      locator: source.locator, rightsBasis: source.rightsBasis, quoteWithheld: source.quoteWithheld,
    });
    if (source.quoteWithheld)
      expect(item.evidence?.find(evidence => evidence.id === source.id)).toHaveProperty('quote', null);
    expect(item.evidence).toBeDefined();
    expect(new Set(item.evidence?.map(evidence => evidence.id)).size).toBe(item.evidence!.length);
  }
}

function jsonPointer(root: unknown, pointer: string): { present: boolean; value?: unknown } {
  expect(pointer === '' || pointer.startsWith('/') && !/~(?![01])/.test(pointer)).toBe(true);
  let value = root;
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return { present: false };
    value = (value as Record<string, unknown>)[key];
  }
  return { present: true, value };
}
const valueDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Only called inside test bodies. Files/bytes are prerequisites; native admission,
 * conversion resolution and acknowledged support are actual public API assertions.
 */
function retainedNativeSource(input: NativeReadFixture): unknown {
  const { retained, frozen } = input;
  const recordFile = JSON.parse(checkedBytes(frozen.record.file, frozen.record.sha256).toString());
  const record = jsonPointer(recordFile, frozen.record.pointer);
  expect(record.present).toBe(true);
  expect(record.value).toMatchObject({ key: retained.sourceKey, provider: retained.record.provider,
    externalId: retained.record.externalId });
  expect(valueDigest(record.value)).toBe(retained.record.recordDigest);
  const field = jsonPointer(record.value, retained.record.pointer);
  expect(retained.sourceValueDigest).toBe(field.present ? valueDigest(field.value) : null);
  const presence = !field.present ? 'omitted' : field.value === null ? 'null'
    : field.value === '' ? 'empty-string' : Array.isArray(field.value) && !field.value.length ? 'empty-array'
      : field.value && typeof field.value === 'object' && !Object.keys(field.value).length ? 'empty-object' : 'value';
  expect(retained.presence).toBe(presence);
  expect(retained.parts.length).toBeGreaterThan(0);
  expect(new Set(retained.parts.map(part => part.observation)).size).toBe(retained.parts.length);
  expect(frozen.parts.map(part => ({ observation: part.observation, byteDigest: part.sha256 }))).toEqual(retained.parts);
  for (const part of frozen.parts) checkedBytes(part.file, part.sha256);
  const part = frozen.parts.find(item => item.observation === retained.observation.observation);
  expect(part).toBeDefined();
  if (!part) throw new Error('Missing actual retained observation part');
  expect(part.sha256).toBe(retained.observation.byteDigest);
  const observation = jsonPointer(JSON.parse(checkedBytes(part.file, part.sha256).toString()), retained.observation.pointer);
  expect(retained.observation.valueDigest).toBe(observation.present ? valueDigest(observation.value) : null);
  const evidence = jsonPointer(JSON.parse(checkedBytes(input.evidence.file,
    input.evidence.representationSha256).toString()), input.evidence.locator.pointer);
  expect(evidence).toEqual(observation);
  expect(input.evidence.language).toEqual(retained.language);
  // The Source owner verifies conversion transforms for typed domain values.
  // Synopsis text has no permissible trim/truncate/locale/normalization transform.
  if (typeof field.value === 'string') expect(observation.value).toBe(field.value);
  return field.value;
}

function nativeCases(corpus: InformationCorpus): NativeAdmissionFixture {
  expect(corpus.nativeAdmission, 'The corpus producer must supply genuine retained native-admission inputs; no invented receipt fallback')
    .toBeDefined();
  if (!corpus.nativeAdmission) throw new Error('Missing native-admission corpus inputs; no product assertion reached');
  return corpus.nativeAdmission;
}

function assertNativeItem(groups: FactGroup[], input: NativeReadFixture): void {
  const native = input.native;
  expect(native, 'A candidate/projection is not an acknowledged native value').toBeDefined();
  if (!native) throw new Error('No acknowledged native owner binding');
  expect(native.target).toBe(input.resource);
  expect(native.predicate).toBe(input.field.predicate);
  expect(native.receipt.length).toBeGreaterThan(0);
  const item = groups.find(group => group.predicate === native.predicate)?.items.find(entry =>
    canonicalJson(entry.value) === canonicalJson(native.value));
  expect(item).toBeDefined();
  expect(item?.revision).toBe(native.expectedHead);
  expect(item?.qualifiers).toEqual(native.qualifiers);
  if (native.owner === 'statement') {
    expect(item?.kind).toBe('statement');
    expect(item?.statement).toBe(native.component);
    expect(item?.relationDefinition).toBe(native.relationDefinition);
    expect(item?.acceptance).toEqual(native.acceptance);
  } else {
    expect(item?.kind).toBe('component-property');
    expect(item).not.toHaveProperty('statement');
    expect(item).not.toHaveProperty('acceptance');
  }
  const evidence = item?.evidence?.find(entry => entry.id === input.evidence.id);
  expect(evidence).toMatchObject({ id: input.evidence.id, sourceWork: input.evidence.sourceWork,
    representationSha256: input.evidence.representationSha256, locator: input.evidence.locator,
    rightsBasis: input.evidence.rightsBasis, quoteWithheld: input.evidence.quoteWithheld,
    attribution: input.evidence.attribution, language: input.evidence.language });
  expect(input.evidence.attribution.sourceName.trim().length).toBeGreaterThan(0);
  expect(input.evidence.attribution.sourceUrl).toMatch(/^https:\/\//);
  if (input.evidence.quoteWithheld) expect(evidence).toHaveProperty('quote', null);
}

/** Six independent ordinary public readers; no actingSubject or import authority. */
export async function assertReadableNativeFacts(read: Read, corpus: InformationCorpus): Promise<void> {
  const fixtures = nativeCases(corpus);
  expect(Object.keys(fixtures.cases).toSorted()).toEqual(Object.keys(nativeReadCases).toSorted());
  expect(Object.values(fixtures.cases).some(input => input.retained.parts.length > 1),
    'At least one exact field resolves through an ordered multipart intake').toBe(true);
  for (const key of Object.keys(nativeReadCases) as NativeReadKey[]) {
    const input = fixtures.cases[key], requirement = nativeReadCases[key];
    const raw = retainedNativeSource(input);
    expect(input.retained.presence, key).toBe(requirement.presence);
    const groups = await factGroups(read, input.resource, corpus);
    assertField(groups, input.field);
    if (requirement.disposition === 'admitted') expect(input.disposition.state, key).toBe('admitted');
    if (requirement.disposition === 'explicit') expect(input.disposition.state, key).not.toBe('admitted');
    if (key === 'synopsis-multiline') expect(String(raw)).toContain('\n');
    if (key === 'synopsis-oversized') expect(String(raw).length).toBeGreaterThan(8000);
    if (key === 'synopsis-tagged') {
      expect(input.retained.language.state).toBe('value');
      if (input.retained.language.state === 'value') expect(input.retained.language.value).not.toBe('en');
    }
    if (key === 'synopsis-untagged') expect(input.retained.language.state).toBe('omitted');
    if (input.disposition.state !== 'admitted') {
      expect(input.disposition.reason?.length, key).toBeGreaterThan(0);
      expect(input.field.state).not.toBe('adopted');
      expect(input.field.values).toEqual([]);
      expect(input.native).toBeUndefined();
      continue;
    }
    expect(input.field.state).toBe('adopted');
    expect(input.field.values.length).toBeGreaterThan(0);
    assertNativeItem(groups, input);
    const native = input.native!;
    if (native.owner === 'statement') {
      const owner = await body<{ profile: string; statement: string; subject: string; predicate: string;
        relationDefinition: string; revision: string; value: FactValue; state: string; applicability: string[];
        meaningBasis: { state: string; interpretationDefinitions?: string[] }; qualification?: Record<string, unknown> }>(
        read, `/v1/statements/${native.component.slice(-36)}`);
      noHidden(owner, corpus);
      expect(owner).toMatchObject({ profile: 'statement-v1', statement: native.component,
        subject: native.target, predicate: native.predicate, relationDefinition: native.relationDefinition,
        revision: native.expectedHead, value: native.value, state: 'active',
        applicability: native.qualifiers.applicability });
      expect(['none', 'defined', 'readable']).toContain(owner.meaningBasis.state);
      expect(owner.meaningBasis.state === 'none' ? [] : owner.meaningBasis.interpretationDefinitions)
        .toEqual(native.qualifiers.interpretationDefinitions);
      expect(owner.qualification).toEqual(native.qualifiers.qualification);
    } else if (native.owner === 'semantic') {
      const owner = await body<{ profile: string; component: string; revision: string;
        state: { component: string; properties: { predicate: string; value: SemanticValue }[] } }>(
        read, `/v1/semantic/resources/${native.component.slice(-36)}`);
      noHidden(owner, corpus);
      expect(owner).toMatchObject({ profile: 'semantic-change-v1', component: native.target,
        revision: native.expectedHead, state: { component: 'resource' } });
      expect(owner.state.properties).toContainEqual(expect.objectContaining({ predicate: native.predicate, value: native.value }));
    }
    if (requirement.kind === 'synopsis') {
      expect(native.owner).toBe('work-editorial');
      expect(typeof raw).toBe('string');
      expect(raw).toBe('lexical' in native.value && native.value.lexical);
      if (native.owner === 'work-editorial') expect(native.language).toEqual(input.retained.language);
      if (input.retained.language.state === 'value')
        expect(native.value).toMatchObject({ kind: 'language-string', language: input.retained.language.value });
      else {
        expect(native.value.kind).toBe('string');
        expect(native.value).not.toHaveProperty('language');
      }
    } else expect(['semantic', 'statement']).toContain(native.owner);
    if (key === 'exact-number') {
      expect(['integer', 'decimal', 'literal']).toContain(native.value.kind);
      if (native.value.kind === 'literal') expect([
        'http://www.w3.org/2001/XMLSchema#integer', 'http://www.w3.org/2001/XMLSchema#decimal',
      ]).toContain(native.value.datatype);
      expect('lexical' in native.value).toBe(true);
      if ('lexical' in native.value) expect(typeof native.value.lexical).toBe('string');
      expect(typeof raw, 'A retained exact decimal lexical cannot be reconstructed from a rounded JSON number').toBe('string');
      expect(raw).toBe('lexical' in native.value && native.value.lexical);
      expect(raw).toMatch(/^-?\d+(?:\.\d+)?$/);
    }
    if (key === 'date-precision') {
      const value = native.value;
      expect(value.kind === 'temporal' || value.kind === 'literal').toBe(true);
      // Independently check exact date precision, including retained YYYYMMDD
      // values whose 99 components mean unknown month/day, not invented dates.
      const source = String(raw);
      const date = /^\d{8}$/.test(source) ? source.slice(4) === '9999' ? source.slice(0, 4)
        : source.slice(6) === '99' ? `${source.slice(0, 4)}-${source.slice(4, 6)}`
          : `${source.slice(0, 4)}-${source.slice(4, 6)}-${source.slice(6)}` : source;
      expect(date).toMatch(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/);
      const precision = date.length === 4 ? 'year' : date.length === 7 ? 'month' : 'day';
      expect('lexical' in value && value.lexical).toBe(date);
      if (value.kind === 'temporal') {
        expect(value.precision).toBe(precision);
        expect(value.calendar).toBe('gregorian');
      } else if (value.kind === 'literal')
        expect(value.datatype).toBe(`http://www.w3.org/2001/XMLSchema#${precision === 'year' ? 'gYear' : precision === 'month' ? 'gYearMonth' : 'date'}`);
    }
  }
}

function assertSupportReceipt(actual: NativeSupportReceipt, request: NativeSupportAttachment): void {
  expect(actual).toMatchObject({ profile: 'source-field-support-v1', state: 'recorded',
    target: request.target, slot: request.slot, occurrence: request.occurrence, context: request.context,
    sourceRecord: request.sourceRecord, conversion: request.conversion,
    mappingRevision: request.retained.mappingRevision, grain: request.grain, sourceField: request.sourceField,
    sourceOccurrence: request.sourceOccurrence, nativeRevision: request.expectedHead,
    outcome: 'attached', withdrawal: null, native: request.native, retained: request.retained,
    attachment: { profile: 'source-field-attachment-certificate-v1', nativeReceipt: request.native.receipt } });
  expect(actual.support).toMatch(/^https:\/\/rezics\.com\/id\//);
  expect(actual.supportIdentity).toMatch(/^https:\/\/rezics\.com\/id\//);
  expect(actual.attachment.receipt.length).toBeGreaterThan(0);
  expect(actual.attachment.requestDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(actual.graphReceipt).toBe(request.native.receipt);
  expect(actual.publicEvidence.language).toEqual(request.retained.language);
  expect(actual.publicEvidence.attribution.sourceName.trim().length).toBeGreaterThan(0);
  expect(actual.publicEvidence.attribution.sourceUrl).toMatch(/^https:\/\//);
}

/** Real public commands on dedicated isolated subjects, never seed SQL/RDF or a
 * mapper pretending to be admission. All missing proposed behavior fails here.
 */
export async function assertNativeSupportCommands(sessions: PersonaSessions, corpus: InformationCorpus): Promise<void> {
  const { controls, cases } = nativeCases(corpus);
  const primary = controls.primary.request, secondary = controls.secondary.request;
  expect(Object.values(cases).map(input => input.resource)).not.toContain(primary.target);
  expect(primary.native).toEqual(secondary.native);
  expect(primary.sourceRecord).not.toBe(secondary.sourceRecord);
  expect(primary.retained.parts.length).toBeGreaterThanOrEqual(2);
  expect(controls.publicField.resource).toBe(primary.target);
  for (const request of [primary, secondary]) {
    expect(request.native.target).toBe(request.target);
    expect(request.native.expectedHead).toBe(request.expectedHead);
    expect(request.retained).toMatchObject({ sourceRecord: request.sourceRecord,
      conversion: request.conversion, grain: request.grain, sourceField: request.sourceField,
      observation: { pointer: request.sourcePointer } });
  }
  const path = '/v1/sources/field-supports';
  for (const persona of allPersonas.filter(name => name !== 'operator')) {
    const response = await sessions[persona].main('POST', path,
      { ...primary, actingSubject: sessions[persona].actingSubject }, `denied-${persona}-${controls.primary.key}`);
    expect(response.status).toBe(persona === 'visitor' ? 401 : 403);
    noHidden(await response.json(), corpus);
  }
  const read = publicRead(sessions.visitor);
  const before = await factGroups(read, primary.target, corpus);
  // Proposed Source-owned inventory extension. Its retained binding must be an
  // actual server-verified normalized-record -> observation resolution, including
  // the complete ordered part list, not a producer envelope or digest equality.
  for (const request of [primary, secondary]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let selected: { key: string; retained: NativeSupportAttachment['retained'] } | undefined;
    do {
      const query = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) });
      const response = await sessions.operator.main('GET',
        `/v1/sources/conversions/${request.conversion.slice(-36)}/inventory?${query}`);
      expect(response.status, await response.clone().text()).toBe(200);
      const page = await response.json() as { items: { key: string; retained: NativeSupportAttachment['retained'] }[];
        nextCursor: string | null };
      for (const item of page.items) {
        expect(seen.has(item.key)).toBe(false);
        seen.add(item.key);
        if (item.key === request.retained.inventoryKey) selected = item;
      }
      cursor = page.nextCursor;
      expect(seen.size).toBeLessThanOrEqual(1024);
      if (cursor) {
        expect(cursors.has(cursor), 'conversion inventory continuation must advance').toBe(false);
        cursors.add(cursor);
        expect(cursors.size).toBeLessThan(64);
      }
    } while (cursor);
    expect(selected?.retained).toEqual(request.retained);
  }
  expect(Object.keys(controls.refusals).toSorted()).toEqual(Object.keys(nativeAttachmentRefusals).toSorted());
  for (const key of Object.keys(nativeAttachmentRefusals) as NativeRefusalKey[]) {
    const input = controls.refusals[key], expected = nativeAttachmentRefusals[key];
    // Each control must change the named basis rather than accidentally exercise
    // the same generic invalid request for every named mismatch.
    const select = (request: NativeSupportAttachment): unknown => ({
      target: request.target, property: request.native.predicate, value: request.native.value,
      qualifiers: request.native.qualifiers, head: request.expectedHead, conversion: request.conversion,
      'native-receipt': request.native.receipt,
      'evidence-binding': request.retained.observation.pointer, 'parts-order': request.retained.parts,
      'unavailable-evidence': request.retained.observation.observation,
      'private-evidence': request.sourceRecord, rights: request.sourceRecord, 'unsupported-slot': request.slot,
    })[key];
    expect(select(input.request), key).not.toEqual(select(primary));
    if (key === 'parts-order') expect(input.request.retained.parts).toEqual([...primary.retained.parts].toReversed());
    const response = await sessions.operator.main('POST', path, input.request, input.key);
    expect(response.status, `${key}: ${await response.clone().text()}`).toBe(expected.status);
    const refused = await response.json();
    expect(refused).toMatchObject({ status: expected.status, code: expected.code });
    expect(refused).not.toHaveProperty('support');
    expect(refused).not.toHaveProperty('receipt');
    noHidden(refused, corpus);
    expect(await factGroups(read, primary.target, corpus), `${key} must not mutate native content`).toEqual(before);
  }
  const attach = async (input: typeof controls.primary, status: number) => {
    const response = await sessions.operator.main('POST', path, input.request, input.key);
    expect(response.status, await response.clone().text()).toBe(status);
    const answer = await response.json() as { support: NativeSupportReceipt; replayed: boolean };
    expect(answer.replayed).toBe(status === 200);
    assertSupportReceipt(answer.support, input.request);
    const saved = await sessions.operator.main('GET', `${path}/${answer.support.support.slice(-36)}`);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(answer.support);
    return answer.support;
  };
  const a = await attach(controls.primary, 201);
  expect(await attach(controls.primary, 200)).toEqual(a);
  const changed = await sessions.operator.main('POST', path,
    { ...primary, native: { ...primary.native, value: secondary.native.value,
      predicate: `${primary.native.predicate}-changed` } }, controls.primary.key);
  expect(changed.status).toBe(409);
  const b = await attach(controls.secondary, 201);
  expect(a.support).not.toBe(b.support);
  expect(a.supportIdentity).not.toBe(b.supportIdentity);
  expect(a.retained.sourceRecord).not.toBe(b.retained.sourceRecord);

  // Same-value human confirmation must remain a native editorial decision. Source
  // receipt/control ownership is never transferred by attachment or withdrawal.
  expect(primary.native.owner).toBe('work-editorial');
  expect(controls.human.path).toBe(`/v1/works/${primary.target.slice(-36)}/fields/synopsis/control`);
  expect(controls.human.body).toMatchObject({ origin: 'human', source: null });
  if (primary.native.owner === 'work-editorial') expect(controls.human.body.language).toEqual(primary.native.language);
  expect(controls.human.body.value).toBe('lexical' in primary.native.value && primary.native.value.lexical);
  const human = await command(sessions.owner, controls.human);
  expect(human).toMatchObject({ outcome: 'succeeded', receipt: expect.any(String), content: expect.any(String), control: expect.any(String) });
  const humanGroups = await factGroups(read, primary.target, corpus);
  assertField(humanGroups, controls.publicField.field);
  const signature = (groups: FactGroup[]) => groups.find(group => group.predicate === primary.native.predicate)?.items.map(item => ({
    kind: item.kind, statement: item.statement, revision: item.revision, value: item.value,
    qualifiers: item.qualifiers, acceptance: item.acceptance,
  }));
  const withdrawn = await sessions.operator.main('POST', '/v1/sources/withdrawals', {
    profile: 'source-field-withdrawal-v1', support: a.support, expectedSupport: a.supportIdentity,
    reason: 'Withdraw one retained record support while preserving the other and human content',
  }, `withdraw-${controls.primary.key}`);
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(201);
  expect(await withdrawn.json()).toMatchObject({ support: { state: 'withdrawn', support: a.support,
    withdrawal: { nativeEffect: 'none' } }, replayed: false });
  const remaining = await sessions.operator.main('GET', `${path}/${b.support.slice(-36)}`);
  expect(remaining.status).toBe(200);
  expect(await remaining.json()).toMatchObject({ state: 'recorded', support: b.support, withdrawal: null });
  const ownerSubject = sessions.owner.actingSubject;
  expect(ownerSubject).toMatch(/^https:\/\/rezics\.com\/id\//);
  if (!ownerSubject) throw new Error('The retained owner must have an acting subject');
  const control = await sessions.owner.main('GET', `${controls.human.path}?actingSubject=${encodeURIComponent(ownerSubject)}`);
  expect(control.status).toBe(200);
  expect(await control.json()).toMatchObject({ mode: 'human-controlled', value: controls.human.body.value,
    language: controls.human.body.language });
  for (const persona of allPersonas) {
    const groups = await factGroups(publicRead(sessions[persona]), primary.target, corpus);
    expect(signature(groups)).toEqual(signature(humanGroups));
    const item = groups.find(group => group.predicate === primary.native.predicate)?.items.find(entry =>
      canonicalJson(entry.value) === canonicalJson(primary.native.value));
    expect(item?.sources).toContain(b.publicEvidence.id);
    expect(item?.evidence?.find(entry => entry.id === b.publicEvidence.id)).toMatchObject(b.publicEvidence);
  }
}

export async function relations(read: Read, resource: string, corpus: InformationCorpus): Promise<RelationEntry[]> {
  const items: RelationEntry[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '1', ...(after ? { after } : {}) });
    const page = await body<{ profile: string; resource: string; items: RelationEntry[]; next: string | null }>(
      read, `${resourcePath(resource, 'relations')}?${query}`);
    expect(page.profile).toBe('resource-relations-v1');
    expect(page.resource).toBe(resource);
    expect(page.items.length).toBeLessThanOrEqual(1);
    noHidden(page, corpus);
    items.push(...page.items);
    after = page.next;
    if (after) {
      expect(cursors.has(after)).toBe(false);
      cursors.add(after);
      expect(cursors.size).toBeLessThan(64);
    }
  } while (after);
  expect(new Set(items.map(item => item.relation)).size).toBe(items.length);
  return items;
}

export function assertEdge(items: RelationEntry[], edge: EdgeExpectation): void {
  const actual = items.find(item => item.relation === edge.relation);
  expect(actual).toMatchObject({ relation: edge.relation, revision: edge.revision,
    applicability: edge.applicability,
    rendering: { meaning: { definition: edge.definition }, viewingRole: edge.viewingRole } });
  expect(actual?.rendering?.projections.some(projection =>
    projection.fromRole === edge.viewingRole && projection.toRole === edge.counterpartRole)).toBe(true);
  expect(actual?.counterparts).toContainEqual(expect.objectContaining({
    reference: edge.counterpart, status: 'available', base: edge.counterpartBase,
  }));
  expect(actual?.rendering?.bindings).toContainEqual(expect.objectContaining({ role: edge.counterpartRole,
    participant: { kind: 'resource', ref: edge.counterpart } }));
  expect(actual?.citations).toContainEqual(expect.objectContaining({ id: edge.source.id,
    representationSha256: edge.source.representationSha256, locator: edge.source.locator }));
}

export async function assertCollectionPurpose(read: Read, corpus: InformationCorpus, key: CollectionKey): Promise<void> {
  const expected = corpus.collections[key], specification = collectionCases[key];
  const memberRelations = await relations(read, expected.member, corpus);
  const membership = memberRelations.find(item => item.kind === 'collection' && item.relation === expected.resource);
  expect(membership, key).toBeDefined();
  expect(membership?.collectionPurpose).toEqual(expected.purpose);
  expect(membership?.collectionPurpose?.kind ?? null).toBe(specification.kind);
  expect(membership?.rendering?.projections.map(projection => projection.labels?.heading)).toContain(specification.heading);
  if (key !== 'franchise')
    expect(membership?.rendering?.projections.map(projection => projection.labels?.heading)).not.toContain('Franchises');
  if (expected.purpose) {
    const facts = await factGroups(read, expected.resource, corpus);
    const assertion = facts.flatMap(group => group.items).find(item => item.statement === expected.purpose?.statement);
    expect(assertion).toMatchObject({ revision: expected.purpose.revision, sources: expected.purpose.sources });
    expect(assertion?.acceptance).toEqual(expect.objectContaining({ context: expect.any(String), decision: expect.any(String) }));
  }
  const occurrences: { occurrence: string; target: string }[] = [], cursors = new Set<string>();
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '1', ...(after ? { after } : {}) });
    const page = await body<{ collection: string; revision: string;
      occurrences: { occurrence: string; target: string }[]; next: string | null }>(read,
    `/v1/collections/${expected.resource.slice(-36)}?${query}`);
    expect(page.revision).toBe(expected.revision);
    expect(page.occurrences.length).toBeLessThanOrEqual(1);
    noHidden(page, corpus);
    occurrences.push(...page.occurrences);
    after = page.next;
    if (after) {
      expect(cursors.has(after)).toBe(false);
      cursors.add(after);
      expect(cursors.size).toBeLessThan(32);
    }
  } while (after);
  expect(cursors.size).toBeGreaterThan(0);
  expect(occurrences.map(item => ({ occurrence: item.occurrence, target: item.target }))).toEqual(expected.occurrences);
}

export async function command(session: PersonaSession, input: FixtureCommand): Promise<unknown> {
  expect(input.path).toMatch(/^\/v1\//);
  const response = await session.main(input.method, input.path, input.body, input.key);
  const raw = await response.text();
  expect(response.status, raw).toBe(input.status);
  return JSON.parse(raw) as unknown;
}

export const allPersonas: readonly PersonaName[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
