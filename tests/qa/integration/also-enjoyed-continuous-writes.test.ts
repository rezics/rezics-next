import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AlsoEnjoyedStore } from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneOwners, requireQa } from './recommendation-support.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('co-readers activate under a steady stream of votes and shelf changes, report input changes stale, and the refresh tick folds both logs', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  const stack = await startMediaStack('also-enjoyed-continuous', { ownerUrls: owners.urls });
  try {
    const manager = await stack.member('manager');
    await manager.grant(MANAGE_SCOPE, MANAGE_ACTION);
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

    const store = new AlsoEnjoyedStore(stack.accessPool, stack.contentPool);
    // These owner paths read no Account assertion.
    const owned: Partial<MainWorkDependencies> = { environment: stack.env, access: stack.access,
      media: stack.media, alsoEnjoyed: store };
    const deps = owned as MainWorkDependencies;
    const context = { principal: manager.principal, actingSubject: manager.actor };
    const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    const buildRequest = new Request('http://main.local/v1/also-enjoyed/generations/advance', { method: 'POST' });
    const position = await workRead(deps, new Request('http://main.local/position'), {},
      async session => session.position);
    // One vote and one shelf change before every step: a deterministic stream.
    const build = async (stream: () => Promise<unknown>, head: string | null) => {
      const { generation } = await store.register(context, position, receipt());
      let advances = 0;
      while ((await store.generation(generation)).phase !== 'complete') {
        await stream();
        await store.advance(generation, context, deps, buildRequest);
        expect(++advances).toBeLessThan(20);
      }
      await stream();
      expect((await store.activate(context, generation, head, receipt(), position)).outcome).toBe('succeeded');
      return { generation, advances };
    };

    // Votes and want-to-read shelves are not co-reader inputs: they append no
    // change row and the generation stays current through them.
    const unrelated = await build(async () => { await vote(); await shelve('want-to-read'); }, null);
    expect(unrelated.advances).toBeGreaterThan(2);
    expect(await logs()).toEqual({ access: 0, content: 0 });
    const served = await store.candidates(source.work);
    expect(served).toMatchObject({ generation: unrelated.generation, stale: false, sourceReaders: 4 });
    expect(served.candidates.find(item => item.work === candidate.work)?.sharedReaders).toBe(4);

    // Read shelves are inputs. A build under a stream of them still completes
    // and activates against its basis; the later changes report it stale.
    const related = await build(async () => { await vote(); await shelve('read'); }, '1');
    expect(related.advances).toBeGreaterThan(2);
    expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true, candidates: [] });

    // Without a manual build, the refresh tick folds both change logs.
    await stack.accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [native()]);
    const pending = await logs();
    expect(pending.access).toBe(1);
    expect(pending.content).toBeGreaterThan(related.advances);
    const worker = new DiscoveryRefreshWorker(deps, new DiscoveryRefreshStore(stack.accessPool),
      new DiscoveryProjection(stack.accessPool));
    expect(await worker.tick()).toBe('idle');
    expect(await logs()).toEqual({ access: 0, content: 0 });

    // A shelf change to a Work in the current generation's scope reports it stale.
    const clean = await build(async () => undefined, '2');
    expect(await store.candidates(source.work)).toMatchObject({ generation: clean.generation, stale: false });
    await stack.contentPool.query(`UPDATE reader.library_status SET status = 'want-to-read', version = version + 1
      WHERE agent = $1 AND work = $2`, [readers[0]!.actor, candidate.work]);
    expect(await store.candidates(source.work)).toMatchObject({ generation: null, stale: true });
  } finally { await stack.stop(); await owners.close(); }
}, 240_000);
