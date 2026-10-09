import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { requireQa } from './recommendation-support.ts';
import { startMediaStack } from './media-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const subject = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#subject>';

test('discovery activates under a steady stream of unrelated votes and shelf changes, and a vote on its Work reports it stale until a delta covers it', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  const f = await startMediaStack('discovery-continuous', { ownerUrls: owners.urls });
  const relay = new Pool({ connectionString: owners.urls.relay });
  const statement = native();
  let judgedStatement = false;
  try {
    const writer = await f.member('continuous writer');
    const work = await f.publicWork(writer.actor, ['en'], 'Continuously judged Work');
    const consumer = `discovery-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    for (let i = 0; i < 100; i++) {
      if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) break;
      if (i === 99) throw new Error('Fixture relay exceeded its batch bound');
    }
    const position = new RelayHandoffPositions(relay, consumer);
    const projection = new DiscoveryProjection(f.accessPool), store = new DiscoveryRefreshStore(f.accessPool);
    const judgments = new AccessJudgments(f.accessPool);
    const deps: Partial<MainWorkDependencies> = { environment: f.env, access: f.access, judgments,
      discovery: projection, relayPosition: position };
    const worker = new DiscoveryRefreshWorker(deps as MainWorkDependencies, store, projection);
    const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(basis);
    await store.enroll([basis]);
    await f.accessPool.query("UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 hour'");
    const tick = async () => {
      await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second'
        WHERE scope_key=$1`, [key]);
      return worker.tick();
    };
    const active = async () => (await f.accessPool.query<{ active_generation: string }>(`SELECT active_generation
      FROM access.derived_generation_head WHERE family='discovery' AND scope_key=$1`, [key])).rows[0]?.active_generation;

    // Every graph read of the build is followed by one vote on a Statement no
    // Work is about and one shelf change: a deterministic stream, not a timer.
    const voter = { issuer: `https://qa-discovery-continuous.test`, subject: randomUUID() };
    await f.accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [randomUUID(), voter.issuer, voter.subject]);
    const shelves = new ReaderLibraryStatusStore(f.contentPool);
    const vote = (target: string) => judgments.write(voter, { statement: target, context: { kind: 'global' },
      dimension: 'fit', value: 1, expectedRevision: '0', idempotencyKey: randomUUID(),
      requestDigest: randomUUID().replaceAll('-', '').repeat(2) });
    let streaming = true, writes = 0;
    const query = f.fuseki.query.bind(f.fuseki);
    f.fuseki.query = async (sparql, bytes) => {
      const result = await query(sparql, bytes);
      if (streaming) {
        writes++;
        await vote(native());
        await shelves.write({ agent: native(), work: native(), status: 'read', expectedVersion: 0,
          idempotencyKey: randomUUID() });
      }
      return result;
    };
    const outcomes: string[] = [];
    try {
      while (outcomes.at(-1) !== 'activated') {
        outcomes.push(await tick());
        expect(outcomes.length).toBeLessThan(40);
      }
    } finally { streaming = false; f.fuseki.query = query; }
    expect(writes).toBeGreaterThan(outcomes.length);
    expect(outcomes.every(outcome => outcome === 'advanced' || outcome === 'activated')).toBe(true);
    expect((await f.accessPool.query(`SELECT count(*)::int AS n FROM access.derived_generation
      WHERE family='discovery' AND scope_key=$1 AND state <> 'ready'`, [key])).rows[0].n).toBe(0);
    const built = (await active())!;

    // The stream's votes reach this basis until a refresh finds their
    // Statements outside its population and acknowledges them in place.
    expect((await projection.active(basis, (await position.read())!)).stale).toBe(true);
    expect(await tick()).toBe('current');
    expect(await active()).toBe(built);
    const acknowledged = await projection.active(basis, (await position.read())!);
    expect(acknowledged.stale).toBe(false);
    expect(BigInt(acknowledged.covered_access_revision!)).toBeGreaterThan(BigInt(acknowledged.access_revision));

    // A vote on a Statement about the projected Work reports it stale, and the
    // next refresh projects only that Work as a delta of the same storage.
    await f.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} ${subject} ${iri(work.mainVersion)} } }`);
    judgedStatement = true;
    await vote(statement);
    expect((await projection.active(basis, (await position.read())!)).stale).toBe(true);
    expect(await tick()).toBe('activated');
    const delta = await projection.active(basis, (await position.read())!);
    expect(delta.stale).toBe(false);
    expect(delta.generation_id).not.toBe(built);
    expect(delta.changed_works).toEqual([work.work]);
    expect(delta.storage_generation).toBe(built);
    expect((await projection.page(delta, 'recent', '', '', 20)).map(row => row.work)).toContain(work.work);

    // Relevant graph writes continue between every fenced tick. Use legal
    // one-Work checkpoints so both the initial scan and catch-up span ticks.
    await f.publicWork(writer.actor, ['en'], 'First pending discovery Work');
    await f.publicWork(writer.actor, ['en'], 'Second pending discovery Work');
    const drain = async () => {
      for (let i = 0; i < 100; i++) {
        if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) return;
      }
      throw new Error('Fixture relay exceeded its batch bound');
    };
    await drain();
    const commit = projection.commitBatch.bind(projection);
    projection.commitBatch = (operator, id, lease, checkpoint, result, at) => {
      if (result.items.length <= 1) return commit(operator, id, lease, checkpoint, result, at);
      return commit(operator, id, lease, checkpoint,
        { items: result.items.slice(0, 1), after: result.items[0]!.work, complete: false }, at);
    };
    let lastWrite = work.work;
    const relevant: string[] = [];
    try {
      while (relevant.at(-1) !== 'activated') {
        relevant.push(await tick());
        expect(relevant.length).toBeLessThanOrEqual(6);
        lastWrite = (await f.publicWork(writer.actor, ['en'], 'A later discovery Work')).work;
        await drain();
      }
    } finally { projection.commitBatch = commit; }
    expect(relevant.length).toBeGreaterThan(2);
    const cut = await projection.active(basis, (await position.read())!);
    expect(cut.stale).toBe(true);
    expect(cut.covered_sequence).toBe(cut.source_sequence);
    expect(BigInt(cut.covered_sequence!)).toBeLessThan(BigInt((await position.read())!.sequence));
    expect((await f.accessPool.query<{ checkpoint: string }>(`SELECT checkpoint_sequence::text AS checkpoint
      FROM access.derived_generation_input WHERE generation_id=$1 AND source='main-graph'`,
    [cut.generation_id])).rows[0]!.checkpoint).toBe(cut.source_sequence);
    expect((await projection.page(cut, 'recent', '', '', 20)).map(row => row.work)).not.toContain(lastWrite);
    // The following refresh covers the later births without skipping them.
    expect(await tick()).toBe('activated');
    const current = await projection.active(basis, (await position.read())!);
    expect(current.stale).toBe(false);
    expect((await projection.page(current, 'recent', '', '', 20)).map(row => row.work)).toContain(lastWrite);
  } finally {
    // The graph is shared by the shard; remove the fixture Statement.
    if (judgedStatement) await f.fuseki.update(
      `DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} ${subject} ?main } }`);
    await relay.end(); await f.stop(); await owners.close();
  }
}, 240_000);
