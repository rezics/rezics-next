import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { registerTelemetryPeers, shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { retainStoppedOwnerBackup, restoreCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { stopCorpusSourcePostgres } from '../../../scripts/load/corpus-backup-driver.ts';
import { REALM_DIRECTORY_COST } from '../../../services/main/src/modules/realm-directory/contract.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GLOBAL_AGGREGATE_BUDGET, GLOBAL_AGGREGATE_PROFILE } from '../../../services/main/src/modules/rating/global-aggregate.ts';
import { SUGGESTION_COST } from '../../../services/main/src/modules/onboarding/contract.ts';
import { RESOURCE_LIST_COST } from '../../../services/main/src/modules/query/resource-contract.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { MAX_SEARCH_REQUEST_MS } from '../../../services/main/src/modules/work/search-readiness.ts';
import { LIST_COST } from '../../../services/main/src/api-list.ts';
import { startWorkProfileSink } from '../support/work-profile.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { personaNames, personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaSession, type PersonaSessions,
  type RetainedPersonaRealm } from '../support/personas.ts';
import { closureOriginal, closureReply, closureRole } from './outcomes/realm/closure-fixture.ts';

// Account, Main composition/lifecycle, producers, disclosure, projections and
// all storage owners are real. The proxy only forwards and measures actual I/O.
// Its optional latency makes leaving an in-flight read deterministic.
type GraphCall = { trace: string; started: number; ended: number | null; query: string;
  sent: number; received: number; status: number | null };
const calls: GraphCall[] = [];
const delayed = new Set<string>();
let graph: ReturnType<typeof Bun.serve> | undefined;
let sessions: PersonaSessions;
let privateRealm: PersonaSessions;
let reserve: PersonaSessions;
let restore: Awaited<ReturnType<typeof restoreCatalogueBackup>> | undefined;
let corpus: Corpus;
let sink: ReturnType<typeof startWorkProfileSink> | undefined;
let unregister: (() => void) | undefined;
const directory = resolve('.temp/audit-bounded-reads');
const evidence: unknown[] = [];
const short = (id: string) => id.slice(-36);
const names = personaNames.filter(name => name !== 'visitor');
type Work = { work: string; mainVersion: string; workRevision: string;
  contribution: string; publicationDecision: string };
type Zone = { zone: string; realm: string; revision: string };
type Corpus = { format: 'bounded-public-reads-v1'; baseline: string; backup: string;
  records: RetainedPersonaRealm[]; book: Work; privateWork: string; chapter: string;
  phrase: string; privatePhrase: string; replies: string[]; context: string; zones: Zone[];
  preparedMs: number; startupMs: number };
type Page = { items: { id: string; kind: string }[]; nextCursor: string | null;
  complete: boolean; count: { value: number; kind: 'exact' | 'at-least' }; stale: boolean };
const raw = { retry: false, settle: false } as const;

function record(value: unknown) {
  evidence.push(value);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, `${Bun.env.REZICS_QA_RUN_ID}-evidence.json`),
    JSON.stringify({ run: Bun.env.REZICS_QA_RUN_ID, baseline: corpus?.baseline,
      evidence }, null, 2), { mode: 0o600 });
  console.info('bounded-read-evidence', JSON.stringify(value));
}
async function command<T>(person: PersonaSession, method: string, path: string, body?: unknown,
  statuses: number[] = [200, 201]): Promise<T> {
  const response = await person.main(method, path, body);
  const text = await response.text();
  if (!statuses.includes(response.status)) throw new Error(`SETUP ${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}
async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, ms = 45_000) {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (performance.now() >= deadline) throw new Error(`SETUP ${label}: ${JSON.stringify(value)}`);
    await Bun.sleep(200);
  }
}
function proxy(upstream: string) {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const trace = request.headers.get('traceparent')?.split('-')[1] ?? '';
    // This proxy is an observation point, never a substitute for an owner.
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    const entry: GraphCall = { trace, started: performance.now(), ended: null,
      query: body ? new TextDecoder().decode(body) : '', sent: body?.byteLength ?? 0,
      received: 0, status: null };
    calls.push(entry);
    if (delayed.has(trace)) await Bun.sleep(20);
    try {
      const target = new URL(new URL(request.url).pathname.replace(/^\/product\//, ''), upstream);
      target.search = new URL(request.url).search;
      const response = await fetch(target, { method: request.method, headers: request.headers, body,
        signal: request.signal });
      const bytes = await response.arrayBuffer();
      entry.received = bytes.byteLength;
      entry.status = response.status;
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally { entry.ended = performance.now(); }
  } });
}
function traceHeaders(trace = randomBytes(16).toString('hex')) {
  return { trace, headers: { traceparent: `00-${trace}-${randomBytes(8).toString('hex')}-01` } };
}
async function measured(person: PersonaSession, method: string, path: string, body?: unknown) {
  const { trace, headers } = traceHeaders();
  const started = performance.now();
  const response = await context.with(propagation.extract(ROOT_CONTEXT, headers),
    () => person.main(method, path, body, undefined, { ...raw, headers }));
  const text = await response.text();
  const graphCalls = calls.filter(call => call.trace === trace);
  const result = { status: response.status, body: JSON.parse(text) as Record<string, unknown>,
    elapsedMs: performance.now() - started, graphCalls: graphCalls.length,
    graphBytes: graphCalls.reduce((sum, call) => sum + call.received, 0),
    // An inventory audit cannot be charged to every reader or every new graph position.
    populationAudits: graphCalls.filter(call => call.query.includes('?declaredVariant')
      || call.query.includes('?missingVariant')).length,
    trace };
  record({ kind: 'answer', method, path, ...result });
  return result;
}
async function publicBook(person: PersonaSession, title: string): Promise<Work> {
  const work = await command<Work>(person, 'POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
    semanticTypes: ['https://schema.org/Book'], actingSubject: person.actingSubject });
  const draft = await command<{ contribution: string; draftRevision: string }>(person, 'POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en', body: `${title} original opening`,
    actingSubject: person.actingSubject });
  const publication = await command<{ publicationDecision: string }>(person, 'POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
    actingSubject: person.actingSubject });
  await command(person, 'POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: person.actingSubject });
  return { ...work, ...draft, ...publication };
}
async function build(): Promise<Corpus> {
  const started = performance.now();
  const run = Bun.env.REZICS_QA_RUN_ID!;
  const preparationStarted = Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT);
  if (!Number.isFinite(preparationStarted)) throw new Error('SETUP runner preparation clock is missing');
  const startupMs = Math.max(0, Date.now() - preparationStarted);
  const preparationSignal = AbortSignal.timeout(Math.max(1, 600_000 - startupMs));
  const source = await personaSessions('public');
  try {
    const hidden = await personaSessions('private');
    const people: PersonaSession[] = names.map(name => source[name]);
    const book = await publicBook(source.owner, 'Bounded reading catalogue');
    const privateWork = await command<{ work: string }>(source.owner, 'POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Private bounded draft', language: 'en',
      actingSubject: source.owner.actingSubject });
    const phrase = `chapterneedle${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const privatePhrase = `privateneedle${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const structure = await command<{ structure: string; revision: string }>(source.owner, 'POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: source.owner.actingSubject });
    const chapter = await command<{ post: string; compositionRevision: string }>(source.owner, 'POST',
      `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1', title: 'A bounded chapter',
        language: 'en', direction: 'ltr', parent: structure.structure, position: 'last',
        expectedCompositionHead: structure.revision, actingSubject: source.owner.actingSubject });
    await grantPersonaFixtureAuthority(source.owner, [
      { scope: `content:draft:${chapter.post}`, action: 'content.draft' },
      { scope: `content:publish:${chapter.post}`, action: 'content.publish' },
      { scope: `content:search-eligibility:${chapter.post}`, action: 'content.search-eligibility' },
      { scope: `content:draft:${privateWork.work}`, action: 'content.draft' },
    ]);
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const content = await command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
      source.owner, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: chapter.post, variantId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
        body: `A chapter contains ${phrase}.`, actingSubject: source.owner.actingSubject });
    const published = await command<{ decision: string }>(source.owner, 'POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: content.revisionId,
      expectedDigest: content.byteDigest, expectedContentEpoch: content.sourcePosition.dataEpoch,
      resourceId: chapter.post, variantId, expectedPublicationHead: null, actingSubject: source.owner.actingSubject });
    await command(source.owner, 'POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: chapter.post, variantId,
      publicationDecision: published.decision, expectedEligibilityHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: source.owner.actingSubject });
    await command(source.owner, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId: privateWork.work,
      variantId: `urn:rezics:variant:${randomUUID()}`, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
      direction: 'ltr', expectedHead: null, body: privatePhrase, actingSubject: source.owner.actingSubject });

    await closureRole(source, source.moderator, ['review.decide', 'publication.adopt']);
    const original = await closureOriginal(source.member, 'Bounded notification thread');
    await closureReply(source, original, 'Start the watched public thread');
    for (const name of names) {
      const person = source[name];
      const query = new URLSearchParams({ target: original.work, kind: 'thread', actingSubject: person.actingSubject! });
      const current = await until('automatic author watch',
        () => command<{ watch: { revision: string } | null }>(person, 'GET', `/v1/me/watches?${query}`),
        value => name !== 'member' || value.watch !== null);
      await command(person, 'POST', '/v1/me/watches', { target: original.work, kind: 'thread', level: 'all',
        actingSubject: person.actingSubject, expectedRevision: current.watch?.revision ?? null });
    }
    const replies: string[] = [];
    for (let index = 0; index < 50; index++) {
      replies.push((await closureReply(source, original, `Original bounded notification ${index}`)).reply);
      if (performance.now() - started > 550_000) throw new Error('SETUP corpus command preparation exceeded its budget');
    }
    // A source author is deliberately not their own recipient. The five signed-in
    // reader cells use a moderator-authored notice as a nonempty member control.
    replies.push((await closureReply(source, original, 'A different author supplies the member notice',
      source.moderator, source.moderator)).reply);
    await grantPersonaFixtureAuthority(source.operator, [{ scope: GLOBAL_CONTEXT_SCOPE, action: 'rating.context.create' }]);
    const context = await command<{ context: string }>(source.operator, 'POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Bounded global quality', actingSubject: source.operator.actingSubject });
    const records = [retainPersonaRealm(source), retainPersonaRealm(hidden)];
    let reserved: PersonaSessions | undefined;
    // Distinct Account principals, not synthetic rating rows or extra Agents on
    // one Account. All votes and receipts go through the public command owner.
    while (people.length < 105) {
      const more = await personaSessions('public');
      people.push(...names.filter(name => name !== 'operator').map(name => more[name]));
      reserved = more;
    }
    if (!reserved) throw new Error('SETUP missing independent population');
    records.push(retainPersonaRealm(reserved));
    for (const person of people.slice(0, 100)) {
      await grantPersonaFixtureAuthority(person, [{ scope: `rating:observe:${context.context}`, action: 'rating.observation.set' }]);
      await command(person, 'POST', '/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
        context: context.context, work: book.work, mainVersion: book.mainVersion, value: 5,
        expectedRevisionHead: null, actingSubject: person.actingSubject });
    }
    for (const name of names) {
      await grantPersonaFixtureAuthority(reserved[name], [{ scope: `rating:observe:${context.context}`, action: 'rating.observation.set' }]);
    }
    const zones: Zone[] = [];
    for (let index = 0; index < 10; index++) {
      const realm = await command<{ realm: string }>(source.owner, 'POST', '/v1/spaces', {
        profile: 'space-realm-v2', name: `Bounded official Realm ${index}`, language: 'en', capabilities: ['realm'],
        actingSubject: source.owner.actingSubject, initialSettings: { visibility: 'public', reviewRequired: false,
          reviewMode: 'open', whoMaySubmit: 'members', selfJoin: true, rules: [] } });
      const zone = await command<{ zone: string; zoneRevision: string }>(source.owner, 'POST', '/v1/spaces', {
        profile: 'space-zone-v1', name: `Bounded official Zone ${index}`, language: 'en', capabilities: ['zone'],
        actingSubject: source.owner.actingSubject });
      await grantPersonaFixtureAuthority(source.owner, [{ scope: `zone:official:${zone.zone}`, action: 'zone.official' },
        { scope: `publication:adopt:${realm.realm}`, action: 'publication.adopt' }]);
      const configured = await command<{ revision: string }>(source.owner, 'PUT', `/v1/zones/${short(zone.zone)}/configuration`, {
        expectedHead: zone.zoneRevision, defaultRealm: realm.realm, ...(index < 8 ? { official: {} } : {}),
        actingSubject: source.owner.actingSubject });
      await command(source.owner, 'POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: realm.realm }, work: book.work, mainVersion: book.mainVersion,
        contribution: book.contribution, publicationDecision: book.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: source.owner.actingSubject });
      zones.push({ ...zone, realm: realm.realm, revision: configured.revision });
    }
    await until('notification producer catches up', () => command<{ head: string }>(source.stranger,
      'GET', '/v1/me/notifications/hint'), value => BigInt(value.head) >= 50n);
    // Readiness is a prerequisite, not the chapter-search outcome under test.
    await until('Content projection readiness', () => command<Record<string, unknown>>(source.visitor,
      'GET', '/health/ready', undefined, [200, 503]), value => value.status === 'ready');
    await until('search owner readiness before the retained cut', () => command<Record<string, unknown>>(source.visitor,
      'GET', '/health/search-ready', undefined, [200, 503]), value => value.status === 'ready');
    const result: Corpus = { format: 'bounded-public-reads-v1', baseline: '50e53025617238f9d9d8127be78179c3fa3bc12c',
      backup: '', records, book, privateWork: privateWork.work, chapter: chapter.post, phrase, privatePhrase,
      replies, context: context.context, zones, preparedMs: 0, startupMs };
    await source.close();
    result.backup = await retainStoppedOwnerBackup(run, 'bounded-reads', resolve(directory, 'owners'), Date.now(), {
      purpose: 'corpus', resumeSource: false, signal: preparationSignal,
      stopSourcePostgres: () => stopCorpusSourcePostgres(run, AbortSignal.timeout(120_000)) });
    result.preparedMs = performance.now() - started;
    if (result.preparedMs + result.startupMs > 600_000) throw new Error('SETUP build, startup and backup exceeded 600 seconds');
    writeFileSync(resolve(directory, 'corpus.json'), JSON.stringify(result), { mode: 0o600 });
    return result;
  } finally { await source.close(); }
}

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with an isolated QA stack');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    corpus = existsSync(resolve(directory, 'corpus.json'))
      ? JSON.parse(readFileSync(resolve(directory, 'corpus.json'), 'utf8')) as Corpus : await build();
    if (corpus.format !== 'bounded-public-reads-v1') throw new Error('SETUP incompatible retained corpus recipe');
    const started = performance.now();
    const run = `bounded-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    restore = await restoreCatalogueBackup(corpus.backup, run, { signal: AbortSignal.timeout(600_000),
      resourceClass: 'catalogue-disk' });
    const apps = readEnv(resolve('.temp/stack', `rezics-qa-${run}`, 'apps.env'));
    Object.assign(Bun.env, apps, { REZICS_QA_RUN_ID: run, REZICS_QA_STACK_MODE: 'scale' });
    graph = proxy(apps.FUSEKI_URL!);
    sink = startWorkProfileSink();
    startTelemetry('main', { ...Bun.env, ...sink.env, FUSEKI_URL: new URL('product/', graph.url).href,
      OTEL_SERVICE_NAME: 'main' });
    unregister = registerTelemetryPeers({ FUSEKI_URL: new URL('product/', graph.url).href });
    [sessions, privateRealm, reserve] = await restorePersonaRealms(corpus.records,
      { graphEndpoint: new URL('product/', graph.url).href }) as [PersonaSessions, PersonaSessions, PersonaSessions];
    if (performance.now() - started - restore.admissionWaitMs > 600_000)
      throw new Error('SETUP restore and API readiness exceeded 600 seconds');
    record({ kind: 'preparation', buildMs: corpus.preparedMs, restoreMs: performance.now() - started - restore.admissionWaitMs,
      admissionMs: restore.admissionWaitMs,
      backup: corpus.backup, isolatedRun: run, population: 100, officialZones: 8 });
  } catch (error) {
    record({ kind: 'setup-failure', assertionReached: false, error: String(error) });
    throw error;
  }
}, 600_000);
afterAll(async () => {
  try { await sessions?.close(); } finally {
    try { await graph?.stop(true); } finally {
      try { await restore?.stop(); } finally {
        unregister?.();
        await shutdownTelemetry();
        await sink?.stop();
      }
    }
  }
}, 120_000);

for (const name of personaNames) {
  test(`D5-002 ${name}: legal default discovery returns a bounded page without private resources`, async () => {
    const person = sessions[name];
    const result = await measured(person, 'POST', '/v1/query', { profile: 'resource-list-v1',
      context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 20 });
    record({ case: 'D5-002', persona: name, assertionReached: true });
    expect(result.status, JSON.stringify(result)).toBe(200);
    const page = result.body as unknown as Page;
    expect(result.graphCalls).toBeGreaterThan(0);
    // All includes the Realm directory's own declared supplement.
    expect(result.graphCalls).toBeLessThanOrEqual(RESOURCE_LIST_COST.graphCalls + REALM_DIRECTORY_COST.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(RESOURCE_LIST_COST.graphBytes);
    expect(result.elapsedMs).toBeLessThan(RESOURCE_LIST_COST.deadlineMs);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map(item => item.id)).not.toContain(corpus.privateWork);
    expect(page.items.map(item => item.id)).not.toContain(privateRealm.realm);
    expect(page.complete).toBe(page.nextCursor === null);
    expect(page.count.kind).toBe(page.complete ? 'exact' : 'at-least');
  }, 30_000);

  test(`AUD-001 ${name}: server cursors round-trip through a complete mixed-resource traversal`, async () => {
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < 256; index++) {
      const result = await measured(sessions[name], 'POST', '/v1/query', { profile: 'resource-list-v1',
        context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 1, ...(cursor ? { cursor } : {}) });
      record({ case: 'AUD-001', persona: name, page: index, assertionReached: true, cursorLength: cursor?.length ?? 0 });
      expect(result.status, JSON.stringify(result)).toBe(200);
      const page = result.body as unknown as Page;
      for (const item of page.items) {
        expect(seen.has(item.id), 'A resource occurs once across the traversal').toBe(false);
        expect(item.id).not.toBe(corpus.privateWork);
        seen.add(item.id);
      }
      expect(page.complete).toBe(page.nextCursor === null);
      if (page.complete) {
        expect(page.count).toEqual({ kind: 'exact', value: seen.size });
        expect(seen.has(corpus.book.work)).toBe(true);
        expect(seen.has(sessions.realm)).toBe(true);
        return;
      }
      expect(page.count.kind).toBe('at-least');
      expect(cursors.has(page.nextCursor!), 'A partial/empty page must still advance').toBe(false);
      cursors.add(page.nextCursor!);
      // Acceptance by the next API request is authoritative, even if encoding changes.
      record({ case: 'AUD-001-issued', persona: name, length: page.nextCursor!.length,
        admittedCursorCharacters: LIST_COST.cursorCharacters });
      cursor = page.nextCursor!;
    }
    throw new Error('Traversal did not complete within the known command-created corpus');
  }, 120_000);

  test(`D5-003 ${name}: healthy chapter hits and exact no-match reads avoid foreground population qualification`, async () => {
    const queries = [corpus.phrase, `${corpus.phrase}absent`, corpus.privatePhrase, corpus.phrase];
    const answers = [];
    for (const [index, phrase] of queries.entries()) {
      if (index === 3) await command(sessions.owner, 'POST', '/v1/works', { profile: 'metadata-only-v1',
        authoring: 'own-work', title: `An unrelated graph advancement ${name}`, language: 'en',
        actingSubject: sessions.owner.actingSubject });
      answers.push(await measured(sessions[name], 'POST', '/v1/queries/page', {
        profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 }));
    }
    record({ case: 'D5-003', persona: name, assertionReached: true });
    for (const [index, result] of answers.entries()) {
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.elapsedMs).toBeLessThan(MAX_SEARCH_REQUEST_MS);
      expect(result.graphCalls).toBeGreaterThan(0);
      expect(result.populationAudits, 'A reader must not qualify the unrelated Content population').toBe(0);
      if (index === 1 || index === 2) expect(result.body).toMatchObject({ total: 0, relationComplete: true, results: [] });
      else expect(JSON.stringify(result.body)).toContain(corpus.book.work);
    }
  }, 30_000);

  test(`D5-001 ${name}: inbox and unread count share a complete request allocation`, async () => {
    const stream = await measured(sessions[name], 'GET', '/v1/me/notifications?before=latest&limit=50');
    const unread = await measured(sessions[name], 'GET', '/v1/me/notifications/unread-count');
    record({ case: 'D5-001', persona: name, assertionReached: true });
    if (name === 'visitor') {
      expect([stream.status, unread.status]).toEqual([401, 401]);
      expect(stream.body).not.toHaveProperty('items');
      return;
    }
    for (const result of [stream, unread]) {
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
      expect(result.graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
      expect(result.elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
    }
    const items = stream.body.items as { id: string; subject: { ref: string } | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some(item => item.subject && corpus.replies.includes(item.subject.ref))).toBe(true);
    const alien = await sessions[name === 'stranger' ? 'operator' : 'stranger'].main('PUT',
      `/v1/me/notifications/${items[0]!.id}/read`, undefined, undefined, raw);
    expect(alien.status).toBe(404);
  }, 30_000);
}


for (const name of personaNames) {
  test(`D5-001 ${name}: personal admission and missing notification controls preserve privacy`, async () => {
    const stream = await measured(sessions[name], 'GET', '/v1/me/notifications?limit=1');
    const missing = await sessions[name].main('PUT', `/v1/me/notifications/${randomUUID()}/read`,
      undefined, undefined, raw);
    if (name === 'visitor') {
      expect(stream.status).toBe(401);
      expect(missing.status).toBe(401);
      expect(stream.body).not.toHaveProperty('items');
      record({ case: 'D5-001-admission', persona: name, assertionReached: true, denied: true });
      return;
    }
    expect(stream.status, JSON.stringify(stream)).toBe(200);
    expect(missing.status).toBe(404);
    const item = (stream.body.items as { id: string }[])[0];
    expect(item, 'The public producer created a real personal inbox item').toBeDefined();
    const alien = await sessions[name === 'stranger' ? 'operator' : 'stranger'].main('PUT',
      `/v1/me/notifications/${item!.id}/read`, undefined, undefined, raw);
    expect(alien.status).toBe(404);
    record({ case: 'D5-001-admission', persona: name, assertionReached: true,
      missingStatus: missing.status, alienStatus: alien.status });
  }, 30_000);
}

for (const name of names) {
  test(`D5-001 ${name}: leaving an inbox stops later subject reads and permits a fresh retry`, async () => {
    const { trace, headers } = traceHeaders();
    const controller = new AbortController();
    delayed.add(trace);
    const pending = context.with(propagation.extract(ROOT_CONTEXT, headers),
      () => sessions[name].main('GET', '/v1/me/notifications?before=latest&limit=50', undefined,
        undefined, { ...raw, headers, signal: controller.signal }));
    const rejected = pending.then(response => ({ status: response.status }), error => ({ aborted: String(error) }));
    try {
      await until('in-flight notification storage work', async () => calls.filter(call => call.trace === trace).length,
        count => count >= 3, 5_000);
      controller.abort();
      await rejected;
      // One in-flight exchange may finish. No next subject may start after grace.
      await Bun.sleep(100);
      const boundary = performance.now();
      await Bun.sleep(300);
      const late = calls.filter(call => call.trace === trace && call.started > boundary);
      const active = calls.filter(call => call.trace === trace && call.ended === null);
      record({ case: 'D5-001-cancel', persona: name, assertionReached: true,
        graceMs: 100, observedMs: 300, lateCalls: late.length, activeCalls: active.length });
      delayed.delete(trace);
      const retry = await measured(sessions[name], 'GET', '/v1/me/notifications?limit=1');
      record({ case: 'D5-001-retry', persona: name, status: retry.status });
      expect(retry.status).toBe(200);
      expect((retry.body.items as unknown[]).length).toBe(1);
      expect(late).toHaveLength(0);
      expect(active).toHaveLength(0);
    } finally {
      controller.abort();
      delayed.delete(trace);
      await rejected;
    }
  }, 30_000);
}

test('D5-006: the ninth and tenth official Zones do not make six readers lose suggestions', async () => {
  const answers = [];
  for (const population of [8, 9, 10]) {
    if (population > 8) {
      const zone = corpus.zones[population - 1]!;
      await command(sessions.owner, 'PUT', `/v1/zones/${short(zone.zone)}/configuration`, {
        expectedHead: zone.revision, official: {}, actingSubject: sessions.owner.actingSubject });
    }
    for (const name of personaNames) {
      answers.push({ population, persona: name, result: await measured(sessions[name], 'GET',
        '/v1/onboarding/suggested-follows?languages=en') });
    }
  }
  record({ case: 'D5-006-zones', assertionReached: true,
    answers: answers.map(({ population, persona, result }) => ({ population, persona, status: result.status })) });
  for (const { result } of answers) {
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect((result.body.items as unknown[]).length).toBeGreaterThan(0);
    expect((result.body.items as unknown[]).length).toBeLessThanOrEqual(SUGGESTION_COST.suggestions * 2);
    expect(result.graphCalls).toBeGreaterThan(0);
    expect(result.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
    expect(result.elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
    expect(JSON.stringify(result.body)).not.toContain(privateRealm.realm);
  }
}, 120_000);

test('D5-006: 100, 101 and 102 independently receipted ratings remain readable without revealing voters', async () => {
  const answers = [];
  for (const population of [100, 101, 102]) {
    if (population > 100) {
      const person = population === 101 ? reserve.owner : reserve.member;
      await command(person, 'POST', '/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
        context: corpus.context, work: corpus.book.work, mainVersion: corpus.book.mainVersion, value: 5,
        expectedRevisionHead: null, actingSubject: person.actingSubject });
    }
    for (const name of personaNames) answers.push({ population, persona: name,
      result: await measured(sessions[name], 'POST', '/v1/global-rating-aggregates', {
        profile: GLOBAL_AGGREGATE_PROFILE, context: corpus.context,
        work: corpus.book.work, mainVersion: corpus.book.mainVersion }) });
  }
  record({ case: 'D5-006-ratings', assertionReached: true,
    answers: answers.map(({ population, persona, result }) => ({ population, persona, status: result.status })) });
  for (const { population, result } of answers) {
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ complete: true, count: population, withdrawnCount: 0, mean: 5,
      population: 'global-account-principal' });
    expect(result.graphCalls).toBe(GLOBAL_AGGREGATE_BUDGET.graphCalls);
    expect(result.graphBytes).toBeLessThanOrEqual(GLOBAL_AGGREGATE_BUDGET.graphBytes);
    expect(result.elapsedMs).toBeLessThan(GLOBAL_AGGREGATE_BUDGET.deadlineMs);
    expect(JSON.stringify(result.body)).not.toContain('principalId');
    expect(JSON.stringify(result.body)).not.toContain('rating-slot:');
  }
}, 120_000);

test('D5-004 operator: quiescent refresh exposes deferred reasons without disclosing private scope identities', async () => {
  const result = await measured(sessions.operator, 'GET', '/health/discovery-ready');
  record({ case: 'D5-004-diagnostic-control', persona: 'operator', assertionReached: true,
    persistentInvalidMediaAssertionReached: false,
    reason: 'This baseline projects identities/source evidence, not media; the old invalid-media producer is absent.' });
  expect([200, 503]).toContain(result.status);
  expect(result.body).toHaveProperty('refresh');
  const refresh = result.body.refresh as { items: { scopeKey: string; reason: string }[]; truncated: boolean } | null;
  if (refresh !== null) {
    expect(typeof refresh.truncated).toBe('boolean');
    for (const item of refresh.items) {
      expect(item.scopeKey).toMatch(/^[a-f0-9]{64}$/);
      expect(['basis-invalid', 'basis-unavailable', 'inactive', 'retry']).toContain(item.reason);
    }
    expect(JSON.stringify(refresh)).not.toContain(privateRealm.realm);
    expect(JSON.stringify(refresh)).not.toContain(privateRealm.owner.actingSubject!);
  }
}, 30_000);
