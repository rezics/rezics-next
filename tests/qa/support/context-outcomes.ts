import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Participant } from '../../../services/main/src/modules/relation/schema.ts';
import type { SemanticValue } from '../../../services/main/src/modules/semantic/value.ts';
import { assertAuditExecution } from './audit-execution.ts';
import { restorePersonaRealms, type PersonaName, type PersonaSession,
  type PersonaSessions, type RetainedPersonaRealm } from './personas.ts';

// Proposed public contract types, deliberately outside production admission.
// The owner document records which interface decisions still need approval.
export const associationQuery = 'https://rezics.com/query/subject-associations';
export const baselineProduct = '69eac3ceeaf885be70205a70248bc951e9d81cc9';
export type Context = 'global' | { realm: string };
export interface SourcePosition { datasetId: 'product'; dataEpoch: string; sequence: string }
export interface Snapshot { sourcePosition: SourcePosition; modelGeneration: string }
export interface Predicate { predicate: string; value: SemanticValue }
export interface Citation {
  id: string; sourceWork: string; representationSha256: string; locator: unknown;
  quote: string | null; quoteWithheld: boolean; method: unknown; modality: string;
  submitter: string; rightsBasis: string;
}
export interface Participation {
  id: string; role: string; participant: Participant; position?: number;
  creditedName?: { lexical: string; language: string };
  sourceIdentity?: { provider: string; namespace: string; key: string; alias: string | null;
    eid: string | null; note: string | null };
}
export interface StatementWitness {
  id: string; revision: string; subject: Participant; predicate: string; value: SemanticValue;
  /** Null denotes explicitly applicable global coverage, never a guessed join. */
  occurrence: string | null;
  context: Context; applicability: string[];
  qualification: 'asserted' | 'uncertain' | 'conflicting'; decisionRevision: string;
  citations: Citation[];
}
export interface Link { rel: string; method: 'GET' | 'POST'; href: string; body?: unknown }
export interface AssociationWitness {
  kind: 'appearance' | 'credit'; work: string; occurrence: string; revision: string; definition: string;
  workParticipation: string; subjectParticipation: string; subject: Participant; role: string;
  context: Context; applicability: string[]; qualification: 'asserted' | 'uncertain' | 'conflicting';
  participations: Participation[]; statements: StatementWitness[]; citations: Citation[];
  sourceVersionStatus: 'exact' | 'unresolved';
  labels: { subject: string | null; role: string | null; work: string | null };
  snippets: string[]; links: Link[];
}
export interface Selection {
  kind: 'appearance' | 'credit'; direction: 'work-to-subject' | 'subject-to-work';
  roots?: Participant[]; projection: 'work' | 'occurrence'; context: Context;
  frame: string[]; position: string;
  match: { role?: string; all: Predicate[]; any: Predicate[]; none: Predicate[] };
  snapshot?: Snapshot;
}
export interface AssociationRequest {
  profile: 'template-query-v1'; query: typeof associationQuery; revision: 1;
  parameters: Selection;
  presentation: { language: string; actingSubject?: string };
  limit: number; cursor?: string;
}
export interface Page<T> extends Snapshot {
  profile: 'template-result-v1'; query: typeof associationQuery; revision: 1;
  items: T[]; nextCursor: string | null; complete: boolean;
  count: { value: number; kind: 'exact-page'; total: null };
}
export interface WorkMatch {
  work: string;
  matches: { items: AssociationWitness[]; nextCursor: string | null; complete: boolean };
}
export interface QueryAnswer<T> {
  profile: 'query-v1'; template: typeof associationQuery;
  selection: Omit<AssociationRequest, 'cursor'>; result: Page<T>;
}

export const appearanceCases = ['redLead', 'mixedPeople', 'mixedOccurrences', 'otherRelease',
  'otherCanon', 'otherTime', 'uncertain', 'conflicting', 'sourceProtagonist', 'explicitMale',
  'realmOnly', 'privateCoParticipant', 'spoiler'] as const;
export type AppearanceCase = typeof appearanceCases[number];
export interface AppearanceFixture {
  work: string;
  /** Exact command-created witnesses, not outputs copied from the query under test. */
  witnesses: AssociationWitness[];
  selectedFrame: string[];
  evidenceFrame: string[];
}
export interface InverseFixture {
  root: Participant; kind: 'appearance' | 'credit'; publicWitnesses: AssociationWitness[];
}
export const creditRoles = ['author', 'translator', 'editor', 'director', 'artist',
  'animation-studio', 'transcriber'] as const;

/** Specification of the missing corpus producer's output, not a second fixture
 * lifecycle. Use the existing retained-source build/restore and authority helper. */
export interface ContextOutcomesFixture {
  format: 'context-outcomes-fixture-v1'; corpusId: string; productBaseline: typeof baselineProduct;
  personas: RetainedPersonaRealm;
  /** Complete finite catalogue in this isolated command-created corpus. */
  catalogueWorks: string[];
  cases: Record<AppearanceCase, AppearanceFixture>;
  protagonistRole: string; maleRole: string;
  predicates: { red: Predicate; black: Predicate; male: Predicate };
  /** Every other private Context is unavailable to all six ordinary readers. */
  privateRealm: string; unknownRealm: string; privateRoot: string; unknownRoot: string;
  overflow: AppearanceFixture;
  credits: {
    work: string; frameA: string[]; frameB: string[];
    releaseA: AssociationWitness[]; releaseB: AssociationWitness[];
    roles: Record<typeof creditRoles[number], AssociationWitness>;
    performerA: AssociationWitness; performerB: AssociationWitness;
    externalAlias: AssociationWitness; providerCollision: AssociationWitness;
    realmWitness: AssociationWitness;
  };
  inverse: { character: InverseFixture; person: InverseFixture; external: InverseFixture;
    organization: InverseFixture; term: InverseFixture; sparse: InverseFixture };
  sparse: { hiddenOccurrences: string[]; tailOccurrence: string; scanWindow: 800 };
  history: {
    current: AssociationWitness; priorExact: AssociationWitness;
    withdrawnEvidence: string; independentEvidence: string; humanDecisionRevision: string;
    obsoleteSource: Snapshot; obsoleteModel: Snapshot; obsoleteRestore: Snapshot;
  };
  forbidden: { private: string[]; realm: string[]; spoiler: string[]; drafts: string[] };
  /** Checksummed bytes from existing command receipts and frozen source imports.
   * This ledger must not contain answers from subject-associations. */
  receiptLedger: { path: string; sha256: string };
}
export interface RestoredContextOutcomes {
  format: 'restored-context-outcomes-v1'; runId: string;
  corpus: ContextOutcomesFixture;
  preparation: {
    sourceKey: string; backup: string; backupSha256: string; commandCreated: true;
    buildMs: number; restoreMs: number; smokePassed: true;
    pristineProduct: string; testOverlay: string[];
  };
}

function localFile(path: string): string {
  const temp = realpathSync(resolve('.temp'));
  const target = realpathSync(resolve(path));
  const name = relative(temp, target);
  if (!name || name.startsWith('..') || isAbsolute(name)) throw new Error('Context fixture must stay in this worktree .temp');
  return target;
}
export interface ContextHarness { fixture: ContextOutcomesFixture; sessions: PersonaSessions; close(): Promise<void> }
export async function contextHarness(): Promise<ContextHarness> {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Run through one named isolated goalctl test selection');
  const path = resolve('.temp/qa-context-outcomes', runId, 'restored.json');
  if (!existsSync(path)) throw new Error('Context outcome fixture prerequisite missing: '
    + '.temp/qa-context-outcomes/<run-id>/restored.json; prepare one command-created retained corpus, '
    + 'restore an isolated copy within 600 s, and pin the product and test revisions separately. No product assertion reached.');
  if ((statSync(localFile(path)).mode & 0o077) !== 0) throw new Error('Restored persona fixture must be mode 0600');
  const restored = JSON.parse(readFileSync(path, 'utf8')) as RestoredContextOutcomes;
  assertAuditExecution(restored, { productBaseline: restored.corpus.productBaseline,
    productRevision: restored.preparation.pristineProduct, fixtureGeneration: restored.preparation.sourceKey });
  expect(restored.format).toBe('restored-context-outcomes-v1');
  expect(restored.runId).toBe(runId);
  expect(restored.preparation.commandCreated).toBe(true);
  expect(restored.preparation.smokePassed).toBe(true);
  for (const ms of [restored.preparation.buildMs, restored.preparation.restoreMs]) {
    expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(600_000);
  }
  expect(restored.preparation.backupSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(restored.preparation.sourceKey).toMatch(/^rs-/);
  expect(restored.preparation.backup.length).toBeGreaterThan(0);
  expect(restored.preparation.pristineProduct).toMatch(/^[a-f0-9]{40}$/);
  expect(restored.preparation.testOverlay.every(file => file.startsWith('tests/qa/')
    || file.startsWith('scripts/qa/cases/outcomes/catalogue/'))).toBe(true);
  const fixture = restored.corpus;
  expect(fixture.format).toBe('context-outcomes-fixture-v1');
  expect(fixture.productBaseline).toBe(baselineProduct);
  expect(fixture.corpusId.length).toBeGreaterThan(0);
  expect(fixture.catalogueWorks.length).toBeGreaterThan(0);
  expect(fixture.catalogueWorks.length).toBeLessThanOrEqual(64);
  const ledger = readFileSync(localFile(fixture.receiptLedger.path));
  expect(createHash('sha256').update(ledger).digest('hex')).toBe(fixture.receiptLedger.sha256);
  // Fail the fixture premise in beforeAll. test.failing must only invert actual
  // product assertions, never a missing setup dependency or empty expected set.
  expect(new Set(appearanceCases.map(name => fixture.cases[name].work)).size).toBe(appearanceCases.length);
  for (const name of appearanceCases) expect(fixture.cases[name].witnesses.length).toBeGreaterThan(0);
  expect(fixture.cases.redLead.witnesses).toHaveLength(2);
  expect(new Set(fixture.cases.redLead.witnesses.map(item => item.subjectParticipation)).size).toBe(2);
  expect(fixture.cases.mixedPeople.witnesses).toHaveLength(2);
  expect(new Set(fixture.cases.mixedPeople.witnesses.map(item => JSON.stringify(item.subject))).size).toBe(2);
  expect(fixture.cases.mixedOccurrences.witnesses).toHaveLength(2);
  expect(new Set(fixture.cases.mixedOccurrences.witnesses.map(item => JSON.stringify(item.subject))).size).toBe(1);
  expect(new Set(fixture.cases.mixedOccurrences.witnesses.map(item => item.occurrence)).size).toBe(2);
  for (const name of ['otherRelease', 'otherCanon', 'otherTime'] as const) {
    expect(fixture.cases[name].selectedFrame.length).toBeGreaterThan(0);
    expect(fixture.cases[name].evidenceFrame.length).toBeGreaterThan(0);
    expect(fixture.cases[name].selectedFrame).not.toEqual(fixture.cases[name].evidenceFrame);
  }
  expect(fixture.overflow.witnesses).toHaveLength(65);
  expect(fixture.sparse.scanWindow).toBe(800);
  expect(fixture.sparse.hiddenOccurrences.length).toBeGreaterThan(800);
  expect(fixture.sparse.hiddenOccurrences.every(id => id < fixture.sparse.tailOccurrence)).toBe(true);
  expect(fixture.inverse.sparse.publicWitnesses).toHaveLength(65);
  expect(fixture.inverse.sparse.publicWitnesses.some(item => item.occurrence === fixture.sparse.tailOccurrence)).toBe(true);
  for (const group of Object.values(fixture.forbidden)) expect(group.length).toBeGreaterThan(0);
  for (const root of Object.values(fixture.inverse)) expect(root.publicWitnesses.length).toBeGreaterThan(0);
  for (const role of creditRoles) expect(fixture.credits.roles[role].kind).toBe('credit');
  expect(fixture.history.current.work).toBe(fixture.history.priorExact.work);
  expect(fixture.history.current.occurrence).not.toBe(fixture.history.priorExact.occurrence);
  const [sessions] = await restorePersonaRealms([fixture.personas]);
  if (!sessions) throw new Error('Six restored persona sessions are required');
  return { fixture, sessions, close: () => sessions.close() };
}

export const resource = (ref: string): Participant => ({ kind: 'resource', ref });
export function request(person: PersonaSession, parameters: Partial<Selection> = {}, limit = 2): AssociationRequest {
  return { profile: 'template-query-v1', query: associationQuery, revision: 1,
    parameters: { kind: 'appearance', direction: 'work-to-subject', projection: 'occurrence',
      context: 'global', frame: [], position: 'start', match: { all: [], any: [], none: [] }, ...parameters },
    presentation: { language: 'en', ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}) }, limit };
}
export async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  // This is the first product assertion for a pending persona. Setup failures
  // stay outside it. Baseline evidence must include this body and actual status.
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
export async function queryPage<T>(person: PersonaSession, body: AssociationRequest): Promise<Page<T>> {
  const answer = await json<QueryAnswer<T>>(person.main('POST', '/v1/query', body));
  expect(answer.profile).toBe('query-v1');
  expect(answer.template).toBe(associationQuery);
  const { cursor: _cursor, ...selection } = body;
  expect(answer.selection).toEqual(selection);
  assertPage(answer.result, body.limit);
  return answer.result;
}
export function assertPage<T>(page: Page<T>, limit: number): void {
  expect(page.profile).toBe('template-result-v1');
  expect(page.query).toBe(associationQuery); expect(page.revision).toBe(1);
  expect(page.items.length).toBeLessThanOrEqual(limit);
  expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
  expect(page.complete).toBe(page.nextCursor === null);
  expect(page.sourcePosition.datasetId).toBe('product');
  expect(page.sourcePosition.dataEpoch.length).toBeGreaterThan(0);
  expect(page.sourcePosition.sequence).toMatch(/^\d+$/);
  expect(page.modelGeneration.length).toBeGreaterThan(0);
  if (page.nextCursor !== null) {
    expect(page.nextCursor.length).toBeGreaterThan(0); expect(page.nextCursor.length).toBeLessThanOrEqual(2048);
  }
}
export function assertNoLeak(value: unknown, needles: readonly string[]): void {
  const body = JSON.stringify(value);
  for (const needle of needles) {
    expect(needle.length).toBeGreaterThan(0);
    expect(body).not.toContain(needle);
    expect(body).not.toContain(encodeURIComponent(needle));
  }
}
export function forbidden(f: ContextOutcomesFixture, allowRealm = false, allowSpoilers = false): string[] {
  return [...f.forbidden.private, ...f.forbidden.drafts, ...f.sparse.hiddenOccurrences,
    ...(allowRealm ? [] : f.forbidden.realm), ...(allowSpoilers ? [] : f.forbidden.spoiler)];
}
export function witnessKey(item: AssociationWitness): string {
  return [item.work, item.occurrence, item.subjectParticipation].join('\0');
}
export const ordered = (items: readonly AssociationWitness[]): AssociationWitness[] =>
  items.toSorted((a, b) => witnessKey(a) < witnessKey(b) ? -1 : witnessKey(a) > witnessKey(b) ? 1 : 0);
export function assertWitnesses(actual: AssociationWitness[], expected: readonly AssociationWitness[]): void {
  // Link bodies bind the current reader; compare the exact domain/evidence
  // payload independently and exercise executable links with that reader.
  const semantic = (witness: AssociationWitness) => {
    const { links: _links, ...meaning } = witness;
    return meaning;
  };
  expect(actual.map(semantic)).toEqual(ordered(expected).map(semantic));
  expect(new Set(actual.map(witnessKey)).size).toBe(actual.length);
  for (const witness of actual) {
    expect(witness.links.length).toBeGreaterThan(0);
    expect(witness.citations.length).toBeGreaterThan(0);
    expect(witness.citations.length).toBeLessThanOrEqual(16);
    expect(witness.participations.find(part => part.id === witness.subjectParticipation))
      .toMatchObject({ role: witness.role, participant: witness.subject });
    expect(witness.participations.find(part => part.id === witness.workParticipation))
      .toMatchObject({ participant: resource(witness.work) });
    for (const statement of witness.statements) {
      expect(statement.subject).toEqual(witness.subject);
      if (statement.occurrence !== null) expect(statement.occurrence).toBe(witness.occurrence);
      expect(statement.citations.length).toBeGreaterThan(0);
    }
    for (const citation of [...witness.citations, ...witness.statements.flatMap(item => item.citations)]) {
      expect(citation.representationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(citation.locator).not.toBeNull(); expect(citation.locator).not.toBeUndefined();
      if (citation.quoteWithheld) expect(citation.quote).toBeNull();
    }
  }
}
export async function allPages<T>(read: (cursor?: string) => Promise<Page<T>>,
  key: (item: T) => string, maximumPages: number, needles: readonly string[] = []): Promise<T[]> {
  const items: T[] = [], cursors = new Set<string>();
  let cursor: string | undefined, snapshot: Snapshot | undefined;
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber++) {
    const page = await read(cursor);
    assertNoLeak(page, needles);
    const current = { sourcePosition: page.sourcePosition, modelGeneration: page.modelGeneration };
    if (snapshot) expect(current).toEqual(snapshot); else snapshot = current;
    items.push(...page.items);
    if (page.nextCursor === null) {
      const keys = items.map(key);
      expect(keys).toEqual(keys.toSorted()); expect(new Set(keys).size).toBe(keys.length);
      return items;
    }
    // An empty page with a frontier continues. Neither result bound nor scan
    // window is evidence that the collection has ended.
    expect(cursors.has(page.nextCursor)).toBe(false);
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  throw new Error('Disclosed frontier did not finish within the fixture-derived page budget');
}
export function realmReader(persona: PersonaName): boolean { return persona === 'member' || persona === 'owner'; }
export async function queryWitnesses(person: PersonaSession, body: AssociationRequest,
  maximumPages = 32, needles: readonly string[] = []): Promise<AssociationWitness[]> {
  return allPages(cursor => queryPage<AssociationWitness>(person, { ...body, ...(cursor ? { cursor } : {}) }),
    witnessKey, maximumPages, needles);
}
export async function followLinks(person: PersonaSession, witnesses: readonly AssociationWitness[]): Promise<void> {
  for (const link of witnesses.flatMap(item => item.links)) {
    const url = new URL(link.href, 'https://main.invalid');
    expect(url.pathname.startsWith('/v1/')).toBe(true);
    expect(link.method === 'GET' || link.method === 'POST').toBe(true);
    if (link.method === 'POST') expect(link.body).toBeDefined();
    else expect(link.body).toBeUndefined();
    const response = await person.main(link.method, url.pathname + url.search, link.body);
    expect(response.status, await response.clone().text()).toBe(200);
  }
}
