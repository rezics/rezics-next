import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { meterStatements, seedHome } from './feed-read-support.ts';
import { growRealmThreads } from '../../../services/main/tests/g-1034-fixture.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import {
  retireRealmPopulation,
  REALM_RETIREMENT_COST,
} from '../../../services/main/src/modules/rankings/retirement.ts';
import { realmHistoryPopulation } from '../../../services/main/src/modules/rankings/realm-threads.ts';
import { REALM_THREAD_COST } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { BACKPRESSURE_PROFILE_V1 } from '../../../services/main/src/operations/backpressure.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { restoreRealmRankingCorpus } from '../../../services/main/tests/realm-ranking-corpus.ts';

test('G1042: depth, row and ancestor caps report partial results; retired cuts and deleted references drain through invalidation', async () => {
  const restoreStarted = performance.now();
  const restored = await restoreRealmRankingCorpus(400);
  const home = restored.home;
  try {
    const { stack } = home;
    const restoreReadyMs = Math.round(Math.max(restored.elapsedMs, performance.now() - restoreStarted));
    if (restoreReadyMs >= 600_000)
      throw new Error(`Realm ranking corpus restore, startup and readiness took ${restoreReadyMs} ms`);
    console.log(JSON.stringify({ realmRankingFollowupRestoreReadyMs: restoreReadyMs, threads: 400 }));
    // The retained reply commands leave Content projection events in this stopped
    // copy. Advance Content directly so the composed poll does not tick an absent
    // Event Projection owner on every step.
    const projection = stack.composition;
    const contentHead = BigInt((await stack.content.ownerPosition()).sequence);
    const maxBacklog = BigInt(BACKPRESSURE_PROFILE_V1.worker.maxBacklog);
    const targetBacklog = maxBacklog - 100n;
    const projectionStarted = performance.now();
    let checkpoint = await projection.cursor.read(projection.consumer);
    let projectedEvents = 0;
    while (contentHead - BigInt(checkpoint.sequence) >= targetBacklog) {
      if (projectedEvents >= 10_000)
        throw new Error(`Content projection backlog did not fall below ${targetBacklog}`);
      const event = await relayContentProjectionOnce(
        stack.env, projection.content, projection.cursor, projection.consumer,
      );
      if (!event) throw new Error('Content projection stopped before its checkpoint reached the source');
      projectedEvents++;
      checkpoint = await projection.cursor.read(projection.consumer);
    }
    console.log(JSON.stringify({
      realmRankingContentProjectionCatchUpMs: Math.round(performance.now() - projectionStarted),
      projectedEvents,
      remainingBacklog: (contentHead - BigInt(checkpoint.sequence)).toString(),
    }));
    const seed = await seedHome(home, 3);
    // A few hundred product replies exceed one 400-batch relay pass. Resume the
    // same checkpoint instead of treating that bound as a failed population.
    const catchUp = async () => {
      for (let wave = 0; wave < 8; wave++) {
        try {
          await home.project();
          return;
        } catch (error) {
          if (!(error instanceof Error) || !/Home (projection|relay) exceeded/.test(error.message))
            throw error;
        }
      }
      throw new Error('Realm thread projection exceeded its resumable waves');
    };
    const realm = seed.realm.realm,
      epoch = stack.env.lineage.dataEpoch;
    const threads = home.deps.realmReplyThreads;
    const root = `/v1/realms/${realm.slice(-36)}`;
    const readThread = async (reply: string) =>
      home.json<{ complete: boolean; items: unknown[]; ancestors: unknown[] }>(
        await home.call('GET', `${root}/threads/${reply.slice(-36)}`),
      );
    expect((await readThread(seed.discussion.reply)).complete).toBe(true);
    let replyCommands = 0;
    const postReply = async (key: string, parent?: { reply: string; revision: string }) => {
      const started = performance.now();
      const created = await seed.post(key, parent && { reply: parent.reply, revisionId: parent.revision });
      replyCommands++;
      if (replyCommands % 10 === 0 || replyCommands === 1) {
        console.log(JSON.stringify({ realmRankingFollowupReplyCommands: replyCommands,
          lastCommandMs: Math.round(performance.now() - started) }));
      }
      return { reply: created.reply, revision: created.revisionId };
    };
    const chain = await growRealmThreads(postReply, 34, {
      parent: { reply: seed.discussion.reply, revision: seed.discussion.revisionId, chain: true },
      keyPrefix: 'g1042:chain',
    });
    await catchUp();
    // The bounded Content walk has far fewer than 192 rows but crosses depth 32.
    const subtree = await threads.subtree(seed.discussion.reply);
    expect(subtree.length).toBeLessThan(REALM_THREAD_COST.replies);
    expect(subtree.some((node) => node.truncated)).toBe(true);
    expect((await threads.counts(realm, [seed.discussion.reply])).complete).toBe(false);
    expect((await readThread(seed.discussion.reply)).complete).toBe(false);
    const deep = await readThread(chain.at(-1)!.reply);
    expect(deep.ancestors).toHaveLength(REALM_THREAD_COST.ancestors);
    expect(deep.complete).toBe(false);
    // Exactly 32 descendants with no child past the boundary is still complete.
    expect((await readThread(chain[1]!.reply)).complete).toBe(true);
    const page = await home.json<{
      items: { reply: string; replies: { kind: string; value: number } }[];
    }>(await home.call('GET', `${root}/threads?sort=new&limit=20`));
    expect(page.items.find((item) => item.reply === seed.discussion.reply)?.replies.kind).toBe(
      'lower-bound',
    );

    // A broad thread hits the total-row cap independently of the depth cap.
    await growRealmThreads(postReply, 193, {
      parent: { reply: seed.response.reply, revision: seed.response.revisionId, chain: false },
      keyPrefix: 'g1042:wide',
    });
    await catchUp();
    const wide = await threads.subtree(seed.response.reply);
    expect(wide).toHaveLength(REALM_THREAD_COST.replies + 2);
    expect(wide.some((node) => node.truncated)).toBe(false);
    expect((await threads.counts(realm, [seed.response.reply])).complete).toBe(false);
    expect((await readThread(seed.response.reply)).complete).toBe(false);
    await stack.accessPool.query(
      `UPDATE access.feed_item SET realm_thread_indexed=false
      WHERE data_epoch=$1 AND realm=$2`,
      [epoch, realm],
    );
    await catchUp();

    const floor = { dataEpoch: epoch, sequence: '0' };
    await new AccessRealmManagement(stack.accessPool).initialize(
      { ...home.author.principal, emailVerified: true },
      realm,
      seed.author,
      stack.env,
    );
    const membership = randomUUID(),
      privateMembership = randomUUID(),
      consent = randomUUID();
    await stack.accessPool.query(
      `INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision)
      VALUES('realm',$1,1,'g1042') ON CONFLICT DO NOTHING`,
      [realm],
    );
    const policy = (
      await stack.accessPool.query<{ revision: string; terms_revision: string }>(
        `SELECT revision::text,terms_revision FROM access.membership_policy WHERE kind='realm' AND owner_subject=$1`,
        [realm],
      )
    ).rows[0]!;
    await stack.accessPool.query(
      `INSERT INTO access.membership(id,kind,owner_subject,member_subject,state,generation,
      policy_revision,terms_revision,consent_reference) VALUES($1,'realm',$2,$3,'joined',1,$4::bigint,$5,'g1042')`,
      [membership, realm, seed.reader, policy.revision, policy.terms_revision],
    );
    await stack.accessPool.query(
      `INSERT INTO access.private_membership_consent(id,principal_id,principal_epoch,kind,
      owner_subject,policy_revision,terms_revision,next_generation,expires_at)
      SELECT $1,id,enforcement_epoch,'realm',$3,$4::bigint,$5,1,now()+interval '5 minutes' FROM access.principal WHERE id=$2`,
      [consent, home.reader.principalId, realm, policy.revision, policy.terms_revision],
    );
    await stack.accessPool.query(
      `INSERT INTO access.private_membership(id,kind,owner_subject,principal_id,state,generation,
      policy_revision,terms_revision,consent_reference) VALUES($1,'realm',$2,$3,'joined',1,$4::bigint,$5,$6)`,
      [
        privateMembership,
        realm,
        home.reader.principalId,
        policy.revision,
        policy.terms_revision,
        consent,
      ],
    );
    for (const [kind, id] of [
      ['agent', membership],
      ['private', privateMembership],
    ]) {
      await stack.accessPool.query(
        `INSERT INTO access.realm_history_admission(kind,membership_id,generation,data_epoch,sequence)
        VALUES($1,$2,1,$3,0)`,
        [kind, id, epoch],
      );
    }
    const population = await threads.historyPopulation(epoch, realm, floor);
    await catchUp();
    const count = async (table: string, suffix = '') =>
      Number(
        (
          await stack.accessPool.query<{ count: string }>(
            `SELECT count(*)::text FROM access.${table} WHERE data_epoch=$1 AND realm=$2 ${suffix}`,
            [epoch, realm],
          )
        ).rows[0]!.count,
      );
    expect(await count('realm_thread_population_admission')).toBeGreaterThan(
      REALM_RETIREMENT_COST.admissions,
    );
    await stack.accessPool.query(
      `UPDATE access.membership SET state='left',generation=generation+1 WHERE id=$1`,
      [membership],
    );
    await catchUp();
    expect(await count('realm_thread_population')).toBe(1);
    await stack.accessPool.query(
      `UPDATE access.private_membership SET state='left',generation=generation+1,
      terms_revision=NULL,consent_reference=NULL WHERE id=$1`,
      [privateMembership],
    );
    const session = await workRead(
      home.deps,
      new Request('http://main.local/fixture'),
      {},
      (session) => Promise.resolve(session),
    );
    const before = await count('realm_thread_population_admission');
    const meter = meterStatements(), queries = stack.fuseki.queries;
    try {
      await retireRealmPopulation(stack.accessPool, session, epoch, realm, '');
      expect(meter.count()).toBeLessThanOrEqual(REALM_RETIREMENT_COST.postgresStatements);
      expect(stack.fuseki.queries-queries).toBeLessThanOrEqual(REALM_RETIREMENT_COST.graphReads);
    } finally { meter.restore(); }
    expect(before - (await count('realm_thread_population_admission'))).toBe(
      REALM_RETIREMENT_COST.admissions,
    );
    expect(await count('realm_thread_population', 'AND ready')).toBe(0);
    // Retiring a private history cut does not stall the shared public order.
    expect((await home.call('GET', `${root}/threads?sort=best&limit=2`)).status).toBe(200);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
    await expect(
      retireRealmPopulation(stack.accessPool, session, epoch, realm, ''),
    ).rejects.toThrow('Access recovery is held');
    expect(await count('realm_thread_population_admission')).toBe(
      before - REALM_RETIREMENT_COST.admissions,
    );
    await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
    // A concurrent rejoin of the same cut restores every partially removed
    // admission before ready can become true again.
    await stack.accessPool.query(
      `UPDATE access.membership SET state='joined',generation=generation+1 WHERE id=$1`,
      [membership],
    );
    await stack.accessPool.query(
      `INSERT INTO access.realm_history_admission(kind,membership_id,generation,data_epoch,sequence)
      VALUES('agent',$1,3,$2,0)`,
      [membership, epoch],
    );
    await catchUp();
    expect(await count('realm_thread_population_admission')).toBe(before);
    expect(await count('realm_thread_population', 'AND ready')).toBe(1);
    await stack.accessPool.query(
      `UPDATE access.membership SET state='left',generation=generation+1 WHERE id=$1`,
      [membership],
    );
    await catchUp();
    expect(await count('realm_thread_population')).toBe(0);
    expect(await count('realm_thread_population_admission')).toBe(0);
    expect(await count('realm_thread_private_order')).toBe(0);
    expect(await count('realm_thread_population_job')).toBe(0);

    // Deleting a thread invalidates descendants and removes exact-key jobs too.
    await stack.accessPool.query(
      `INSERT INTO access.realm_thread_population(data_epoch,realm,population,floor_epoch,floor_sequence)
      VALUES($1,$2,$3,$1,0)`,
      [epoch, realm, population],
    );
    await stack.accessPool.query(
      `INSERT INTO access.realm_thread_population_job VALUES($1,$2,$3,$4)`,
      [epoch, realm, population, seed.discussion.reply],
    );
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?slot rv:reply ${iri(seed.discussion.reply)} ; rv:replyPlacementHead ?head } }`);
    await stack.accessPool.query(
      `INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource) VALUES($1,'reply',$2)
      ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key=''`,
      [epoch, seed.discussion.reply],
    );
    await catchUp();
    expect(await count('realm_thread_reference', `AND reply='${seed.discussion.reply}'`)).toBe(0);
    expect(await count('realm_thread_population_job', `AND reply='${seed.discussion.reply}'`)).toBe(
      0,
    );
    expect(
      await count('realm_thread_reference', `AND parent='${seed.discussion.reply}' AND active`),
    ).toBe(0);
    // A retired Realm (and one whose graph identity was deleted) retires all its indexes.
    for (const state of ['Retired', 'deleted']) {
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:realmState rv:Active } }`);
      await stack.accessPool.query(
        `UPDATE access.feed_item SET realm_thread_indexed=false
        WHERE data_epoch=$1 AND realm=$2`,
        [epoch, realm],
      );
      await threads.historyPopulation(epoch, realm, floor);
      if (state === 'Retired') {
        await stack.accessPool.query(
          `UPDATE access.membership SET state='joined',generation=generation+1 WHERE id=$1`,
          [membership],
        );
        await stack.accessPool.query(
          `INSERT INTO access.realm_history_admission(kind,membership_id,generation,data_epoch,sequence)
          VALUES('agent',$1,5,$2,0)`,
          [membership, epoch],
        );
      }
      await catchUp();
      expect(await count('realm_thread_reference')).toBeGreaterThan(0);
      expect(await count('realm_thread_population')).toBe(1);
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:realmState ?state } }`);
      if (state !== 'deleted')
        await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:realmState rv:${state} } }`);
      else
        await stack.fuseki.update(`DELETE WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} ?predicate ?object } }`);
      await stack.accessPool.query(
        `INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource) VALUES($1,'realm',$2)
        ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key=''`,
        [epoch, realm],
      );
      await catchUp();
      expect(await count('realm_thread_reference')).toBe(0);
      expect(await count('realm_thread_order')).toBe(0);
      expect(await count('realm_thread_population')).toBe(0);
      expect(await count('realm_thread_private_order')).toBe(0);
    }
    expect(realmHistoryPopulation(floor)).toBe(population);
  } finally {
    try { await home.stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id'); }
    finally { await restored.close(); }
  }
}, 420_000);
