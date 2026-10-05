import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AlsoEnjoyedStore } from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { automaticCoReaders } from '../../../services/main/src/modules/also-enjoyed/automation.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneOwners, requireQa } from './recommendation-support.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('scheduled co-readers activate under continuous shelf writes, retain stale signals, and withhold privacy changes until covered', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  const stack = await startMediaStack('also-enjoyed-continuous', { ownerUrls: owners.urls });
  try {
    const manager = await stack.member('manager');
    const source = await stack.publicWork(manager.actor, ['en'], 'A continuously shelved source');
    const candidate = await stack.publicWork(manager.actor, ['en'], 'A continuously shelved candidate');
    const readers = await Promise.all(['reader-1', 'reader-2', 'reader-3', 'reader-4']
      .map(name => stack.member(name)));
    for (const reader of readers) {
      const representation = (await stack.accessPool.query<{ id: string }>(`
        SELECT id::text FROM access.representation WHERE principal_id = $1 AND subject_id = $2
          LIMIT 1`, [reader.principalId, reader.actor])).rows[0]!.id;
      await stack.accessPool.query(`INSERT INTO access.agent_provision
        (id, principal_id, idempotency_key, request_digest, agent_id, agent_kind,
          display_name, principal_epoch, state, graph_data_epoch, graph_sequence, representation_id)
        VALUES ($1,$2,$3,$4,$5,'person',$6,0,'active',$7,0,$8)`,
      [randomUUID(), reader.principalId, `also-${randomUUID()}`, 'a'.repeat(64), reader.actor,
        reader.name, stack.env.lineage.dataEpoch, representation]);
      await stack.accessPool.query(`INSERT INTO access.agent_library_visibility
        (agent_id, visibility, version) VALUES ($1,'public',1)`, [reader.actor]);
      for (const work of [source.work, candidate.work]) await stack.contentPool.query(`INSERT INTO
        reader.library_status (agent, work, status, version) VALUES ($1,$2,'read',1)`, [reader.actor, work]);
    }
    const voter = { issuer: 'https://qa-also-enjoyed-continuous.test', subject: randomUUID() };
    await stack.accessPool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
      [randomUUID(), voter.issuer, voter.subject]);
    const judgments = new AccessJudgments(stack.accessPool);
    const shelves = new ReaderLibraryStatusStore(stack.contentPool);
    const vote = () => judgments.write(voter, { statement: native(), context: { kind: 'global' },
      dimension: 'fit', value: 1, expectedRevision: '0', idempotencyKey: randomUUID(),
      requestDigest: randomUUID().replaceAll('-', '').repeat(2) });
    const shelve = (status: 'want-to-read' | 'read') => shelves.write({ agent: native(), work: native(), status,
      expectedVersion: 0, idempotencyKey: randomUUID() });
    const count = async (log: string, pool = stack.accessPool) =>
      Number((await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${log}`)).rows[0]!.n);
    const logs = async () => ({ access: await count('access.also_enjoyed_source_change'),
      content: await count('reader.also_enjoyed_source_change', stack.contentPool) });
    await manager.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const contextResponse = await manager.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'How good is this book?', actingSubject: manager.actor,
    });
    expect(contextResponse.status, await contextResponse.clone().text()).toBe(201);
    const global = await contextResponse.json() as { context: string };
    const ratingReader = readers[3]!;
    await ratingReader.grant(`rating:observe:${global.context}`, 'rating.observation.set');

    const store = new AlsoEnjoyedStore(stack.accessPool, stack.contentPool);
    // These owner paths read no Account assertion.
    const owned: Partial<MainWorkDependencies> = { environment: stack.env, access: stack.access,
      media: stack.media, alsoEnjoyed: store };
    const deps = owned as MainWorkDependencies;
    const worker = new DiscoveryRefreshWorker(deps, new DiscoveryRefreshStore(stack.accessPool),
      new DiscoveryProjection(stack.accessPool));
    const scheduled = async (prior: string | null, stream: () => Promise<unknown>) => {
      for (let ticks = 1; ticks <= 20; ticks++) {
        await stream();
        expect(await worker.tick()).toBe('idle');
        const current = await store.candidates(source.work);
        if (current.generation && current.generation !== prior) return { ...current, ticks };
      }
      throw new Error('Scheduled co-reader activation exceeded 20 ticks');
    };

    // Cold start requires no manual build or human management grant. Votes and
    // want-to-read shelves append no input changes, so this cut stays current.
    expect((await store.candidates(source.work)).generation).toBeNull();
    const unrelated = await scheduled(null, async () => { await vote(); await shelve('want-to-read'); });
    expect(unrelated.ticks).toBeGreaterThan(2);
    expect(await logs()).toEqual({ access: 0, content: 0 });
    expect(unrelated).toMatchObject({ stale: false, sourceReaders: 4 });
    expect(unrelated.candidates.find(item => item.work === candidate.work)?.sharedReaders).toBe(4);

    // An admitted rating is also a signal, both while its row is pending and
    // after a fold. Neither state revokes the public overlaps already active.
    const ratingResponse = await ratingReader.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context: global.context, work: source.work,
      mainVersion: source.mainVersion, value: 5, expectedRevisionHead: null, actingSubject: ratingReader.actor,
    });
    expect(ratingResponse.status, await ratingResponse.clone().text()).toBe(201);
    expect(await store.candidates(source.work)).toMatchObject({ generation: unrelated.generation, stale: true });
    await store.fold();
    expect(await store.candidates(source.work)).toMatchObject({ generation: unrelated.generation, stale: true });

    // No manual registration, advance or activation: shelf changes before every
    // tick make the active replacement stale without hiding its overlaps.
    const related = await scheduled(unrelated.generation!, async () => { await vote(); await shelve('read'); });
    expect(related.ticks).toBeGreaterThan(2);
    expect(related).toMatchObject({ stale: true, sourceReaders: 4 });
    expect(related.candidates.find(item => item.work === candidate.work)?.sharedReaders).toBe(4);
    expect((await logs()).content).toBeGreaterThan(0);

    // Changing an existing input also retains the active generation.
    await stack.contentPool.query(`UPDATE reader.library_status SET status = 'want-to-read', version = version + 1
      WHERE agent = $1 AND work = $2`, [readers[0]!.actor, candidate.work]);
    expect(await store.candidates(source.work)).toMatchObject({ generation: related.generation, stale: true });

    // A privacy write in the same transaction as a signal write still records
    // its own change. Folding cannot make that invalidation disappear.
    const client = await stack.accessPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT access.record_also_enjoyed_source_change(false)');
      await client.query(`UPDATE access.agent_library_visibility SET visibility='private',version=version+1
        WHERE agent_id=$1`, [readers[0]!.actor]);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true, candidates: [] });
    expect(await store.privacyCurrent(related.generation!)).toBe(false);
    await store.fold();
    expect(await logs()).toEqual({ access: 0, content: 0 });
    expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true });
    const covered = await scheduled(related.generation!, () => shelve('read'));
    expect(covered.sourceReaders).toBe(3);
    expect(await store.privacyCurrent(covered.generation!)).toBe(true);

    // Deactivation, physical erasure and recovery all revoke retained inputs.
    for (const revoke of [
      () => stack.accessPool.query('UPDATE access.principal SET active=false WHERE id=$1', [readers[1]!.principalId]),
      async () => {
        const prior = (await store.candidates(source.work)).generation;
        await stack.contentPool.query(`UPDATE reader.library_status SET status=NULL,version=version+1
          WHERE agent=$1`, [readers[2]!.actor]);
        expect(await store.candidates(source.work)).toMatchObject({ generation: prior, stale: true });
        await stack.contentPool.query('DELETE FROM reader.library_status WHERE agent=$1', [readers[2]!.actor]);
      },
      () => stack.accessPool.query('UPDATE access.recovery_fence SET generation=generation+1 WHERE id'),
    ]) {
      const prior = (await store.candidates(source.work)).generation!;
      await revoke();
      expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true });
      await store.fold();
      expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true });
      expect((await scheduled(prior, async () => undefined)).stale).toBe(false);
    }

    // A delayed ready build must not roll back a newer, covering head. Stage
    // two operator builds, activate the newer one, then resume the scheduler.
    const position = await workRead(deps, new Request('http://main.local/position'), {},
      async session => session.position);
    const request = new Request('http://main.local/also-enjoyed/advance');
    const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) });
    const stage = async () => {
      const { generation } = await store.register(automaticCoReaders, position, receipt());
      for (let steps = 0; (await store.generation(generation)).phase !== 'complete'; steps++) {
        expect(steps).toBeLessThan(20);
        await store.advance(generation, automaticCoReaders, deps, request);
      }
      return generation;
    };
    const older = await stage();
    await shelve('read');
    const newer = await stage();
    const head = (await stack.accessPool.query<{ revision: string }>(`SELECT revision::text
      FROM access.derived_generation_head WHERE family='also-enjoyed'`)).rows[0]!.revision;
    expect((await store.activate(automaticCoReaders, newer, head, receipt(), position)).outcome).toBe('succeeded');
    expect(await worker.tick()).toBe('idle');
    expect((await store.generation(older)).state).toBe('cancelled');
    expect(await store.candidates(source.work)).toMatchObject({ generation: newer, stale: false });
  } finally { await stack.stop(); await owners.close(); }
}, 240_000);
