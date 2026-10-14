import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorCreditFixture } from '../fixtures/author-credit.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { MAX_SEARCH_REQUEST_MS } from '../../../services/main/src/modules/work/search-readiness.ts';
import { sourceIdentity } from '../../../scripts/qa/core.ts';

/** Keep the observation on this owning HTTP probe; all calls still reach native Jena. */
test('public Realm catalogue accounts for native readiness and query work inside its original bound', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through goalctl integration QA');
  const directory = resolve('.temp', 'search-index-availability', Bun.env.REZICS_QA_RUN_ID);
  mkdirSync(directory, { recursive: true });
  const fixture = await authorCreditFixture(Bun.env as Record<string, string>, directory,
    'openid work:create work:edit work:read space:create realm:adopt semantic:read');
  const calls: Array<{ family: string; request?: string; startedMs: number; elapsedMs?: number;
    answer?: unknown; error?: string; budgetRemainingMs?: number }> = [];
  let capture = false;
  const origin = performance.now();
  const source = sourceIdentity(resolve('.'));
  const preparation: unknown[] = [];
  const fixtureCall = fixture.call;
  fixture.call = async (...args) => {
    const started = performance.now(), requestedAt = new Date().toISOString();
    const response = await fixtureCall(...args);
    preparation.push({ method: args[0], path: args[1], body: args[2], requestedAt,
      elapsedMs: performance.now() - started, answer: { status: response.status, body: await response.clone().text() } });
    return response;
  };
  async function observe<T>(family: string, request: string | undefined, read: () => Promise<T>): Promise<T> {
    if (!capture) return read();
    const started = performance.now();
    const budget = fusekiReadBudget.getStore();
    const call: typeof calls[number] = { family, request, startedMs: started - origin,
      budgetRemainingMs: budget?.deadline === undefined ? undefined : budget.deadline - started };
    calls.push(call);
    try { const answer = await read(); call.answer = answer; return answer; }
    catch (error) { call.error = String(error); throw error; }
    finally { call.elapsedMs = performance.now() - started; }
  }
  const query = fixture.nativeFuseki.query.bind(fixture.nativeFuseki);
  const health = fixture.nativeFuseki.commandHealth.bind(fixture.nativeFuseki);
  const delta = fixture.nativeFuseki.searchDeltaSince.bind(fixture.nativeFuseki);
  fixture.nativeFuseki.query = (sparql, bytes) => observe('query', sparql, () => query(sparql, bytes));
  fixture.nativeFuseki.commandHealth = () => observe('health', undefined, health);
  fixture.nativeFuseki.searchDeltaSince = ordinal => observe('delta-proof', ordinal, () => delta(ordinal));
  const phrase = `Closuregarden${randomUUID().replaceAll('-', '')}`;
  const expected: Array<{ work: string; mainVersion: string; contribution: string;
    revision: string; selection: string }> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await fixture.grant('space:create:root', 'space.create');
    const space = await fixture.json<{ realm: string }>(await fixture.call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Search availability', capabilities: ['realm'], actingSubject: fixture.actor,
    }), 201);
    await fixture.grant(`publication:adopt:${space.realm}`, 'publication.adopt');
    let publication: unknown;
    for (let n = 0; n < 3; n++) {
      const work = await fixture.json<{ work: string; mainVersion: string }>(await fixture.call('POST', '/v1/works',
        await fixture.authoredBody({ profile: 'metadata-only-v1', title: `${phrase} ${n}`, language: 'en',
          semanticTypes: ['https://schema.org/Book'], actingSubject: fixture.actor })), 201);
      await fixture.grant(`contribution:create:${work.work}`, 'contribution.create');
      const draft = await fixture.json<{ contribution: string; draftRevision: string }>(
        await fixture.call('POST', '/v1/contributions', { profile: 'text-contribution-v1', work: work.work,
          language: 'en', body: `Original ${phrase} story ${n}: a gardener plants a seed.`, actingSubject: fixture.actor }), 201);
      await fixture.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      await fixture.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
      const decision = await fixture.json<{ publicationDecision: string }>(
        await fixture.call('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
          contribution: draft.contribution, expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
          rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: fixture.actor }), 201);
      const response = await fixture.call('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
        context: { kind: 'realm-local', id: space.realm }, work: work.work, mainVersion: work.mainVersion,
        contribution: draft.contribution, publicationDecision: decision.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review', actingSubject: fixture.actor });
      const raw = await response.text();
      expect(response.status, raw).toBe(201);
      const selected = JSON.parse(raw) as { selection: string };
      publication = { status: response.status, body: raw };
      expected.push({ work: work.work, mainVersion: work.mainVersion, contribution: draft.contribution,
        revision: draft.draftRevision, selection: selected.selection });
    }
    // Observe the operation's own proof. A pre-request proof can advance native
    // qualification and change the readiness cost we are trying to measure.
    server = Bun.serve({ port: 0, fetch: request => {
      const url = new URL(request.url);
      return fixture.call('GET', url.pathname + url.search, undefined, randomUUID(), null);
    } });
    const path = `/v1/search/catalogue?${new URLSearchParams({ q: phrase, realm: space.realm, limit: '1' })}`;
    const requestedAt = new Date().toISOString(), started = performance.now();
    capture = true;
    const response = await fetch(new URL(path, server.url));
    const raw = await response.text();
    const elapsedMs = performance.now() - started, answeredAt = new Date().toISOString();
    capture = false;
    const completion = { health: await health(), checkpoint: await delta('-1') };
    const arrival = { checkpointAtReadiness: calls.find(call => call.family === 'delta-proof') };
    const evidence = { qa: Bun.env.REZICS_QA_RUN_ID, source, servedSource: source,
      lineage: fixture.env.lineage, boundMs: MAX_SEARCH_REQUEST_MS, publication, expected, arrival, completion,
      request: { method: 'GET', path, requestedAt, answeredAt, elapsedMs },
      answer: { status: response.status, body: raw, headers: Object.fromEntries(response.headers) }, calls };
    writeFileSync(resolve(directory, 'capture.json'), JSON.stringify(evidence, null, 2));
    console.log(`Search availability evidence: ${directory}/capture.json`);
    expect(response.status, raw).toBe(200);
    const page = JSON.parse(raw) as { results: typeof expected; count: { value: number; precision: string }; next: string | null };
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject(expected.find(row => row.work === page.results[0]!.work)!);
    expect(page.count).toEqual({ value: 1, precision: 'lower-bound' });
    expect(page.next).not.toBeNull();
  } finally {
    capture = false;
    server?.stop(true);
    writeFileSync(resolve(directory, 'preparation.json'), JSON.stringify({ source, preparation }, null, 2));
    await fixture.close();
  }
}, 120_000);
