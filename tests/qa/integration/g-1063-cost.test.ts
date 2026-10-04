import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  startTelemetry,
  flushTelemetryTraces,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import {
  profileRequest,
  startWorkProfileSink,
  assertWorkCost,
  assertWorkCostAtScales,
  type WorkProfile,
} from '../support/work-profile.ts';

/** Background triples isolate refresh cost, as in discovery-build.test.ts.
 * Targets/Context/ratings use real commands. This does not qualify bulk writes. */
test('G1063: 100/1k/10k projections use constant irrelevant/local work with 0/1000 idle scopes, and rebuild within five minutes', async () => {
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('g-1063-cost', { ...process.env, ...sink.env, OTEL_TRACES_SAMPLER_ARG: '0' });
  const { startMediaStack } = await import('./media-support.ts');
  const { DiscoveryProjection, discoveryScopeKey } =
    await import('../../../services/main/src/modules/discovery/store.ts');
  const { DiscoveryRefreshStore, DISCOVERY_REFRESH_COST } =
    await import('../../../services/main/src/modules/discovery/refresh-store.ts');
  const { DiscoveryRefreshWorker } =
    await import('../../../services/main/src/modules/discovery/refresh.ts');
  const { GRAPHS, DATASET, iri, lit } =
    await import('../../../services/main/src/modules/work/activate.ts');
  const { GLOBAL_CONTEXT_SCOPE } =
    await import('../../../services/main/src/modules/rating/global.ts');
  const { createMainApp } = await import('../../../services/main/src/app.ts');
  const { Elysia } = await import('elysia');
  const { httpTelemetry } = await import('@rezics/observability/elysia');
  const { workRead } = await import('../../../services/main/src/modules/work/read-session.ts');
  const { discoveryChanges } =
    await import('../../../services/main/src/modules/discovery/changes.ts');
  const f = await startMediaStack('g-1063-cost');
  const evidence: Record<string, unknown>[] = [];
  let probe: InstanceType<typeof Elysia> | undefined;
  try {
    const a = await f.member('writer'),
      target = await f.publicWork(a.actor, ['en'], 'G1063 real rated target');
    await a.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const contextResponse = await a.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1',
      question: 'Quality?',
      actingSubject: a.actor,
    });
    expect(contextResponse.status).toBe(201);
    const { context } = (await contextResponse.json()) as { context: string };
    await a.grant(`rating:observe:${context}`, 'rating.observation.set');
    const epoch = f.env.lineage.dataEpoch;
    let sequence = '0';
    const position = () => ({ dataEpoch: epoch, sequence });
    const refreshPosition = async () => {
      sequence = (
        await f.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?sequence WHERE {GRAPH ${iri(GRAPHS.control)} {${iri(DATASET)} rv:sequence ?sequence}}`)
      ).results!.bindings[0]!.sequence!.value;
    };
    await refreshPosition();
    const projection = new DiscoveryProjection(f.accessPool),
      store = new DiscoveryRefreshStore(f.accessPool);
    const base = { scope: 'global' as const, realm: null, context: null, owner: null },
      rated = { ...base, context };
    const deps = {
      environment: f.env,
      access: f.access,
      discovery: projection,
      account: { verify: async () => a.principal },
      relayPosition: { read: async () => position() },
    };
    const app = createMainApp(f.fuseki, deps);
    const ratingHealth = async () =>
      app.handle(new Request('http://main.local/health/rating-ready'));
    await store.enroll([base, rated]);
    await f.accessPool.query(
      "UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 day'",
    );
    const force = async (key?: string) => {
      if (key)
        await f.accessPool.query(
          "UPDATE access.discovery_refresh SET due_at=CASE WHEN scope_key=$1 THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1 hour' END WHERE priority=0",
          [key],
        );
      else
        await f.accessPool.query(
          "UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second' WHERE priority=0",
        );
    };
    const worker = new DiscoveryRefreshWorker(deps, store, projection);
    let profileKey = discoveryScopeKey(rated);
    probe = new Elysia()
      .use(httpTelemetry())
      .error(({ error }) => new Response(String(error), { status: 500 }))
      .get('/g-1063/refresh', {}, async () => {
        await force(profileKey);
        const result = await new DiscoveryRefreshWorker(deps, store, projection).tick();
        expect(['current', 'activated']).toContain(result);
        return { outcome: result };
      })
      .listen({ hostname: '127.0.0.1', port: 0, idleTimeout: 60 });
    const measured = async () => {
      const { profile } = await profileRequest(
        sink,
        async (headers) => {
          const response = await fetch(`${probe!.server!.url.origin}/g-1063/refresh`, { headers });
          const body = await response.text();
          expect(response.status, body).toBe(200);
          return JSON.parse(body);
        },
        {
          service: 'g-1063-cost',
          peers: { fuseki: Bun.env.FUSEKI_URL! },
          flush: flushTelemetryTraces,
        },
      );
      expect(profile.postgresStatements).toBeGreaterThan(0);
      assertWorkCost(profile, {
        fusekiRequests: DISCOVERY_REFRESH_COST.localGraphCalls,
        postgresStatements: DISCOVERY_REFRESH_COST.localStatements,
        accountCalls: 0,
      });
      return profile;
    };
    const event = async (action: string) => {
      const next = (BigInt(sequence) + 1n).toString();
      await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
        DELETE {GRAPH ${iri(GRAPHS.control)} {${iri(DATASET)} rv:sequence ${sequence}}}
        INSERT {GRAPH ${iri(GRAPHS.control)} {${iri(DATASET)} rv:sequence ${next}}
          GRAPH ${iri(GRAPHS.outbox)} {<urn:g1063:batch:${next}> a rv:OutboxBatch;
            rv:dataEpoch ${lit(epoch)};rv:sequence ${next};rv:eventCount 1;rv:event <urn:g1063:event:${next}>.
            <urn:g1063:event:${next}> rv:ordinal 0;rv:action ${lit(action)} }}
        WHERE {GRAPH ${iri(GRAPHS.control)} {${iri(DATASET)} rv:sequence ${sequence}}}`);
      sequence = next;
    };
    const id = (n: number) =>
      `https://rezics.com/id/${String(n).padStart(8, '0')}-1063-4000-8000-000000000099`;
    let populated = 1;
    const irrelevantProfiles: WorkProfile[] = [],
      localProfiles: WorkProfile[] = [];
    let observationHead: string | null = null;
    for (const scale of [100, 1000, 10000]) {
      const prepared = performance.now();
      for (; populated < scale;) {
        const size = Math.min(250, scale - populated),
          offset = populated;
        const rows = Array.from({ length: size }, (_, i) => {
          const n = (offset + i) * 10;
          return `GRAPH ${iri(GRAPHS.current)} {
            ${iri(id(n))} a schema:CreativeWork,schema:Book;rv:head ${iri(id(n + 1))};rv:mainVersion ${iri(id(n + 2))}.
            ${iri(id(n + 2))} a rv:MainVersion;rv:work ${iri(id(n))};rv:selectionHead ${iri(id(n + 3))}.
            ${iri(id(n + 4))} rv:work ${iri(id(n))};rv:publicationHead ${iri(id(n + 5))}.
          } GRAPH ${iri(GRAPHS.revisions)} {
            ${iri(id(n + 1))} a rv:RevisionAnchor;rv:component ${iri(id(n))};rv:dataEpoch ${lit(epoch)};rv:sequence ${sequence}.
            ${iri(id(n + 3))} a rv:PublicationSelection;rv:work ${iri(id(n))};rv:mainVersion ${iri(id(n + 2))};
              rv:contribution ${iri(id(n + 4))};rv:publicationDecision ${iri(id(n + 5))};rv:selectedDraft ${iri(id(n + 6))}.
            ${iri(id(n + 5))} a rv:PublicationDecision;rv:component ${iri(id(n + 4))};rv:work ${iri(id(n))};
              rv:contribution ${iri(id(n + 4))};rv:disclosure rv:Public;rv:selectedDraft ${iri(id(n + 6))}.
            ${iri(id(n + 6))} a rv:RevisionAnchor;rv:component ${iri(id(n + 4))}.
          }`;
        }).join('\n');
        await f.fuseki.update(
          `PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/> INSERT DATA {${rows}}`,
        );
        populated += size;
      }
      expect(performance.now() - prepared).toBeLessThan(600_000);
      if (scale > 100) await event('semantic.change');
      const started = performance.now(),
        before = f.fuseki.queries;
      let ticks = 0;
      for (; ticks < 1000; ticks++) {
        await force();
        const result = await worker.tick();
        expect(result).not.toBe('retry');
        const active = await projection.active(rated, position()).catch(() => null);
        const publicActive = await projection.active(base, position()).catch(() => null);
        if (
          active &&
          !active.stale &&
          active.work_count === String(scale) &&
          publicActive &&
          !publicActive.stale &&
          publicActive.work_count === String(scale)
        )
          break;
        if (performance.now() - started > DISCOVERY_REFRESH_COST.fullBuildMs)
          throw new Error('G1063 five-minute full build budget');
        await Bun.sleep(DISCOVERY_REFRESH_COST.intervalMs);
      }
      const full = {
        ms: performance.now() - started,
        ticks: ticks + 1,
        graphCalls: f.fuseki.queries - before,
      };
      expect(full.ms).toBeLessThan(DISCOVERY_REFRESH_COST.fullBuildMs);
      expect((await ratingHealth()).status).toBe(200);
      for (const scopes of [0, 1000]) {
        await f.accessPool.query('DELETE FROM access.discovery_refresh WHERE priority=1');
        if (scopes)
          await f.accessPool.query(
            `INSERT INTO access.discovery_refresh(scope_key,basis,due_at)
          SELECT md5(i::text)||md5('g1063'||i::text),jsonb_build_object('scope','realm','realm',$1::text,'context',NULL,'owner',NULL),
            clock_timestamp()-interval '1 hour' FROM generate_series(1,$2) i`,
            [id(999999), scopes],
          );
        await f.accessPool.query('ANALYZE access.discovery_refresh');
        const generations = (
          await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_generation')
        ).rows[0].n;
        await event('relation.change');
        const prior = await projection.active(rated, position());
        const debug = await workRead(
          deps,
          new Request('http://main.internal/g1063'),
          {},
          (session) =>
            discoveryChanges(session, prior.covered_sequence ?? prior.source_sequence, rated),
        );
        expect(debug, JSON.stringify({ prior, position: position() })).toEqual({
          works: [],
          created: [],
        });
        profileKey = discoveryScopeKey(rated);
        const irrelevant = await measured();
        irrelevantProfiles.push(irrelevant);
        expect(
          (await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_generation'))
            .rows[0].n,
        ).toBe(generations);
        expect((await ratingHealth()).status).toBe(200);
        const entries = (
          await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_entry')
        ).rows[0].n;
        const written = await a.send('POST', '/v1/global-rating-observations', {
          profile: 'global-rating-standing-observation-v1',
          context,
          work: target.work,
          mainVersion: target.mainVersion,
          value: scopes ? 5 : 4,
          expectedRevisionHead: observationHead,
          actingSubject: a.actor,
        });
        const body = (await written.json()) as {
          observationRevision?: string;
          revisionHead?: string;
          revision?: string;
        };
        expect(written.status, JSON.stringify(body)).toBe(201);
        observationHead = body.observationRevision ?? body.revisionHead ?? body.revision ?? null;
        expect(observationHead).not.toBeNull();
        await refreshPosition();
        const recovery = performance.now();
        const local = await measured();
        localProfiles.push(local);
        expect((await ratingHealth()).status).toBe(200);
        expect(performance.now() - recovery).toBeLessThan(DISCOVERY_REFRESH_COST.recoveryMs);
        // The real target has only the wildcard posting; the unrelated native
        // background has Book postings too. No background row is duplicated.
        expect(
          (await f.accessPool.query('SELECT count(*)::int AS n FROM access.discovery_entry'))
            .rows[0].n - entries,
        ).toBe(1);
        const current = await projection.active(rated, position());
        expect(current.changed_works).toEqual([target.work]);
        expect(
          (await projection.page(current, 'top-rated', '', '', 20))[0]!.payload.rating!.mean,
        ).toBe(scopes ? 5 : 4);
        const plan = (
          await f.accessPool.query(
            `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT work,payload FROM access.discovery_entries($1)
          WHERE work=$2 AND work_type='' AND term=''`,
            [current.generation_id, target.work],
          )
        ).rows[0]['QUERY PLAN'];
        expect(JSON.stringify(plan)).not.toContain('Function Scan');
        evidence.push({ scale, idleScopes: scopes, full, irrelevant, local, plan });
      }
    }
    assertWorkCostAtScales(irrelevantProfiles, {
      fusekiRequests: DISCOVERY_REFRESH_COST.irrelevantGraphCalls,
      postgresStatements: DISCOVERY_REFRESH_COST.irrelevantStatements,
    });
    assertWorkCostAtScales(localProfiles, {
      fusekiRequests: DISCOVERY_REFRESH_COST.localGraphCalls,
      postgresStatements: DISCOVERY_REFRESH_COST.localStatements,
    });
    console.log(
      'G1063 measured',
      evidence.map(({ scale, idleScopes, full, irrelevant, local }) => ({
        scale,
        idleScopes,
        full,
        irrelevant: {
          graph: (irrelevant as WorkProfile).fusekiRequests,
          sql: (irrelevant as WorkProfile).postgresStatements,
        },
        local: {
          graph: (local as WorkProfile).fusekiRequests,
          sql: (local as WorkProfile).postgresStatements,
        },
      })),
    );
  } finally {
    mkdirSync('.temp/g-1063', { recursive: true });
    writeFileSync(
      `.temp/g-1063/cost-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(evidence, null, 2),
    );
    await probe?.stop();
    await f.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 420_000);
