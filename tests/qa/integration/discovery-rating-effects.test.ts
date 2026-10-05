import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { startMediaStack } from './media-support.ts';
import { cloneOwners, requireQa } from './recommendation-support.ts';
import { isolateDiscoveryProbeGraph } from './discovery-projection-fixture.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import {
  DiscoveryProjection,
  discoveryScopeKey,
} from '../../../services/main/src/modules/discovery/store.ts';
import {
  DiscoveryRefreshStore,
  DISCOVERY_REFRESH_COST,
} from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { discoveryChanges } from '../../../services/main/src/modules/discovery/changes.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, status = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

/** Native background triples isolate refresh cost. Rating values and inventory
 * heads use the real API; receipt fixtures cover the target-only event contract. */
test('Target ratings advance only relevant Work aggregates at 1k/10k, and inventory restores recover readiness', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  const f = await startMediaStack('discovery-rating-effects', { ownerUrls: owners.urls });
  const restoreGraph = await isolateDiscoveryProbeGraph(f.env);
  const evidence: unknown[] = [];
  try {
    const writer = await f.member('rating-writer');
    const target = await f.publicWork(writer.actor, ['en'], 'Rated Work');
    await writer.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const { context } = await json<{ context: string }>(
      await writer.send('POST', '/v1/global-rating-contexts', {
        profile: 'global-rating-standing-context-v1',
        question: 'Quality?',
        actingSubject: writer.actor,
      }),
    );
    await writer.grant(`rating:observe:${context}`, 'rating.observation.set');
    let sequence = '0';
    const epoch = f.env.lineage.dataEpoch;
    const position = () => ({ dataEpoch: epoch, sequence });
    const refreshPosition = async () => {
      sequence = (
        await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }`)
      ).results!.bindings[0]!.sequence!.value;
    };
    await refreshPosition();
    const projection = new DiscoveryProjection(f.accessPool),
      store = new DiscoveryRefreshStore(f.accessPool);
    const basis = { scope: 'global' as const, realm: null, context, owner: null };
    const deps = {
      environment: f.env,
      access: f.access,
      discovery: projection,
      account: { verify: async () => writer.principal },
      relayPosition: { read: async () => position() },
    };
    const app = createMainApp(f.fuseki, deps);
    const health = () => app.handle(new Request('http://main.local/health/rating-ready'));
    await store.enroll([basis]);
    await f.accessPool.query(
      "UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 day'",
    );
    const force = () =>
      f.accessPool.query(
        `UPDATE access.discovery_refresh SET due_at=
      CASE WHEN scope_key=$1 THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1 day' END`,
        [discoveryScopeKey(basis)],
      );
    const tick = async () => {
      await force();
      return new DiscoveryRefreshWorker(deps, store, projection).tick();
    };
    const settle = async (count: number) => {
      const started = performance.now();
      for (let n = 0; n < 200; n++) {
        expect(await tick()).not.toBe('retry');
        const current = await projection.active(basis, position()).catch(() => null);
        if (current && !current.stale && current.work_count === String(count)) return current;
        if (performance.now() - started > DISCOVERY_REFRESH_COST.fullBuildMs) break;
      }
      throw new Error('Standing projection did not become current within its build budget');
    };
    const sqlMeter = new AsyncLocalStorage<{ statements: number }>(),
      metered = new WeakSet<PoolClient>();
    f.accessPool.on('acquire', (client) => {
      if (metered.has(client)) return;
      metered.add(client);
      const query = client.query;
      client.query = function (...args: unknown[]) {
        const meter = sqlMeter.getStore();
        if (meter) meter.statements++;
        return Reflect.apply(query, this, args);
      } as typeof client.query;
    });
    const measured = async (kind: 'irrelevant' | 'local', scale: number) => {
      const before = f.fuseki.queries,
        sql = { statements: 0 };
      const outcome = await sqlMeter.run(sql, tick);
      expect(outcome).toBe(kind === 'irrelevant' ? 'current' : 'activated');
      const cost = { graph: f.fuseki.queries - before, sql: sql.statements };
      expect(cost).toEqual(kind === 'irrelevant' ? { graph: 4, sql: 46 } : { graph: 8, sql: 126 });
      evidence.push({ kind, scale, cost });
    };
    // Repair writes append unfolded changes; only a refresh registration folds them.
    const fenceSql = `SELECT revision::text,
      (SELECT count(*) FROM access.discovery_source_change)::text AS changes
      FROM access.discovery_source_fence WHERE id`;
    const fence = async (client: Pool | PoolClient = f.accessPool) => {
      const row = (await client.query<{ revision: string; changes: string }>(fenceSql)).rows[0]!;
      return { revision: BigInt(row.revision), changes: BigInt(row.changes) };
    };
    const changed = (base: { revision: bigint; changes: bigint }, changes: bigint) => ({
      revision: base.revision,
      changes: base.changes + changes,
    });
    const event = async (action: string, ratedTarget?: string, owned = false) => {
      const next = (BigInt(sequence) + 1n).toString(),
        batch = `urn:rezics:qa:rating-batch:${randomUUID()}`;
      const receipt = `urn:rezics:qa:rating-receipt:${randomUUID()}`;
      await f.fuseki.update(`PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${sequence} } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${next} }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(epoch)} ;
            rv:sequence ${next} ; rv:eventCount 1 ; rv:event ${iri(`${batch}:event`)} .
            ${iri(`${batch}:event`)} rv:ordinal 0 ; rv:action ${lit(action)} ; rv:ratingContext ${iri(context)} ; rv:receipt ${iri(receipt)} }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:ratingContext ${iri(context)} ; rv:outcome rv:Succeeded .
            ${ratedTarget ? `${iri(receipt)} rv:target ${iri(ratedTarget)} .` : ''}
            ${owned ? `${iri(receipt)} rv:work ${iri(target.work)} ; rv:mainVersion ${iri(target.mainVersion)} .` : ''} }
        } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${sequence} } }`);
      sequence = next;
    };
    const id = (n: number) =>
      `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000099`;
    let populated = 1,
      head: string | null = null,
      observation = '';
    const excluded = [
      'Projection',
      'Resource',
      'Character',
      'Person',
      'Release',
      'Realization',
      'Occurrence',
    ].map((grain) => ({ grain, resource: native() }));
    await f.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${excluded.map(({ grain, resource }) => `${iri(resource)} a rv:${grain} ; rv:work ${iri(target.work)} .`).join('\n')}
    } }`);
    for (const scale of [1000, 10000]) {
      const prepared = performance.now();
      for (; populated < scale;) {
        const size = Math.min(250, scale - populated),
          offset = populated;
        await f.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
          ${Array.from({ length: size }, (_, i) => {
            const n = (offset + i) * 10;
            return `GRAPH ${iri(GRAPHS.current)} {
              ${iri(id(n))} a schema:CreativeWork,schema:Book ; rv:head ${iri(id(n + 1))} ; rv:mainVersion ${iri(id(n + 2))} .
              ${iri(id(n + 2))} a rv:MainVersion ; rv:work ${iri(id(n))} ; rv:selectionHead ${iri(id(n + 3))} .
              ${iri(id(n + 4))} rv:work ${iri(id(n))} ; rv:publicationHead ${iri(id(n + 5))} .
            } GRAPH ${iri(GRAPHS.revisions)} {
              ${iri(id(n + 1))} a rv:RevisionAnchor ; rv:component ${iri(id(n))} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} .
              ${iri(id(n + 3))} a rv:PublicationSelection ; rv:work ${iri(id(n))} ; rv:mainVersion ${iri(id(n + 2))} ;
                rv:contribution ${iri(id(n + 4))} ; rv:publicationDecision ${iri(id(n + 5))} ; rv:selectedDraft ${iri(id(n + 6))} .
              ${iri(id(n + 5))} a rv:PublicationDecision ; rv:component ${iri(id(n + 4))} ; rv:work ${iri(id(n))} ;
                rv:contribution ${iri(id(n + 4))} ; rv:disclosure rv:Public ; rv:selectedDraft ${iri(id(n + 6))} .
              ${iri(id(n + 6))} a rv:RevisionAnchor ; rv:component ${iri(id(n + 4))} .
            }`;
          }).join('\n')}
        }`);
        populated += size;
      }
      expect(performance.now() - prepared).toBeLessThan(600_000);
      if (scale > 1000) await event('semantic.change');
      await settle(scale);
      expect((await health()).status).toBe(200);
      for (const { grain, resource } of excluded) {
        const prior = await projection.active(basis, position());
        await event(
          'rating.observation.set',
          resource,
          ['Release', 'Realization', 'Occurrence'].includes(grain),
        );
        expect(
          await workRead(deps, new Request('http://main.internal/rating-target'), {}, (session) =>
            discoveryChanges(session, prior.covered_sequence ?? prior.source_sequence, basis),
          ),
        ).toEqual({ works: [], created: [] });
        await measured('irrelevant', scale);
        const current = await projection.active(basis, position());
        expect(current.generation_id).toBe(prior.generation_id);
        expect(current.covered_sequence).toBe(sequence);
      }
      const beforeSeal = await fence();
      const opinion = await json<{ observation: string; observationRevision: string }>(
        await writer.send('POST', '/v1/global-rating-observations', {
          profile: 'global-rating-standing-observation-v1',
          context,
          work: target.work,
          mainVersion: target.mainVersion,
          value: scale === 1000 ? 4 : 5,
          expectedRevisionHead: head,
          actingSubject: writer.actor,
        }),
      );
      head = opinion.observationRevision;
      observation = opinion.observation;
      expect(await fence()).toEqual(beforeSeal);
      await refreshPosition();
      // Preserve the real receipt that certifies the aggregate, but expose the
      // same change through a target-only receipt to the delta classifier.
      const receipt = `urn:rezics:qa:rating-target:${randomUUID()}`;
      await f.fuseki.update(`PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.outbox)} { ?event rv:receipt ?old } }
        INSERT { GRAPH ${iri(GRAPHS.outbox)} { ?event rv:receipt ${iri(receipt)} }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:target ${iri(target.mainVersion)} ;
            rv:ratingContext ${iri(context)} ; rv:outcome rv:Succeeded } }
        WHERE { GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:dataEpoch ${lit(epoch)} ; rv:sequence ${sequence} ; rv:event ?event .
          ?event rv:receipt ?old } }`);
      const prior = await projection.active(basis, position());
      expect(
        await workRead(deps, new Request('http://main.internal/rating-target'), {}, (session) =>
          discoveryChanges(session, prior.covered_sequence ?? prior.source_sequence, basis),
        ),
      ).toEqual({ works: [target.work], created: [] });
      await measured('local', scale);
      const current = await projection.active(basis, position());
      expect(current.changed_works).toEqual([target.work]);
      expect(
        (await projection.page(current, 'top-rated', '', '', 20))[0]!.payload.rating!.mean,
      ).toBe(scale === 1000 ? 4 : 5);
      expect((await health()).status).toBe(200);
      if (scale === 1000) {
        const beforeRepair = await fence();
        const removed = (
          await f.accessPool.query(
            'DELETE FROM access.rating_aggregate_head WHERE observation=$1 RETURNING *',
            [observation],
          )
        ).rows[0]!;
        expect(await fence()).toEqual(changed(beforeRepair, 1n));
        expect((await health()).status).toBe(503);
        await f.accessPool.query(
          'INSERT INTO access.rating_aggregate_head SELECT (jsonb_populate_record(NULL::access.rating_aggregate_head,$1::jsonb)).*',
          [JSON.stringify(removed)],
        );
        expect(await fence()).toEqual(changed(beforeRepair, 2n));
        const started = performance.now();
        const restored = await settle(scale);
        expect(performance.now() - started).toBeLessThan(DISCOVERY_REFRESH_COST.recoveryMs);
        const beforePolicy = await fence();
        expect(beforePolicy.revision).toBeGreaterThan(beforeRepair.revision);
        expect(beforePolicy.changes).toBe(0n);
        expect(restored.generation_id).not.toBe(current.generation_id);
        expect(restored.changed_works).toBeNull();
        expect((await health()).status).toBe(200);
        expect(
          (await projection.page(restored, 'top-rated', '', '', 20))[0]!.payload.rating!.mean,
        ).toBe(4);
        const contextRow = (
          await f.accessPool.query(
            'SELECT * FROM access.rating_aggregate_context WHERE context=$1',
            [context],
          )
        ).rows[0]!;
        await f.accessPool.query(
          'UPDATE access.rating_aggregate_context SET policy_revision=$2 WHERE context=$1',
          [context, native()],
        );
        expect(await fence()).toEqual(changed(beforePolicy, 1n));
        await f.accessPool.query(
          'UPDATE access.rating_aggregate_context SET policy_revision=$2 WHERE context=$1',
          [context, contextRow.policy_revision],
        );
        expect(await fence()).toEqual(changed(beforePolicy, 2n));
        await f.accessPool.query(
          'UPDATE access.rating_aggregate_head SET revision=revision WHERE observation=$1',
          [observation],
        );
        expect(await fence()).toEqual(changed(beforePolicy, 2n));
        const client = await f.accessPool.connect();
        try {
          await client.query('BEGIN');
          await client.query('TRUNCATE access.rating_aggregate_head');
          expect(await fence(client)).toEqual(changed(beforePolicy, 3n));
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
        expect(await fence()).toEqual(changed(beforePolicy, 2n));
        await settle(scale);
        await event('future.rating');
        expect((await settle(scale)).changed_works).toBeNull();
      }
    }
  } finally {
    mkdirSync('.temp/discovery-rating-effects', { recursive: true });
    writeFileSync(
      `.temp/discovery-rating-effects/cost-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(evidence, null, 2),
    );
    await restoreGraph();
    await f.stop();
    await owners.close();
  }
}, 420_000);
