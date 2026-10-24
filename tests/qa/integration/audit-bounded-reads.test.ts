import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { mainConfig } from '../../../services/main/src/config.ts';
import { composeMain } from '../../../services/main/src/composition.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DISCOVERY_REFRESH_COST, DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { requireQa } from './recommendation-support.ts';
import { personaNames } from '../support/personas.ts';
import { REALM_DIRECTORY_COST } from '../../../services/main/src/modules/realm-directory/contract.ts';
import { RESOURCE_LIST_COST } from '../../../services/main/src/modules/query/resource-contract.ts';
import { MAX_SEARCH_REQUEST_MS, MAX_SEARCH_FUSEKI_CALLS, MAX_SEARCH_FUSEKI_BYTES } from '../../../services/main/src/modules/work/search-readiness.ts';
import { LIST_COST } from '../../../services/main/src/api-list.ts';
import { useBoundedReadCorpus, sessions, privateRealm, corpus, measured, record, command, type Page } from '../support/bounded-read-corpus.ts';

// Keep the historical hooks out of the narrow current-product selector.
describe('retained bounded-read outcomes', () => {
useBoundedReadCorpus('queries');

for (const name of personaNames) {
  test(`D5-002 ${name}: legal default discovery returns a bounded page without private resources`, async () => {
    const person = sessions[name];
    const result = await measured(person, 'POST', '/v1/query', { profile: 'resource-list-v1',
      context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 20 });
    record({ case: 'D5-002', persona: name, assertionReached: true });
    expect(result.status, JSON.stringify(result)).toBe(200);
    const page = result.body.result as Page;
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
      const page = result.body.result as Page;
      for (const item of page.items) {
        expect(seen.has(item.id), 'A resource occurs once across the traversal').toBe(false);
        expect(item.id).not.toBe(corpus.privateWork);
        seen.add(item.id);
      }
      expect(page.complete).toBe(page.nextCursor === null);
      if (page.complete) {
        expect(page.count).toEqual({ kind: 'exact', value: seen.size });
        expect(seen.has(corpus.book!.work)).toBe(true);
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
      expect(result.graphCalls).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_CALLS);
      expect(result.graphBytes).toBeLessThanOrEqual(MAX_SEARCH_FUSEKI_BYTES);
      expect(result.populationAudits, 'A reader must not qualify the unrelated Content population').toBe(0);
      if (index === 1 || index === 2) expect(result.body).toMatchObject({ total: 0, relationComplete: true, results: [] });
      else expect(JSON.stringify(result.body)).toContain(corpus.book!.work);
    }
  }, 30_000);

}


for (const name of personaNames) {
  test('D5-003 ' + name + ': absent and unpublished chapter phrases remain exact private controls', async () => {
    for (const phrase of [corpus.phrase + 'absent', corpus.privatePhrase]) {
      const result = await measured(sessions[name], 'POST', '/v1/queries/page', {
        profile: 'public-main-phrase-page-v1', phrase, language: null, pageSize: 10 });
      record({ case: 'D5-003-disclosure', persona: name, assertionReached: true });
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.body).toMatchObject({ total: 0, relationComplete: true, results: [] });
      expect(JSON.stringify(result.body)).not.toContain(corpus.privateWork);
    }
  }, 30_000);
}

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

});

describe('current-product concurrent refresh', () => {
  beforeAll(() => {
    // This consumer never prepares a corpus or adopts the historical physical cut.
    // The shared preparation owner supplies this existing projection after a
    // compatible isolated round trip; the backup owner still verifies integrity.
    const path = '.temp/audit-bounded-reads/queries/corpus.json';
    if (!existsSync(path)) throw new Error('SETUP D5004C01: shared queries corpus is not ready');
    const retained = JSON.parse(readFileSync(path, 'utf8')) as {
      format?: string; capability?: string; baseline?: string; backup?: string;
    };
    if (retained.format !== 'bounded-public-reads-v2' || retained.capability !== 'queries'
      || !retained.backup || !/^[a-f0-9]{40}$/.test(retained.baseline ?? '')
      || ['69eac3ceeaf885be70205a70248bc951e9d81cc9',
        '7df2e285d3199c32b4e61c08c33ba9c25afaaa21'].includes(retained.baseline!)) {
      throw new Error('SETUP D5004C01: a genuine compatible fixed-product corpus is required; no historical restore');
    }
    if (!existsSync('services/main/migrations/access/2605_discovery_refresh_disposition.sql')) {
      throw new Error('SETUP D5004C01: reviewed refresh disposition source and migration are absent');
    }
  });
  useBoundedReadCorpus('queries');

  test('D5004C01 six personas: core Work reads finish during faulty refresh and its retained checkpoint repairs', async () => {
    const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
    const access = new Pool({ connectionString: owners.urls.access });
    const content = new Pool({ connectionString: owners.urls.content });
    const relay = new Pool({ connectionString: owners.urls.relay });
    const upstream = Bun.env.FUSEKI_URL!;
    const native = new FusekiClient(upstream);
    const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(basis);
    const conflictingSequence = '9223372036854775808';
    let head: string | undefined, populationReads = 0, graphCalls = 0, globalLeaseBeforeTick = '0';
    let armed = false, gateStarted = 0, gateEnded = 0;
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    let gateTimer: ReturnType<typeof setTimeout> | undefined;
    // Forward the actual native request and its unmodified response. Only its
    // delivery is held: the real refresh tick stays pending while HTTP readers
    // answer. No storage failure, owner result or public success is synthesized.
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
      const query = body ? new TextDecoder().decode(body) : '';
      // Catalog enrollment may also discover the retained Realms. Attribute
      // population I/O using the real queue lease, without replacing claim().
      const population = query.includes('SELECT DISTINCT ?work ?head')
        && (await access.query<{ lease_epoch: string }>(
          'SELECT lease_epoch::text FROM access.discovery_refresh WHERE scope_key=$1', [key]))
          .rows[0]?.lease_epoch !== globalLeaseBeforeTick;
      if (population) populationReads++;
      graphCalls++;
      const hold = armed && population;
      if (hold) armed = false;
      const target = new URL(new URL(request.url).pathname.replace(/^\/product\//, ''), upstream);
      target.search = new URL(request.url).search;
      const response = await fetch(target, { method: request.method, headers: request.headers,
        body, signal: request.signal });
      const bytes = await response.arrayBuffer();
      if (hold) {
        gateStarted = performance.now();
        gateTimer = setTimeout(release, WORK_READ_COST.deadlineMs);
        entered();
        await released;
        gateEnded = performance.now();
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    } });
    const repair = async () => {
      if (head) await native.update(`PREFIX rv: <https://rezics.com/vocab/>
        DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:sequence ${conflictingSequence} } }`);
    };
    let pending: Promise<unknown> | undefined;
    let assertionReached = false;
    try {
      if (!corpus.book) throw new Error('SETUP D5004C01: retained public Work binding is missing');
      const composition = await composeMain({
        config: mainConfig({ ...process.env, ACCESS_DATABASE_URL: owners.urls.access,
          CONTENT_DATABASE_URL: owners.urls.content, ACCOUNT_RELAY_DATABASE_URL: owners.urls.relay }),
        fuseki: new FusekiClient(new URL('product/', proxy.url).href), accessPool: access,
        contentPool: content, relayPool: relay, erasureRelayPool: relay,
        ownerRelayPool: relay, recommendationRelayPool: relay,
      });
      const heads = await native.query(`PREFIX rv: <https://rezics.com/vocab/>
        SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(corpus.book.work)} rv:head ?head } } LIMIT 2`);
      if (heads.results?.bindings.length !== 1 || !heads.results.bindings[0]!.head) {
        throw new Error('SETUP D5004C01: retained Work has no unique real source head');
      }
      head = heads.results.bindings[0]!.head!.value;
      const consumer = `concurrent-refresh-${randomUUID()}`;
      await initializeRelayCheckpoint(relay, consumer, composition.environment.lineage.dataEpoch);
      let drained = false;
      for (let pass = 0; pass < 1000; pass++) {
        if (!await relayMainOutboxOnce(native, relay, consumer)) { drained = true; break; }
      }
      if (!drained) throw new Error('SETUP D5004C01: native fixture relay exceeded 1000 batches');
      const projection = new DiscoveryProjection(access);
      let now = Date.now() + 60_000;
      // The reviewed real constructor accepts this optional queue clock. Keep
      // the fixture compiling on the historical author checkout; the preflight
      // rejects executing it without the reviewed disposition source/migration.
      const RefreshStore: new (pool: Pool, clock?: () => Date) => DiscoveryRefreshStore = DiscoveryRefreshStore;
      const store = new RefreshStore(access, () => new Date(now));
      const dependencies = { ...composition.dependencies,
        relayPosition: new RelayHandoffPositions(relay, consumer),
        discoveryRefreshInputs: new DiscoveryRefreshInputs(relay, consumer) };
      const worker = new DiscoveryRefreshWorker(dependencies, store, projection);
      await store.enroll([basis]);
      type State = { generation_id: string | null; checkpoint: string | null;
        quarantine_basis: { sequence: string; graphVersion: string | null } | null;
        quarantine_reason: string | null; last_error: string | null; last_outcome: string;
        attempts: string; lease_epoch: string };
      const state = async () => (await access.query<State>(`SELECT j.generation_id,d.checkpoint,
        j.quarantine_basis,j.quarantine_reason,j.last_error,j.last_outcome,j.attempts::text,j.lease_epoch::text
        FROM access.discovery_refresh j LEFT JOIN access.discovery_generation d ON d.generation_id=j.generation_id
        WHERE j.scope_key=$1`, [key])).rows[0]!;
      const tick = async (owner: DiscoveryRefreshWorker) => {
        globalLeaseBeforeTick = (await state()).lease_epoch;
        const before = graphCalls;
        const outcome = await owner.tick();
        expect(graphCalls - before).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.graphCalls);
        return outcome;
      };
      // Same genuine contradictory revision evidence as the retained native
      // owner case. It changes neither receipted sequence nor scheduler rows.
      await native.update(`PREFIX rv: <https://rezics.com/vocab/>
        INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:sequence ${conflictingSequence} } }`);
      armed = true;
      let tickSettled = false;
      const pumping = (async () => {
        for (let pass = 0; pass < 200; pass++) {
          now += DISCOVERY_REFRESH_COST.maximumRetryMs;
          await tick(worker);
          if (gateStarted) return;
        }
        throw new Error('SETUP D5004C01: real faulty population request was not reached in 200 ticks');
      })().finally(() => { tickSettled = true; });
      pending = pumping;
      // A worker rejection must fail setup instead of hanging on an unentered gate.
      await Promise.race([entering, pumping.then(() => {
        throw new Error('SETUP D5004C01: refresh finished before overlap');
      })]);
      const coreStarted = performance.now();
      try {
        const answers = await Promise.all(personaNames.map(async name => ({ name,
          answer: await measured(sessions[name], 'GET', '/v1/works/' + corpus.book!.work.slice(-36)
            + (name === 'visitor' ? '' : '?actingSubject=' + encodeURIComponent(sessions[name].actingSubject!))) })));
        const coreAnswered = performance.now();
        assertionReached = true;
        record({ case: 'D5004C01', phase: 'concurrent-core-read', assertionReached,
          gateStarted, coreStarted, coreAnswered, gateEnded, tickSettled,
          responseDeliveryHeld: true, nativeEngineCpuOverlapClaimed: false,
          answers: answers.map(({ name, answer }) => ({ persona: name, ...answer })) });
        expect(gateStarted).toBeLessThanOrEqual(coreStarted);
        expect(gateEnded, 'The real refresh response must still be pending at the public answers').toBe(0);
        expect(tickSettled).toBe(false);
        expect(coreAnswered - gateStarted).toBeLessThan(WORK_READ_COST.deadlineMs);
        for (const { answer } of answers) {
          expect(answer.status, JSON.stringify(answer)).toBe(200);
          expect(answer.body).toMatchObject({ id: corpus.book.work });
          expect(answer.elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
          expect(answer.graphCalls).toBeGreaterThan(0);
          expect(answer.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
          expect(answer.graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
          expect(JSON.stringify(answer.body)).not.toContain(corpus.privateWork);
        }
      } finally { release(); }
      await pumping;
      clearTimeout(gateTimer);
      const failed = await state();
      expect(failed).toMatchObject({ quarantine_reason: 'basis-invalid',
        last_error: 'Discovery source is ambiguous', attempts: '0' });
      expect(failed.generation_id).not.toBeNull();
      expect(failed.quarantine_basis?.graphVersion).toBeString();
      for (const name of ['visitor', 'stranger'] as const) {
        const hidden = await sessions[name].main('GET', '/v1/works/' + corpus.privateWork.slice(-36)
          + (name === 'visitor' ? '' : '?actingSubject=' + encodeURIComponent(sessions[name].actingSubject!)),
        undefined, undefined, { retry: false, settle: false });
        const body = await hidden.text();
        record({ case: 'D5004C01', phase: 'private-refusal', persona: name,
          assertionReached, status: hidden.status, body });
        expect(hidden.status).toBe(404);
        expect(body).not.toContain(corpus.privateWork);
      }
      const failedReads = populationReads;
      expect(failedReads).toBe(1);
      // One unchanged probe links the concurrent outcome to retained quarantine;
      // the existing 32-assert owner case retains fleet and transient coverage.
      now += DISCOVERY_REFRESH_COST.maximumRetryMs;
      for (let pass = 0; pass < 200; pass++) {
        await tick(worker);
        if ((await state()).lease_epoch !== failed.lease_epoch) break;
        if (pass === 199) throw new Error('No bounded unchanged-source probe was observed');
      }
      expect(await state()).toMatchObject({ generation_id: failed.generation_id,
        checkpoint: failed.checkpoint, quarantine_basis: failed.quarantine_basis, attempts: '0' });
      expect(populationReads).toBe(failedReads);
      await repair();
      const restored = new DiscoveryRefreshWorker(dependencies,
        new RefreshStore(access, () => new Date(now)), projection);
      for (let pass = 0; pass < 200; pass++) {
        now += DISCOVERY_REFRESH_COST.maximumRetryMs;
        await tick(restored);
        if ((await state()).last_outcome === 'activated') break;
        if (pass === 199) throw new Error('Repaired source did not activate within the native fixture bound');
      }
      expect(await state()).toMatchObject({ quarantine_basis: null, last_error: null, attempts: '0' });
      const active = (await access.query<{ active_generation: string }>(`SELECT active_generation
        FROM access.derived_generation_head WHERE family='discovery' AND scope_key=$1`, [key])).rows[0]!;
      expect(active.active_generation).toBe(failed.generation_id!);
      const generation = (await access.query<{ source_sequence: string; complete: boolean }>(
        'SELECT source_sequence::text,complete FROM access.discovery_generation WHERE generation_id=$1',
        [active.active_generation])).rows[0]!;
      expect(generation).toEqual({ source_sequence: failed.quarantine_basis!.sequence, complete: true });
      const repairedRead = await measured(sessions.visitor, 'GET', '/v1/works/' + corpus.book.work.slice(-36));
      expect(repairedRead.status).toBe(200);
      expect(repairedRead.body).toMatchObject({ id: corpus.book.work });
      record({ case: 'D5004C01', phase: 'repaired', assertionReached, gateStarted, gateEnded,
        failed, repaired: await state(), generation, populationReads, historicalOwnerAssertionsReused: 32 });
    } catch (error) {
      record({ case: 'D5004C01', phase: assertionReached ? 'assertion-failure' : 'setup-failure',
        assertionReached, error: String(error), gateStarted, gateEnded });
      throw error;
    } finally {
      release();
      clearTimeout(gateTimer);
      try { await pending?.catch(() => {}); } finally {
        try { await repair(); } finally {
          try { await proxy.stop(true); } finally {
            try { await Promise.all([access.end(), content.end(), relay.end()]); }
            finally { await owners.close(); }
          }
        }
      }
    }
  }, 120_000);
});
