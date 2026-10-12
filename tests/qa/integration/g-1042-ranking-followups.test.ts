import { expect, test as bunTest } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { meterStatements } from './feed-read-support.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import {
  retireRealmPopulation,
  REALM_RETIREMENT_COST,
} from '../../../services/main/src/modules/rankings/retirement.ts';
import { realmHistoryPopulation } from '../../../services/main/src/modules/rankings/realm-threads.ts';
import { REALM_THREAD_COST } from '../../../services/main/src/modules/realm-reply/thread-contract.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import {
  restoreRealmRankingCorpus,
  timeRealmRankingStage,
} from '../../../services/main/tests/realm-ranking-corpus.ts';

// Bun calls its pending-case marker todo; keep this adapter local to the file.
const test = Object.assign(bunTest.bind(null), { fixme: bunTest.todo });

test('G1042: depth, row and ancestor caps report partial results; retired cuts and reply tombstones drain through invalidation', async () => {
  const restoreStarted = performance.now();
  const restored = await restoreRealmRankingCorpus(400);
  const home = restored.home;
  try {
    const { stack } = home;
    const restoreReadyMs = Math.round(
      Math.max(restored.elapsedMs, performance.now() - restoreStarted),
    );
    if (restoreReadyMs >= 600_000)
      throw new Error(
        `Realm ranking corpus restore, startup and readiness took ${restoreReadyMs} ms`,
      );
    console.log(
      JSON.stringify({ realmRankingFollowupRestoreReadyMs: restoreReadyMs, threads: 400 }),
    );
    const followups = restored.manifest.identity.followups;
    if (!followups) throw new Error('Retained Realm ranking corpus has no followup topology');
    const { realm, clean, chainRoot, chain, wideRoot } = followups;
    expect(chain).toHaveLength(34);
    expect(followups.wide).toHaveLength(193);
    const projection = stack.composition;
    const head = await stack.content.ownerPosition();
    const checkpoint = await projection.cursor.read(projection.consumer);
    expect(checkpoint.dataEpoch).toBe(head.dataEpoch);
    expect(BigInt(checkpoint.sequence)).toBe(BigInt(head.sequence));
    // A few hundred product replies exceed one 400-batch relay pass. Resume the
    // same checkpoint instead of treating that bound as a failed population.
    const catchUp = async () =>
      timeRealmRankingStage('followup-projection', async () => {
        for (let wave = 0; wave < 8; wave++) {
          try {
            await home.project();
            return;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/Home (projection|relay) exceeded/.test(error.message)
            )
              throw error;
          }
        }
        throw new Error('Realm thread projection exceeded its resumable waves');
      });
    const epoch = stack.env.lineage.dataEpoch;
    const threads = home.deps.realmReplyThreads;
    const root = `/v1/realms/${realm.slice(-36)}`;
    const readThread = async (reply: string) =>
      timeRealmRankingStage(
        'followup-read',
        async () =>
          home.json<{ complete: boolean; items: unknown[]; ancestors: unknown[] }>(
            await home.call('GET', `${root}/threads/${reply.slice(-36)}`),
          ),
        { reply },
      );
    expect((await readThread(clean.reply)).complete).toBe(true);
    await timeRealmRankingStage('followup-boundaries', async () => {
      // The bounded Content walk has far fewer than 192 rows but crosses depth 32.
      const subtree = await threads.subtree(chainRoot.reply);
      expect(subtree.length).toBeLessThan(REALM_THREAD_COST.replies);
      expect(subtree.some((node) => node.truncated)).toBe(true);
      expect((await threads.counts(realm, [chainRoot.reply])).complete).toBe(false);
      expect((await readThread(chainRoot.reply)).complete).toBe(false);
      const deep = await readThread(chain.at(-1)!.reply);
      expect(deep.ancestors).toHaveLength(REALM_THREAD_COST.ancestors);
      expect(deep.complete).toBe(false);
      // Exactly 32 descendants with no child past the boundary is still complete.
      expect((await readThread(chain[1]!.reply)).complete).toBe(true);
      const page = await home.json<{
        items: { reply: string; replies: { kind: string; value: number } }[];
      }>(await home.call('GET', `${root}/threads?sort=new&window=all&limit=20`));
      expect(page.items.find((item) => item.reply === chainRoot.reply)?.replies.kind).toBe(
        'lower-bound',
      );

      // A broad thread hits the total-row cap independently of the depth cap.
      const wide = await threads.subtree(wideRoot.reply);
      expect(wide).toHaveLength(REALM_THREAD_COST.replies + 2);
      expect(wide.some((node) => node.truncated)).toBe(false);
      expect((await threads.counts(realm, [wideRoot.reply])).complete).toBe(false);
      expect((await readThread(wideRoot.reply)).complete).toBe(false);
      await stack.accessPool.query(
        `UPDATE access.feed_item SET realm_thread_indexed=false
      WHERE data_epoch=$1 AND realm=$2`,
        [epoch, realm],
      );
      await catchUp();
    });

    const floor = { dataEpoch: epoch, sequence: '0' };
    await new AccessRealmManagement(stack.accessPool).initialize(
      { ...home.author.principal, emailVerified: true },
      realm,
      restored.manifest.identity.author,
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
      [
        membership,
        realm,
        restored.manifest.identity.reader,
        policy.revision,
        policy.terms_revision,
      ],
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
    const population = await timeRealmRankingStage('followup-history', () =>
      threads.historyPopulation(epoch, realm, floor),
    );
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
    const meter = meterStatements(),
      queries = stack.fuseki.queries;
    try {
      await timeRealmRankingStage('followup-retirement', () =>
        retireRealmPopulation(stack.accessPool, session, epoch, realm, ''),
      );
      expect(meter.count()).toBeLessThanOrEqual(REALM_RETIREMENT_COST.postgresStatements);
      expect(stack.fuseki.queries - queries).toBeLessThanOrEqual(REALM_RETIREMENT_COST.graphReads);
    } finally {
      meter.restore();
    }
    expect(before - (await count('realm_thread_population_admission'))).toBe(
      REALM_RETIREMENT_COST.admissions,
    );
    expect(await count('realm_thread_population', 'AND ready')).toBe(0);
    // Retiring a private history cut does not stall the shared public order.
    expect((await home.call('GET', `${root}/threads?sort=best&window=all&limit=2`)).status).toBe(
      200,
    );
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

    // A newly placed reference queues its exact key for every live history cut.
    // Stop the real worker after that insert, before it can consume the job.
    const actor = restored.manifest.identity.author;
    for (const [scope, action] of [
      [`review:decide:${realm}`, 'review.decide'],
      [`reply:place:${realm}`, 'reply.place'],
    ] as const) {
      await grantFixtureAuthority(stack.accessPool, {
        scope,
        requireDispatch: true,
        representations: [
          { principalId: home.author.principalId, actor, action, lifetime: '8 hours' },
        ],
        grant: { actor, action, lifetime: '8 hours' },
      });
    }
    const pendingReply = `https://rezics.com/id/${randomUUID()}`;
    const pendingVariant = `urn:rezics:variant:${randomUUID()}`;
    const pendingDraftInput = {
      profile: 'member-reply-draft-v1',
      reply: pendingReply,
      variantId: pendingVariant,
      rootTarget: followups.work,
      rootRevision: followups.draftRevision,
      language: 'en',
      direction: 'ltr',
      expectedHead: null,
      body: 'A reply whose pending history admission must drain after deletion',
      actingSubject: actor,
    };
    const pendingDraft = await timeRealmRankingStage('followup-history-job-draft', async () =>
      home.json<{ revisionId: string; revisionDigest: string }>(
        await home.call('POST', '/v1/member-reply-drafts', pendingDraftInput, home.author.token),
        201,
      ),
    );
    await timeRealmRankingStage('followup-history-job-identity', async () =>
      home.json(
        await home.call(
          'POST',
          '/v1/realm-replies',
          {
            profile: 'realm-reply-identity-v1',
            reply: pendingReply,
            variantId: pendingVariant,
            revisionId: pendingDraft.revisionId,
            author: actor,
            rootTarget: followups.work,
            rootRevision: followups.draftRevision,
            parentReply: null,
            parentRevision: null,
            contextRevision: null,
          },
          home.author.token,
        ),
        201,
      ),
    );
    const pendingReview = await timeRealmRankingStage('followup-history-job-review', async () =>
      home.json<{ decisionId: string }>(
        await home.call(
          'POST',
          '/v1/realm-reply-reviews',
          {
            profile: 'realm-reply-review-v1',
            realm,
            reply: pendingReply,
            revisionId: pendingDraft.revisionId,
            revisionDigest: pendingDraft.revisionDigest,
            expectedGeneration: '0',
            supersedes: null,
            outcome: 'approved',
            method: 'human',
            methodRevision: 'realm-ranking-v1',
            dependencyDigest: 'a'.repeat(64),
            reasonReference: null,
            actingSubject: actor,
          },
          home.author.token,
        ),
        201,
      ),
    );
    await timeRealmRankingStage('followup-history-job-placement', async () =>
      home.json(
        await home.call(
          'POST',
          '/v1/realm-reply-placements',
          {
            profile: 'realm-reply-placement-v1',
            realm,
            reply: pendingReply,
            revisionId: pendingDraft.revisionId,
            revisionDigest: pendingDraft.revisionDigest,
            reviewDecisionId: pendingReview.decisionId,
            expectedHead: null,
            actingSubject: actor,
          },
          home.author.token,
        ),
        201,
      ),
    );
    const pendingJobs = () => count('realm_thread_population_job', `AND reply='${pendingReply}'`);
    expect(await pendingJobs()).toBe(0);
    await timeRealmRankingStage('followup-history-job-enqueue', async () => {
      await home.projectRelay();
      const worker = new FeedRefreshWorker(home.deps, new FeedStore(stack.accessPool), home.relay);
      for (let wave = 0; wave < 400; wave++) {
        await worker.tick();
        if ((await pendingJobs()) > 0) return;
      }
      throw new Error('Product reply did not queue an exact-key history admission job');
    });
    expect(await pendingJobs()).toBe(1);
    expect(await count('realm_thread_reference', `AND reply='${pendingReply}' AND active`)).toBe(1);
    const pendingTombstone = await timeRealmRankingStage(
      'followup-history-job-deletion',
      async () =>
        home.json<{ deleted: boolean }>(
          await home.call(
            'POST',
            '/v1/member-reply-drafts',
            {
              ...pendingDraftInput,
              expectedHead: pendingDraft.revisionId,
              body: null,
            },
            home.author.token,
          ),
          201,
        ),
    );
    expect(pendingTombstone.deleted).toBe(true);
    expect(await pendingJobs()).toBe(1);
    await catchUp();
    expect(await pendingJobs()).toBe(0);
    expect(await count('realm_thread_reference', `AND reply='${pendingReply}' AND active`)).toBe(0);
    expect(await count('realm_thread_order', `AND reply='${pendingReply}'`)).toBe(0);
    expect(await count('realm_thread_private_order', `AND reply='${pendingReply}'`)).toBe(0);
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

    type RankedItem = { reply: string; replies: { kind: string; value: number } };
    type RankedPage = { items: RankedItem[]; nextCursor: string | null };
    const rankings = new Map<'best' | 'top', { before: RankedPage; cursor: string }>();
    const readRanking = async (sort: 'best' | 'top', cursor?: string, limit = 20) =>
      timeRealmRankingStage(
        'followup-ranking',
        async () => {
          const query = new URLSearchParams({ sort, window: 'all', limit: String(limit) });
          if (cursor) query.set('cursor', cursor);
          return home.json<RankedPage>(await home.call('GET', `${root}/threads?${query}`));
        },
        { sort },
      );
    const assertRemainingCounts = (items: RankedItem[]) => {
      for (const item of items) {
        if (item.reply === clean.reply) {
          expect(item.replies.value).toBe(0);
        } else {
          expect(item.reply).toBe(wideRoot.reply);
          expect(item.replies.kind).toBe('lower-bound');
          expect(item.replies.value).toBeGreaterThan(0);
          expect(item.replies.value).toBeLessThanOrEqual(followups.wide.length);
        }
      }
    };
    for (const sort of ['best', 'top'] as const) {
      const before = await readRanking(sort);
      expect(before.items.map((item) => item.reply).sort()).toEqual(
        [clean.reply, chainRoot.reply, wideRoot.reply].sort(),
      );
      const first = await readRanking(sort, undefined, 1);
      expect(first.nextCursor).toBeString();
      rankings.set(sort, { before, cursor: first.nextCursor! });
    }
    // The author command writes an immutable Content tombstone. Its outbox
    // invalidates the ranking and descendants without a graph update fixture.
    const memberPath = `/v1/member-replies/${chainRoot.reply.slice(-36)}`;
    const existing = await home.json<{
      variantId: string;
      revisionId: string;
      rootTarget: string;
      rootRevision: string;
      author: string;
    }>(await home.call('GET', memberPath));
    expect(existing.revisionId).toBe(chainRoot.revision);
    expect(existing.author).toBe(restored.manifest.identity.author);
    const tombstone = await timeRealmRankingStage('followup-reply-deletion', async () =>
      home.json<{ deleted: boolean; predecessor: string }>(
        await home.call(
          'POST',
          '/v1/member-reply-drafts',
          {
            profile: 'member-reply-draft-v1',
            reply: chainRoot.reply,
            variantId: existing.variantId,
            rootTarget: existing.rootTarget,
            rootRevision: existing.rootRevision,
            language: 'en',
            direction: 'ltr',
            expectedHead: existing.revisionId,
            body: null,
            actingSubject: existing.author,
          },
          home.author.token,
        ),
        201,
      ),
    );
    expect(tombstone).toMatchObject({ deleted: true, predecessor: chainRoot.revision });
    await catchUp();
    expect((await home.call('GET', memberPath)).status).toBe(404);
    expect((await home.call('GET', `${root}/threads/${chainRoot.reply.slice(-36)}`)).status).toBe(
      404,
    );
    // Historical placement references remain; none may be actively ranked.
    expect(await count('realm_thread_reference', `AND reply='${chainRoot.reply}' AND active`)).toBe(
      0,
    );
    expect(await count('realm_thread_order', `AND reply='${chainRoot.reply}'`)).toBe(0);
    expect(
      await count('realm_thread_reference', `AND parent='${chainRoot.reply}' AND active`),
    ).toBe(0);
    expect(
      Number(
        (
          await stack.accessPool.query<{ count: string }>(
            `SELECT count(*)::text FROM access.realm_thread_reference
       WHERE data_epoch=$1 AND realm=$2 AND reply=ANY($3::text[]) AND active`,
            [epoch, realm, chain.map((reply) => reply.reply)],
          )
        ).rows[0]!.count,
      ),
    ).toBe(0);
    for (const [sort, { before, cursor }] of rankings) {
      const stale = await home.json<{ code: string }>(
        await home.call(
          'GET',
          `${root}/threads?${new URLSearchParams({ sort, window: 'all', limit: '1', cursor })}`,
        ),
        409,
      );
      expect(stale.code).toBe('read_basis_changed');
      const remaining = before.items.filter((item) => item.reply !== chainRoot.reply);
      const restarted = await readRanking(sort);
      expect(restarted.items.map((item) => item.reply).sort()).toEqual(
        remaining.map((item) => item.reply).sort(),
      );
      // Counts share a bounded walk across listed roots. Removing a root changes
      // that budget, so the remaining lower bounds can change while staying valid.
      assertRemainingCounts(restarted.items);
      const reached: RankedItem[] = [];
      let next: string | undefined;
      for (let page = 0; page < 3; page++) {
        const result = await readRanking(sort, next, 1);
        reached.push(...result.items);
        if (!result.nextCursor) break;
        next = result.nextCursor;
      }
      expect(reached.map((item) => item.reply).sort()).toEqual(
        [clean.reply, wideRoot.reply].sort(),
      );
      assertRemainingCounts(reached);
    }
    expect(realmHistoryPopulation(floor)).toBe(population);
  } finally {
    try {
      await home.stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
    } finally {
      await restored.close();
    }
  }
}, 420_000);

type RestoredRealmCorpus = Awaited<ReturnType<typeof restoreRealmRankingCorpus>>;

async function assertRealmLifecycleDrain(
  command: (restored: RestoredRealmCorpus) => Promise<void>,
) {
  const restored = await restoreRealmRankingCorpus(400);
  try {
    const { home, manifest } = restored;
    const realm = manifest.identity.followups?.realm;
    if (!realm) throw new Error('Retained Realm ranking corpus has no followup topology');
    const epoch = home.stack.env.lineage.dataEpoch;
    const count = async (table: string) =>
      Number(
        (
          await home.stack.accessPool.query<{ count: string }>(
            `SELECT count(*)::text FROM access.${table} WHERE data_epoch=$1 AND realm=$2`,
            [epoch, realm],
          )
        ).rows[0]!.count,
      );
    expect(await count('realm_thread_reference')).toBeGreaterThan(0);
    expect(await count('realm_thread_order')).toBeGreaterThan(0);
    await home.deps.realmReplyThreads.historyPopulation(epoch, realm, {
      dataEpoch: epoch,
      sequence: '0',
    });
    expect(await count('realm_thread_population')).toBe(1);
    await command(restored);
    await home.project();
    for (const table of [
      'realm_thread_reference',
      'realm_thread_order',
      'realm_thread_population',
      'realm_thread_population_admission',
      'realm_thread_population_job',
      'realm_thread_private_order',
    ])
      expect(await count(table)).toBe(0);
  } finally {
    await restored.close();
  }
}

test.fixme('retired Realm invalidation drains all reference, order and population indexes', async () =>
  assertRealmLifecycleDrain(async () => {
    // Missing product Realm retirement command; Space exposes creation and reads only.
    throw new Error('Realm retirement command is unavailable');
  }));

test.fixme('deleted Realm invalidation drains all reference, order and population indexes', async () =>
  assertRealmLifecycleDrain(async () => {
    // Missing product Realm deletion command; native mutation retains canonical resource types.
    throw new Error('Realm deletion command is unavailable');
  }));
