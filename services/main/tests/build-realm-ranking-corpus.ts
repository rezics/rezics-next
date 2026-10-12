import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { growRealmThreads } from './g-1034-fixture.ts';
import {
  REALM_RANKING_BUILD_RUN,
  REALM_RANKING_CORPUS_VERSION,
  REALM_RANKING_FILLERS,
  REALM_RANKING_SCALES,
  createRealmRankingCorpusDriver,
  readRealmRankingCorpus,
  readRealmRankingProgress,
  realmRankingBackupPath,
  realmRankingCorpusRoot,
  timeRealmRankingStage,
  writeRealmRankingManifest,
  writeRealmRankingProgress,
  type RealmRankingIdentity,
  type RealmRankingReplyIdentity,
  type RealmRankingScale,
} from './realm-ranking-corpus.ts';

const root = resolve(import.meta.dir, '../../..');
const startedAt = Date.now();

if (readRealmRankingCorpus()) {
  console.log(
    JSON.stringify({
      realmRankingCorpus: 'ready',
      directory: realmRankingCorpusRoot(),
      version: REALM_RANKING_CORPUS_VERSION,
    }),
  );
  process.exit(0);
}

process.env.REZICS_FUSEKI_MEMORY_LIMIT ??= '4g';
process.env.REZICS_POSTGRES_MEMORY_LIMIT ??= '2g';
console.log(JSON.stringify({ realmRankingCorpus: 'starting', run: REALM_RANKING_BUILD_RUN }));
const up = spawnSync(
  'bun',
  [
    'scripts/dev/cli.ts',
    'stack:up',
    '--profile',
    'qa',
    '--run-id',
    REALM_RANKING_BUILD_RUN,
    '--persistent',
  ],
  { cwd: root, encoding: 'utf8', timeout: 300_000, env: process.env },
);
if (up.status !== 0) {
  throw new Error(
    `Realm ranking build stack failed: ${(up.stderr || up.stdout || '').slice(-2000)}`,
  );
}
const apps = readEnv(
  join(
    stackDirectory(root, {
      profile: 'qa',
      runId: REALM_RANKING_BUILD_RUN,
      persistent: true,
    }),
    'apps.env',
  ),
);
Object.assign(process.env, apps, { REZICS_QA_RUN_ID: REALM_RANKING_BUILD_RUN });
const { Client } = await import('pg');
const probe = new Client({ connectionString: apps.ACCESS_DATABASE_URL });
await probe.connect();
const migrated = await probe.query<{ ready: boolean }>(
  `SELECT to_regclass('access.recovery_fence') IS NOT NULL AS ready`,
);
await probe.end();
if (!migrated.rows[0]?.ready) {
  const { stageQaBootstrap } = await import('../../../scripts/qa/bootstrap.ts');
  const staged = stageQaBootstrap(
    stackDirectory(root, {
      profile: 'qa',
      runId: REALM_RANKING_BUILD_RUN,
      persistent: true,
    }),
  );
  const boot = spawnSync('bun', staged.args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, ...staged.apps },
  });
  if (boot.status !== 0) {
    throw new Error(
      `Realm ranking build bootstrap failed: ${(boot.stderr || boot.stdout || '').slice(-2000)}`,
    );
  }
}
console.log(
  JSON.stringify({ realmRankingCorpus: 'bootstrapped', elapsedMs: Date.now() - startedAt }),
);

const { startHomeStack } = await import('../../../tests/qa/integration/feed-read-support.ts');
const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
const { workProfileCorpusApi } = await import('../../../scripts/load/work-profile-corpus.ts');
const { relayContentProjectionOnce } = await import('../src/modules/content-publication/relay.ts');

const openHome = () =>
  startHomeStack(`realm-ranking-corpus-${randomUUID()}`, {
    projectionStart: 'current',
    stableMembers: true,
  });
let home = await openHome();
console.log(JSON.stringify({ realmRankingCorpus: 'home', elapsedMs: Date.now() - startedAt }));
let stack = home.stack;
let actor = '';
class RealmRankingCommandReadRestart extends Error {}
const apiFor = (current: typeof home) =>
  workProfileCorpusApi('http://main.local', current.author.token, {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const response = await current.app.handle(request);
      const key = request.headers.get('idempotency-key');
      if (!response.ok) {
        const body = (await response.clone().text()).slice(0, 2_000);
        let problem: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            problem = parsed as Record<string, unknown>;
        } catch {
          // Retain bounded non-JSON failures too.
        }
        console.log(
          JSON.stringify({
            realmRankingCommandFailure: key,
            status: response.status,
            problem,
            body,
          }),
        );
        if (response.status === 409 && problem?.code === 'read_basis_changed')
          throw new RealmRankingCommandReadRestart(`Corpus command ${key} must restart its read`);
      } else if (response.status === 200 && key?.endsWith(':identity')) {
        console.log(
          JSON.stringify({
            realmRankingCommandReplay: key,
            status: response.status,
            response: await response.clone().json(),
          }),
        );
      }
      return response;
    }) as typeof fetch,
  });
let api = apiFor(home);
const backupDriver = createRealmRankingCorpusDriver({
  sourceRunId: REALM_RANKING_BUILD_RUN,
  async quiesce(signal) {
    signal.throwIfAborted();
    await home.stop();
    return async () => {
      home = await openHome();
      stack = home.stack;
      api = apiFor(home);
    };
  },
  async smokeRead() {
    throw new Error('The corpus builder retains cuts and does not restore them');
  },
});

const project = async () =>
  timeRealmRankingStage('build-projection', async () => {
    // Retain the real Content consumer at its owner head as well as the ranking
    // consumers, so restored runs spend their budget on live assertions.
    const projection = stack.composition;
    const head = BigInt((await stack.content.ownerPosition()).sequence);
    let checkpoint = await projection.cursor.read(projection.consumer);
    for (let events = 0; BigInt(checkpoint.sequence) < head; events++) {
      if (events >= 20_000)
        throw new Error('Realm corpus Content projection exceeded its event budget');
      const event = await relayContentProjectionOnce(
        stack.env,
        projection.content,
        projection.cursor,
        projection.consumer,
      );
      if (!event) throw new Error('Realm corpus Content projection stopped before its owner head');
      checkpoint = await projection.cursor.read(projection.consumer);
    }
    for (let wave = 0; wave < 500; wave++) {
      try {
        await home.project();
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/Home (projection|relay) exceeded/.test(error.message))
          throw error;
        console.log(JSON.stringify({ projectionWave: wave }));
      }
    }
    throw new Error('Realm ranking corpus projection did not catch up');
  });

const grant = async (scope: string, action: string) => {
  await grantFixtureAuthority(stack.accessPool, {
    scope,
    requireDispatch: true,
    representations: [{ principalId: home.author.principalId, actor, action, lifetime: '8 hours' }],
    grant: { actor, action, lifetime: '8 hours', requireSelfIssuer: true },
  });
};

const command = async <T>(key: string, init: Parameters<typeof api.command>[1]) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await api.command<T>(key, init);
    } catch (error) {
      // A late native commit can move the authorization read during a replay.
      // Honor only the API's explicit restart response, retaining the same intent.
      const transient =
        error instanceof RealmRankingCommandReadRestart ||
        (error instanceof Error && /HTTP 503/.test(error.message));
      if (!transient || attempt === 7) throw error;
      console.log(
        JSON.stringify({ realmRankingRetry: key, attempt, elapsedMs: Date.now() - startedAt }),
      );
      await Bun.sleep(2_000 * (attempt + 1));
    }
  }
  throw new Error(`Realm ranking command ${key} was not admitted`);
};

// A crash between a command and its progress record must replay the same body.
const commandId = (key: string, kind: string) => {
  const hex = createHash('sha256')
    .update(`${REALM_RANKING_BUILD_RUN}:${key}:${kind}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const post = async (
  key: string,
  parent?: { reply: string; revision: string },
  target: Pick<RealmRankingIdentity, 'realm' | 'work' | 'draftRevision'> = progress!.identity,
): Promise<RealmRankingReplyIdentity> =>
  timeRealmRankingStage(
    'build-reply',
    async () => {
      const reply = `https://rezics.com/id/${commandId(key, 'reply')}`;
      const variantId = `urn:rezics:variant:${commandId(key, 'variant')}`;
      const draft = await command<{ revisionId: string; revisionDigest: string }>(`${key}:draft`, {
        method: 'POST',
        path: '/v1/member-reply-drafts',
        body: {
          profile: 'member-reply-draft-v1',
          reply,
          variantId,
          rootTarget: target.work,
          rootRevision: target.draftRevision,
          language: 'en',
          direction: 'ltr',
          expectedHead: null,
          body: `${key}\nDiscuss the book`,
          actingSubject: actor,
        },
      });
      await command(`${key}:identity`, {
        method: 'POST',
        path: '/v1/realm-replies',
        body: {
          profile: 'realm-reply-identity-v1',
          reply,
          variantId,
          revisionId: draft.revisionId,
          author: actor,
          rootTarget: target.work,
          rootRevision: target.draftRevision,
          parentReply: parent?.reply ?? null,
          parentRevision: parent?.revision ?? null,
          contextRevision: null,
        },
      });
      const review = await command<{ decisionId: string }>(`${key}:review`, {
        method: 'POST',
        path: '/v1/realm-reply-reviews',
        body: {
          profile: 'realm-reply-review-v1',
          realm: target.realm,
          reply,
          revisionId: draft.revisionId,
          revisionDigest: draft.revisionDigest,
          expectedGeneration: '0',
          supersedes: null,
          outcome: 'approved',
          method: 'human',
          methodRevision: 'realm-ranking-v1',
          dependencyDigest: 'a'.repeat(64),
          reasonReference: null,
          actingSubject: actor,
        },
      });
      const placed = await command<{ placement: string }>(`${key}:place`, {
        method: 'POST',
        path: '/v1/realm-reply-placements',
        body: {
          profile: 'realm-reply-placement-v1',
          realm: target.realm,
          reply,
          revisionId: draft.revisionId,
          revisionDigest: draft.revisionDigest,
          reviewDecisionId: review.decisionId,
          expectedHead: null,
          actingSubject: actor,
        },
      });
      return {
        reply,
        revision: draft.revisionId,
        placement: placed.placement,
        digest: draft.revisionDigest,
        review: review.decisionId,
      };
    },
    { key },
  );

let progress = readRealmRankingProgress();
const savedFillers = async () =>
  Number(
    (
      await stack.contentPool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM content.reply WHERE root_target=$1 AND parent_reply IS NULL',
        [progress!.identity.work],
      )
    ).rows[0]?.count ?? '0',
  ) - 2;

const emptyReply = (): RealmRankingReplyIdentity => ({
  reply: '',
  revision: '',
  placement: '',
  digest: '',
  review: '',
});
let built = false;
try {
  if (!progress) {
    if (REALM_RANKING_SCALES.some((size) => existsSync(realmRankingBackupPath(size))))
      throw new Error(
        'Retained Realm ranking cuts have no matching source progress; rebuild every cut together',
      );
    const provision = async (token: string, key: string, name: string) =>
      (
        await workProfileCorpusApi('http://main.local', token, {
          fetch: ((input, init) => home.app.handle(new Request(input, init))) as typeof fetch,
        }).command<{ agent: string }>(key, {
          method: 'POST',
          path: '/v1/agents',
          body: { profile: 'agent-provision-v1', kind: 'person', displayName: name },
        })
      ).agent;
    actor = await provision(home.author.token, 'realm-rank:author', 'Rank author');
    const reader = await provision(home.reader.token, 'realm-rank:reader', 'Rank reader');
    await stack.accessPool.query('SELECT access.seed_platform_grants($1,$2)', [
      home.author.principalId,
      `urn:rezics:access-receipt:${'a'.repeat(64)}`,
    ]);
    const realm = (
      await api.command<{ realm: string }>('realm-rank:realm', {
        method: 'POST',
        path: '/v1/spaces',
        body: {
          profile: 'space-realm-v1',
          name: 'Rank community',
          capabilities: ['realm'],
          actingSubject: actor,
        },
      })
    ).realm;
    for (const [scope, action] of [
      [`review:decide:${realm}`, 'review.decide'],
      [`reply:place:${realm}`, 'reply.place'],
      [`realm:profile:${realm}`, 'realm.profile.publish'],
      [`governance:realm:${realm}`, 'governance.rule.publish'],
    ] as const)
      await grant(scope, action);
    const work = await seedPublicProfileWork(api, 'realm-rank:work', {
      actingSubject: actor,
      title: 'Ranking root',
      body: 'Public root',
    });
    progress = {
      startedAt,
      fillers: 0,
      identity: {
        dataEpoch: stack.env.lineage.dataEpoch,
        routingEpoch: stack.env.lineage.routingEpoch,
        realm,
        author: actor,
        reader,
        work: work.work,
        draftRevision: work.draftRevision,
        opening: emptyReply(),
        second: emptyReply(),
        deepChain: [],
        followups: null,
        winner: { reply: '', placement: '' },
      },
    };
    writeRealmRankingProgress(progress);
  }
  actor = progress!.identity.author;
  const identity: RealmRankingIdentity = progress.identity;
  if (identity.dataEpoch !== stack.env.lineage.dataEpoch)
    throw new Error(
      'Realm ranking progress belongs to a different source lineage; rebuild every cut together',
    );
  for (const [scope, action] of [
    [`review:decide:${identity.realm}`, 'review.decide'],
    [`reply:place:${identity.realm}`, 'reply.place'],
    [`realm:profile:${identity.realm}`, 'realm.profile.publish'],
    [`governance:realm:${identity.realm}`, 'governance.rule.publish'],
  ] as const)
    await grant(scope, action);
  if (!identity.opening.reply) {
    identity.opening = await post('realm-rank:opening');
    writeRealmRankingProgress(progress);
  }
  if (!identity.second.reply) {
    identity.second = await post('realm-rank:second');
    writeRealmRankingProgress(progress);
  }
  if ((await savedFillers()) < progress.fillers)
    throw new Error('Realm ranking source is missing acknowledged root replies');
  let fillers = progress.fillers;
  const buildFollowups = async () =>
    timeRealmRankingStage('build-followups', async () => {
      if (!identity.followups) {
        const realm = (
          await command<{ realm: string }>('realm-followup:realm', {
            method: 'POST',
            path: '/v1/spaces',
            body: {
              profile: 'space-realm-v1',
              name: 'Thread boundaries',
              capabilities: ['realm'],
              actingSubject: actor,
            },
          })
        ).realm;
        const work = await seedPublicProfileWork(api, 'realm-followup:work', {
          actingSubject: actor,
          title: 'Thread boundaries',
          body: 'Independent thread shapes',
        });
        identity.followups = {
          realm,
          work: work.work,
          draftRevision: work.draftRevision,
          clean: emptyReply(),
          chainRoot: emptyReply(),
          chain: [],
          wideRoot: emptyReply(),
          wide: [],
        };
        writeRealmRankingProgress(progress!);
      }
      const followups = identity.followups;
      for (const [scope, action] of [
        [`review:decide:${followups.realm}`, 'review.decide'],
        [`reply:place:${followups.realm}`, 'reply.place'],
        [`governance:realm:${followups.realm}`, 'governance.rule.publish'],
        [`governance:realm:${followups.realm}`, 'realm.owner'],
      ] as const)
        await grant(scope, action);
      for (const name of ['clean', 'chainRoot', 'wideRoot'] as const) {
        if (!followups[name].reply) {
          followups[name] = await post(`realm-followup:${name}`, undefined, followups);
          writeRealmRankingProgress(progress!);
        }
      }
      while (followups.chain.length < 34) {
        const parent = followups.chain.at(-1) ?? followups.chainRoot;
        followups.chain.push(
          await post(`realm-followup:chain:${followups.chain.length}`, parent, followups),
        );
        writeRealmRankingProgress(progress!);
      }
      while (followups.wide.length < 193) {
        followups.wide.push(
          await post(`realm-followup:wide:${followups.wide.length}`, followups.wideRoot, followups),
        );
        writeRealmRankingProgress(progress!);
      }
    });
  const buildDeepChain = async () =>
    timeRealmRankingStage('build-deep-chain', async () => {
      while (identity.deepChain.length < 40) {
        const parent = identity.deepChain.at(-1) ?? identity.second;
        identity.deepChain.push(await post(`realm-rank:deep:${identity.deepChain.length}`, parent));
        writeRealmRankingProgress(progress!);
      }
    });
  const vote = async (key: string, placement: string) =>
    api.command(key, {
      method: 'POST',
      path: `/v1/feed/${placement.slice(-36)}/vote`,
      body: {
        profile: 'feed-vote-command-v1',
        actingSubject: actor,
        value: 1,
        expectedRevision: null,
      },
    });
  const retainThrough = async (size: RealmRankingScale) => {
    const needed = size - 2;
    if (fillers < needed) {
      await growRealmThreads(
        async (key) => {
          const reply = await post(key);
          progress!.fillers = ++fillers;
          writeRealmRankingProgress(progress!);
          return reply;
        },
        needed - fillers,
        {
          keyPrefix: 'realm-rank:fill',
          startIndex: fillers,
        },
      );
    }
    if (size === 400) await buildFollowups();
    if (size === 1600) await buildDeepChain();
    await project();
    const roots = Number(
      (
        await stack.accessPool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM access.realm_thread_reference
         WHERE data_epoch=$1 AND realm=$2 AND parent IS NULL`,
          [identity.dataEpoch, identity.realm],
        )
      ).rows[0]?.count ?? '0',
    );
    if (roots !== size) throw new Error(`Realm ranking cut ${size} has ${roots} placed roots`);
    if (size === 100 && !identity.winner.reply) {
      const row = (
        await stack.accessPool.query<{ reply: string; placement: string }>(
          `SELECT reply, placement FROM access.realm_thread_reference
         WHERE data_epoch=$1 AND realm=$2 AND parent IS NULL
         ORDER BY occurred_at ASC OFFSET 2 LIMIT 1`,
          [identity.dataEpoch, identity.realm],
        )
      ).rows[0];
      if (!row) throw new Error('Realm ranking corpus has no third root to score');
      identity.winner = row;
      progress!.identity = identity;
    }
    if (size === 100 && identity.winner.placement && !progress!.voted) {
      await vote('realm-rank:score:winner', identity.winner.placement);
      await vote('realm-rank:score:opening', identity.opening.placement);
      progress!.voted = true;
      progress!.identity = identity;
      writeRealmRankingProgress(progress!);
      await project();
    }
    const cutStarted = Date.now();
    await timeRealmRankingStage(
      'retain-cut',
      () => backupDriver.backup(String(size), AbortSignal.timeout(600_000)),
      { threads: size },
    );
    console.log(
      JSON.stringify({
        realmRankingCut: size,
        fillers,
        retainMs: Date.now() - cutStarted,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  };
  for (const size of REALM_RANKING_SCALES) {
    if (existsSync(realmRankingBackupPath(size))) {
      fillers = Math.max(fillers, size - 2);
      continue;
    }
    await retainThrough(size);
  }
  writeRealmRankingManifest({
    format: 'realm-ranking-corpus-v1',
    version: REALM_RANKING_CORPUS_VERSION,
    compatibility: loadCompatibility(root),
    preparationMs: Date.now() - (progress.startedAt || startedAt),
    fillers: REALM_RANKING_FILLERS,
    identity,
    scales: [...REALM_RANKING_SCALES],
  });
  console.log(
    JSON.stringify({
      realmRankingCorpus: 'built',
      directory: realmRankingCorpusRoot(),
      preparationMs: Date.now() - (progress.startedAt || startedAt),
      fillers,
    }),
  );
  built = true;
} finally {
  await home.stop();
  if (built) {
    spawnSync(
      'bun',
      [
        'scripts/dev/cli.ts',
        'stack:down',
        '--profile',
        'qa',
        '--run-id',
        REALM_RANKING_BUILD_RUN,
        '--persistent',
      ],
      { cwd: root, encoding: 'utf8', timeout: 180_000, env: process.env },
    );
  }
}
