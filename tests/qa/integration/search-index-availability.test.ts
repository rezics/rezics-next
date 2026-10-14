import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { assertWorkCostAtScales, profileRequest, startWorkProfileSink, type WorkProfile } from '../support/work-profile.ts';
import { queryProfileProcess } from '../../../services/main/tests/g-1053-profile-process.ts';
import { sourceIdentity } from '../../../scripts/qa/core.ts';

interface Identity { work: string; mainVersion: string; contribution: string; revision: string; selection: string }
interface Item { work?: string; id?: string; primaryCredits: { agent?: string }[] }
interface Page { results?: (Identity & Item)[]; items?: Item[]; next?: string | null; nextCursor?: string | null;
  window?: { complete: boolean }; count?: { value: number; precision: string }; matches?: { value: number; kind: string } }

/** Incremental seed prefixes change unrelated data only. All requests reach
 * composed Main over HTTP, without a qualification read before readiness. */
test('public search retains exact Realm membership and bounded work across three seeded corpus sizes', async () => {
  if (Bun.env.G1053_QUERY_CHILD !== 'search-index-availability.test.ts')
    return queryProfileProcess('search-index-availability.test.ts');
  const sink = startWorkProfileSink({ settleMs: 50 });
  startTelemetry('search-index-availability', { ...process.env, ...sink.env });
  const { startMediaStack } = await import('./media-support.ts');
  const { foregroundCounted } = await import('./support/operation-cost.ts');
  const { fusekiReadBudget } = await import('../../../services/main/src/infrastructure/fuseki.ts');
  const { searchOperationEvidence } = await import('../../../services/main/src/modules/search/operation-evidence.ts');
  const { MAX_SEARCH_REQUEST_MS } = await import('../../../services/main/src/modules/work/search-readiness.ts');
  const { createRealmSpace, spaceCreationDigest } = await import('../../../services/main/src/modules/space/create.ts');
  const { selectMainDefault, mainSelectionDigest } = await import('../../../services/main/src/modules/work/select-main.ts');
  const { selectRealmLocal, realmSelectionDigest } = await import('../../../services/main/src/modules/work/select-realm.ts');
  const { DATASET, GRAPHS, RV, iri, activateMetadataWork, metadataWorkRequestDigest }
    = await import('../../../services/main/src/modules/work/activate.ts');
  const directory = resolve('.temp', 'search-index-availability', `${Bun.env.REZICS_QA_RUN_ID}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const source = sourceIdentity(resolve('.')), startedPreparation = performance.now();
  const stack = await startMediaStack('search-index-availability', { profileCredits: true });
  const preparation: unknown[] = [], evidence: unknown[] = [], rawAnswers: unknown[] = [], refusals: unknown[] = [];
  const profiles: { caller: string; pageIndex: number; size: number; profile: WorkProfile }[] = [];
  const expected: Identity[] = [], unrelated: string[] = [];
  const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
  const query = stack.fuseki.query.bind(stack.fuseki), health = stack.fuseki.commandHealth.bind(stack.fuseki);
  const delta = stack.fuseki.searchDeltaSince.bind(stack.fuseki);
  type Call = { family: string; request?: string; startedMs: number; elapsedMs?: number;
    rows?: number; rankHits?: number; answer?: unknown; error?: string; budgetRemainingMs?: number };
  type Capture = { calls: Call[]; phases: Parameters<typeof searchOperationEvidence.run>[0]['phases'] };
  let active: Capture | undefined;
  async function observe<T>(family: string, request: string | undefined, read: () => Promise<T>): Promise<T> {
    if (!active || !foregroundCounted()) return read();
    const startedMs = performance.now(), budget = fusekiReadBudget.getStore();
    const call: Call = { family, request, startedMs,
      budgetRemainingMs: budget?.deadline === undefined ? undefined : budget.deadline - startedMs };
    active.calls.push(call);
    try {
      const result = await read();
      if (family === 'query') {
        const bindings = (result as { results?: { bindings: Array<Record<string, { value: string }>> } }).results?.bindings;
        call.rows = bindings?.length ?? 0;
        if (request?.includes('rv:rankedText')) call.rankHits = bindings?.reduce((sum, row) => sum
          + (JSON.parse(row.page?.value ?? '{"hits":[]}') as { hits: unknown[] }).hits.length, 0);
      } else call.answer = result;
      return result;
    } catch (error) { call.error = String(error); throw error; }
    finally { call.elapsedMs = performance.now() - startedMs; }
  }
  stack.fuseki.query = (sparql, bytes, nativePhase) => observe('query', sparql, () => query(sparql, bytes, nativePhase));
  stack.fuseki.commandHealth = () => observe('health', undefined, health);
  stack.fuseki.searchDeltaSince = ordinal => observe('delta-proof', ordinal, () => delta(ordinal));
  const server = Bun.serve({ port: 0, fetch: request => active
    ? searchOperationEvidence.run(active, () => stack.main.handle(request)) : stack.main.handle(request) });
  let publication: unknown, preparationMs = 0;
  function retain() {
    writeFileSync(resolve(directory, 'growth.json'), JSON.stringify({ source, servedSource: source,
      runId: Bun.env.REZICS_QA_RUN_ID, lineage: stack.env.lineage, boundMs: MAX_SEARCH_REQUEST_MS,
      matchingPopulation: expected.length, unrelated, expected, publication, preparationMs, preparation, evidence, rawAnswers, refusals,
      missingHistoricalWitnesses: 'Both retained sequence-25 503s lack index checkpoint and native phase witnesses.' }, null, 2));
  }
  try {
    const author = await stack.member('availability-author');
    const spaceInput = { name: 'Availability Realm', actingSubject: author.actor };
    const space = await createRealmSpace(stack.env, stack.admission(author.actor, 'space:create:root',
      'space.create', spaceCreationDigest(spaceInput)), spaceInput);
    if (!space.realm) throw new Error('Realm fixture creation failed');
    const realm = space.realm;
    const sequence = async () => (await query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } } LIMIT 1`)).results!.bindings[0]!.sequence!.value;
    for (let n = 0; n < 3; n++) {
      const title = `${phrase} story ${n}`, semanticTypes = ['https://schema.org/Book'];
      const work = await activateMetadataWork(stack.env, { title, language: 'en', semanticTypes, authorAgent: author.actor,
        admission: stack.admission(author.actor, 'work:create:root', 'work.create',
          metadataWorkRequestDigest(title, semanticTypes, 'en', { authorAgent: author.actor })) });
      const text = await stack.contribution(work.work, author.actor, 'en', `Original ${phrase} story ${n}: a gardener plants a seed.`);
      const selected = { context: { kind: 'main-version-default' as const, id: work.mainVersion }, work: work.work,
        contribution: text.contribution, publicationDecision: text.decision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: author.actor };
      await selectMainDefault(stack.env, stack.admission(author.actor, `publication:select:${work.mainVersion}`,
        'publication.select', mainSelectionDigest(selected)), selected);
      if (n === 2) {
        // Legitimate unrelated metadata fills the fresh fixture to the retained
        // publication sequence. It never matches or joins the Realm inventory.
        for (let padding = 0; padding < 25 && Number(await sequence()) < 24; padding++) {
          const other = await stack.catalogueWork(author.actor, `Unrelated seed ${padding}`);
          unrelated.push(other.work);
        }
        expect(await sequence()).toBe('24');
      }
      const adopted = { ...selected, context: { kind: 'realm-local' as const, id: realm },
        mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' as const };
      const receipt = await selectRealmLocal(stack.env, stack.admission(author.actor, `publication:adopt:${realm}`,
        'publication.adopt', realmSelectionDigest(adopted)), adopted);
      preparation.push({ operation: 'publication.select', receipt });
      if (!receipt.selection || !receipt.selectedDraft) throw new Error('Realm fixture publication failed');
      publication = receipt;
      expected.push({ work: work.work, mainVersion: work.mainVersion, contribution: text.contribution,
        revision: receipt.selectedDraft, selection: receipt.selection });
    }
    expect((publication as { sequence: string }).sequence).toBe('25');
    const base = unrelated.length;
    for (const target of [base, base + 16, base + 64]) {
      while (unrelated.length < target) {
        const other = await stack.publicWork(author.actor, ['en'], `Other catalogue seed ${unrelated.length}`);
        unrelated.push(other.work);
      }
      preparationMs = performance.now() - startedPreparation;
      expect(preparationMs).toBeLessThan(600_000);
      for (const caller of ['catalogue-word', 'catalogue-phrase', 'browse'] as const) {
        if (caller === 'browse') {
          if (!stack.composition.zoneBrowse) throw new Error('Composed Main has no browse projection');
          await stack.composition.zoneBrowse.backfill();
        }
        const q = caller === 'catalogue-word' ? phrase : `${phrase} story`;
        const delivered: string[] = [];
        let cursor: string | null = null;
        for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
          const path = caller === 'browse'
            ? `/v1/realms/${realm.slice(-36)}/modules/browse?${new URLSearchParams({ q, sort: 'relevance', limit: '1', ...(cursor ? { cursor } : {}) })}`
            : `/v1/search/catalogue?${new URLSearchParams({ q, realm, limit: '1', ...(cursor ? { cursor } : {}) })}`;
          const sample: Capture = { calls: [], phases: [] };
          active = sample;
          const requestedAt = new Date().toISOString();
          let answeredAt = '', httpMs = 0;
          const { result, profile } = await profileRequest(sink, async headers => {
            const started = performance.now();
            const response = await fetch(new URL(path, server.url), { headers });
            const body = await response.text();
            httpMs = performance.now() - started;
            answeredAt = new Date().toISOString();
            rawAnswers.push({ caller, pageIndex, size: expected.length + unrelated.length, requestedAt,
              answeredAt, httpMs, request: { method: 'GET', path }, answer: { status: response.status, body } });
            retain();
            return { status: response.status, body, headers: Object.fromEntries(response.headers) };
          }, { service: 'search-index-availability', flush: flushTelemetryTraces, peers: { fuseki: Bun.env.FUSEKI_URL } });
          active = undefined;
          const completion = caller === 'browse' ? null : { health: await health(), checkpoint: await delta('-1') };
          const now = performance.now();
          evidence.push({ size: expected.length + unrelated.length, unrelated: unrelated.length, caller,
            pageIndex, requestedAt, answeredAt, httpMs, request: { method: 'GET', path }, answer: result,
            arrival: sample.calls.find(call => call.family === 'delta-proof'), completion,
            phases: sample.phases.map(phase => ({ ...phase, elapsedMs: phase.elapsedMs ?? now - phase.startedMs })),
            calls: sample.calls, returnedRows: sample.calls.reduce((sum, call) => sum + (call.rows ?? 0), 0), profile });
          profiles.push({ caller, pageIndex, size: expected.length + unrelated.length, profile });
          retain();
          if (result.status !== 200) {
            refusals.push({ caller, pageIndex, size: expected.length + unrelated.length, path, answer: result });
            retain();
            // A refusal ends this traversal. Later samples have distinct inputs
            // or a newly seeded source cut; none retries this request.
            break;
          }
          const page = JSON.parse(result.body) as Page;
          for (const item of page.results ?? page.items ?? []) {
            const work = item.work ?? item.id!;
            expect(expected.map(row => row.work)).toContain(work);
            if (caller !== 'browse') expect(item).toMatchObject(expected.find(row => row.work === work)!);
            expect(item.primaryCredits).toContainEqual(expect.objectContaining({ agent: author.actor }));
            expect(delivered).not.toContain(work);
            delivered.push(work);
          }
          const count = caller === 'browse' ? page.matches! : page.count!;
          expect(count.value).toBe(delivered.length);
          const next = page.next ?? page.nextCursor;
          if (!next) {
            expect(caller === 'browse' ? page.matches!.kind : page.count!.precision).toBe('exact');
            if (caller === 'browse') expect(page.window?.complete).toBe(true);
            expect(delivered.toSorted()).toEqual(expected.map(row => row.work).toSorted());
            break;
          }
          expect(caller === 'browse' ? page.matches!.kind : page.count!.precision).toBe('lower-bound');
          expect(next).not.toBe(cursor);
          cursor = next;
          if (pageIndex === 3) throw new Error('Cursor failed to complete its independent inventory');
        }
      }
    }
    expect(refusals, JSON.stringify(refusals)).toHaveLength(0);
    for (const caller of ['catalogue-word', 'catalogue-phrase', 'browse']) {
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const measured = profiles.filter(row => row.caller === caller && row.pageIndex === pageIndex);
        expect(new Set(measured.map(row => row.size)).size).toBe(3);
        assertWorkCostAtScales(measured.map(row => row.profile), {
          fusekiRequests: 72, fusekiReceivedBytes: 8_388_608, postgresStatements: 160,
          minimumObserved: { fusekiRequests: 1, postgresStatements: 1 },
          growth: { fusekiRequests: { class: 'constant', dimension: 'profileIndex' },
            postgresStatements: { class: 'constant', dimension: 'profileIndex' } },
        }, `${caller}-page-${pageIndex}`);
      }
    }
  } finally {
    active = undefined;
    retain();
    console.log(`Search growth evidence: ${directory}/growth.json`);
    await server.stop(true);
    await stack.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 440_000);
