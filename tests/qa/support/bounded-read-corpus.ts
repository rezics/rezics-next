import { afterAll, beforeAll } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { registerTelemetryPeers, shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { retainStoppedOwnerBackup, restoreCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { stopCorpusSourcePostgres } from '../../../scripts/load/corpus-backup-driver.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { startWorkProfileSink } from './work-profile.ts';
import { grantPersonaFixtureAuthority } from './persona-fixture-authority.ts';
import { personaAccount, personaNames, personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaSession, type PersonaSessions,
  type RetainedPersonaRealm } from './personas.ts';

// Account, Main composition/lifecycle, producers, disclosure, projections and
// all storage owners are real. The proxy only forwards and measures actual I/O.
// Its optional latency makes leaving an in-flight read deterministic.
type GraphCall = { trace: string; started: number; ended: number | null; query: string;
  sent: number; received: number; status: number | null };
export const calls: GraphCall[] = [];
export const delayed = new Set<string>();
let graph: ReturnType<typeof Bun.serve> | undefined;
export let sessions: PersonaSessions;
export let privateRealm: PersonaSessions;
export let reserve: PersonaSessions;
let restore: Awaited<ReturnType<typeof restoreCatalogueBackup>> | undefined;
export let corpus: Corpus;
let sink: ReturnType<typeof startWorkProfileSink> | undefined;
let unregister: (() => void) | undefined;
let directory: string;
const evidence: unknown[] = [];
export const short = (id: string) => id.slice(-36);
export const names = personaNames.filter(name => name !== 'visitor');
type Work = { work: string; mainVersion: string; workRevision: string;
  contribution: string; publicationDecision: string };
type Zone = { zone: string; realm: string; revision: string };
type Capability = 'queries' | 'notifications' | 'zones' | 'ratings';
type Corpus = { format: 'bounded-public-reads-v2'; capability: Capability; baseline: string; backup: string;
  records: RetainedPersonaRealm[]; book: Work; privateWork: string; chapter: string;
  phrase: string; privatePhrase: string; chapters: string[]; context: string; zones: Zone[];
  preparedMs: number; startupMs: number };
export type Page = { items: { id: string; kind: string }[]; nextCursor: string | null;
  complete: boolean; count: { value: number; kind: 'exact' | 'at-least' }; stale: boolean };
export const raw = { retry: false, settle: false } as const;

export function record(value: unknown) {
  evidence.push(value);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(directory, `${Bun.env.REZICS_QA_RUN_ID}-evidence.json`),
    JSON.stringify({ run: Bun.env.REZICS_QA_RUN_ID, baseline: corpus?.baseline,
      evidence }, null, 2), { mode: 0o600 });
  console.info('bounded-read-evidence', JSON.stringify(value));
}
export async function command<T>(person: PersonaSession, method: string, path: string, body?: unknown,
  statuses: number[] = [200, 201]): Promise<T> {
  const response = await person.main(method, path, body);
  const text = await response.text();
  if (!statuses.includes(response.status)) throw new Error(`SETUP ${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}
export async function until<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean, ms = 45_000) {
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
export function traceHeaders(trace = randomBytes(16).toString('hex')) {
  return { trace, headers: { traceparent: `00-${trace}-${randomBytes(8).toString('hex')}-01` } };
}
export async function measured(person: PersonaSession, method: string, path: string, body?: unknown) {
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

async function chapterContent(person: PersonaSession, resourceId: string, body: string) {
  await grantPersonaFixtureAuthority(person, [
    { scope: 'content:draft:' + resourceId, action: 'content.draft' },
    { scope: 'content:publish:' + resourceId, action: 'content.publish' },
    { scope: 'content:search-eligibility:' + resourceId, action: 'content.search-eligibility' },
  ]);
  const variantId = 'urn:rezics:variant:' + randomUUID();
  const content = await command<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    person, 'POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body, actingSubject: person.actingSubject });
  const published = await command<{ decision: string }>(person, 'POST', '/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: content.revisionId,
    expectedDigest: content.byteDigest, expectedContentEpoch: content.sourcePosition.dataEpoch,
    resourceId, variantId, expectedPublicationHead: null, actingSubject: person.actingSubject });
  await command(person, 'POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId, variantId,
    publicationDecision: published.decision, expectedEligibilityHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: person.actingSubject });
}
async function build(capability: Capability): Promise<Corpus> {
  const started = performance.now();
  const run = Bun.env.REZICS_QA_RUN_ID!;
  const preparationStarted = Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT);
  if (!Number.isFinite(preparationStarted)) throw new Error('SETUP runner preparation clock is missing');
  const startupMs = Math.max(0, Date.now() - preparationStarted);
  const preparationSignal = AbortSignal.timeout(Math.max(1, 600_000 - startupMs));
  const progress = (phase: string, completed?: number) => record({
    kind: 'preparation-progress', capability, phase, completed,
    elapsedMs: Math.round(performance.now() - started), startupMs, assertionReached: false });
  const source = await personaSessions('public');
  try {
    const hidden = await personaSessions('private');
    progress('six personas and private control');
    const publisher = capability === 'notifications' ? hidden.owner : source.owner;
    const book = await publicBook(publisher, 'Bounded reading catalogue');
    const privateWork = await command<{ work: string }>(source.owner, 'POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', title: 'Private bounded draft', language: 'en',
      actingSubject: source.owner.actingSubject });
    const phrase = 'chapterneedle' + randomUUID().replaceAll('-', '').slice(0, 12);
    const privatePhrase = 'privateneedle' + randomUUID().replaceAll('-', '').slice(0, 12);
    const chapters: string[] = [];
    const records = [retainPersonaRealm(source), retainPersonaRealm(hidden)];
    let ratingContext = '';
    const zones: Zone[] = [];

    if (capability === 'queries' || capability === 'notifications') {
      if (capability === 'notifications') for (const name of names) {
        const person = source[name];
        await command(person, 'POST', '/v1/follows', { profile: 'follow-command-v1', target: book.work,
          kind: 'work', actingSubject: person.actingSubject, following: true, level: 'all', expectedRevision: null });
      }
      const structure = await command<{ structure: string; revision: string }>(publisher, 'POST', '/v1/compositions', {
        profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: publisher.actingSubject });
      let head = structure.revision;
      // A separate author makes every signed-in reader a genuine recipient.
      // Twenty-four Feed subjects challenge the existing whole-request budget;
      // the public stream limit remains fifty.
      const population = capability === 'notifications' ? 24 : 1;
      for (let index = 0; index < population; index++) {
        const chapter = await command<{ post: string; compositionRevision: string }>(publisher, 'POST',
          '/v1/works/' + short(book.work) + '/chapters', {
            profile: 'book-chapter-create-v1', title: 'A bounded chapter ' + index,
            language: 'en', direction: 'ltr', parent: structure.structure, position: 'last',
            expectedCompositionHead: head, actingSubject: publisher.actingSubject });
        head = chapter.compositionRevision;
        chapters.push(chapter.post);
        await chapterContent(publisher, chapter.post, 'A chapter contains ' + phrase + ' ' + index + '.');
        progress('published chapters', index + 1);
      }
      if (capability === 'queries') {
        await grantPersonaFixtureAuthority(source.owner, [
          { scope: 'content:draft:' + privateWork.work, action: 'content.draft' },
        ]);
        await command(source.owner, 'POST', '/v1/content-drafts', {
          profile: 'content-text-v1', resourceId: privateWork.work,
          variantId: 'urn:rezics:variant:' + randomUUID(),
          language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
          expectedHead: null, body: privatePhrase, actingSubject: source.owner.actingSubject });
      } else {
        await until('followed chapter producer catches up', () => command<{ head: string }>(source.stranger,
          'GET', '/v1/me/notifications/hint'), value => BigInt(value.head) >= BigInt(population));
      }
    }
    if (capability === 'ratings') {
      await grantPersonaFixtureAuthority(source.operator, [{ scope: GLOBAL_CONTEXT_SCOPE, action: 'rating.context.create' }]);
      const context = await command<{ context: string }>(source.operator, 'POST', '/v1/global-rating-contexts', {
        profile: 'global-rating-standing-context-v1', question: 'Bounded global quality', actingSubject: source.operator.actingSubject });
      ratingContext = context.context;
      const people = names.map(name => source[name]);
      // Real independent Accounts, with two signups at a time and no extra Realms.
      for (let index = people.length; index < 100; index += 2) {
        const count = Math.min(2, 100 - index);
        people.push(...await Promise.all(Array.from({ length: count }, (_, offset) =>
          personaAccount('rating-' + (index + offset)))));
        progress('independent rating Accounts', people.length);
      }
      const reserved = await personaSessions('public');
      records.push(retainPersonaRealm(reserved));
      for (const [index, person] of people.entries()) {
        await grantPersonaFixtureAuthority(person, [
          { scope: 'rating:observe:' + ratingContext, action: 'rating.observation.set' },
        ]);
        await command(person, 'POST', '/v1/global-rating-observations', {
          profile: 'global-rating-standing-observation-v1', context: ratingContext,
          work: book.work, mainVersion: book.mainVersion, value: 5,
          expectedRevisionHead: null, actingSubject: person.actingSubject });
        if ((index + 1) % 10 === 0) progress('receipted ratings', index + 1);
      }
      for (const person of [reserved.owner, reserved.member]) await grantPersonaFixtureAuthority(person, [
        { scope: 'rating:observe:' + ratingContext, action: 'rating.observation.set' },
      ]);
    }
    if (capability === 'zones') {
      for (let index = 0; index < 10; index++) {
        const realm = await command<{ realm: string }>(source.owner, 'POST', '/v1/spaces', {
          profile: 'space-realm-v2', name: 'Bounded official Realm ' + index, language: 'en', capabilities: ['realm'],
          actingSubject: source.owner.actingSubject, initialSettings: { visibility: 'public', reviewRequired: false,
            reviewMode: 'open', whoMaySubmit: 'members', selfJoin: true, rules: [] } });
        const zone = await command<{ zone: string; zoneRevision: string }>(source.owner, 'POST', '/v1/spaces', {
          profile: 'space-zone-v1', name: 'Bounded official Zone ' + index, language: 'en', capabilities: ['zone'],
          actingSubject: source.owner.actingSubject });
        await grantPersonaFixtureAuthority(source.owner, [
          { scope: 'zone:official:' + zone.zone, action: 'zone.official' },
          { scope: 'publication:adopt:' + realm.realm, action: 'publication.adopt' },
        ]);
        const configured = await command<{ revision: string }>(source.owner, 'PUT',
          '/v1/zones/' + short(zone.zone) + '/configuration', {
            expectedHead: zone.zoneRevision, defaultRealm: realm.realm, ...(index < 8 ? { official: {} } : {}),
            actingSubject: source.owner.actingSubject });
        await command(source.owner, 'POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
          context: { kind: 'realm-local', id: realm.realm }, work: book.work, mainVersion: book.mainVersion,
          contribution: book.contribution, publicationDecision: book.publicationDecision, expectedSelectionHead: null,
          selectionBasis: 'realm-manager-review', actingSubject: source.owner.actingSubject });
        zones.push({ ...zone, realm: realm.realm, revision: configured.revision });
        progress('official Zone candidates', index + 1);
      }
    }
    await until('Content projection readiness', () => command<Record<string, unknown>>(source.visitor,
      'GET', '/health/ready', undefined, [200, 503]), value => value.status === 'ready');
    if (capability === 'queries') await until('search owner readiness before the retained cut',
      () => command<Record<string, unknown>>(source.visitor, 'GET', '/health/search-ready', undefined, [200, 503]),
      value => value.status === 'ready');
    const result: Corpus = { format: 'bounded-public-reads-v2', capability,
      baseline: '7df2e285d3199c32b4e61c08c33ba9c25afaaa21',
      backup: '', records, book, privateWork: privateWork.work, chapter: chapters[0] ?? '',
      phrase, privatePhrase, chapters, context: ratingContext, zones, preparedMs: 0, startupMs };
    progress('source ready for consistent stopped backup');
    await source.close();
    result.backup = await retainStoppedOwnerBackup(run, 'bounded-reads-' + capability, resolve(directory, 'owners'), Date.now(), {
      purpose: 'corpus', resumeSource: false, signal: preparationSignal,
      stopSourcePostgres: () => stopCorpusSourcePostgres(run, AbortSignal.timeout(120_000)) });
    result.preparedMs = performance.now() - started;
    if (result.preparedMs + startupMs > 600_000) throw new Error('SETUP build, startup and backup exceeded 600 seconds');
    writeFileSync(resolve(directory, 'corpus.json'), JSON.stringify(result), { mode: 0o600 });
    progress('retained corpus available');
    return result;
  } finally { await source.close(); }
}

export function useBoundedReadCorpus(capability: Capability) {
  directory = resolve('.temp/audit-bounded-reads', capability);
  beforeAll(async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with an isolated QA stack');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      corpus = existsSync(resolve(directory, 'corpus.json'))
        ? JSON.parse(readFileSync(resolve(directory, 'corpus.json'), 'utf8')) as Corpus : await build(capability);
      if (corpus.format !== 'bounded-public-reads-v2' || corpus.capability !== capability)
        throw new Error('SETUP incompatible retained corpus recipe');
      const started = performance.now();
      const run = 'bounded-' + randomUUID().replaceAll('-', '').slice(0, 16);
      restore = await restoreCatalogueBackup(corpus.backup, run, { signal: AbortSignal.timeout(600_000),
        resourceClass: 'catalogue-disk' });
      const apps = readEnv(resolve('.temp/stack', 'rezics-qa-' + run, 'apps.env'));
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
      record({ kind: 'preparation', capability, buildMs: corpus.preparedMs,
        restoreMs: performance.now() - started - restore.admissionWaitMs, admissionMs: restore.admissionWaitMs,
        backup: corpus.backup, isolatedRun: run, population: capability === 'ratings' ? 100 : null,
        officialZones: capability === 'zones' ? 8 : null, chapterNotices: capability === 'notifications' ? 24 : null });
    } catch (error) {
      record({ kind: 'setup-failure', capability, assertionReached: false, error: String(error) });
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
}
