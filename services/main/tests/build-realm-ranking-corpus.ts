import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
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

const openHome = () =>
  startHomeStack(`realm-ranking-corpus-${randomUUID()}`, {
    projectionStart: 'current',
    stableMembers: true,
  });
let home = await openHome();
console.log(JSON.stringify({ realmRankingCorpus: 'home', elapsedMs: Date.now() - startedAt }));
let stack = home.stack;
let actor = '';
const apiFor = (current: typeof home) =>
  workProfileCorpusApi('http://main.local', current.author.token, {
    fetch: ((input, init) => current.app.handle(new Request(input, init))) as typeof fetch,
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
  await stack.accessPool.query(
    'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
    [scope],
  );
  await stack.accessPool.query(
    `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
     VALUES($1,$2,$3,$4,now()+interval '24 hours')`,
    [randomUUID(), home.author.principalId, actor, action],
  );
  await stack.accessPool.query(
    `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
     VALUES($1,$2,$2,$3,$4,now()+interval '24 hours')`,
    [randomUUID(), actor, scope, action],
  );
};

const command = async <T>(key: string, init: Parameters<typeof api.command>[1]) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await api.command<T>(key, init);
    } catch (error) {
      const transient = error instanceof Error && /HTTP 503/.test(error.message);
      if (!transient || attempt === 7) throw error;
      console.log(
        JSON.stringify({ realmRankingRetry: key, attempt, elapsedMs: Date.now() - startedAt }),
      );
      await Bun.sleep(2_000 * (attempt + 1));
    }
  }
  throw new Error(`Realm ranking command ${key} was not admitted`);
};

const post = async (key: string, parent?: { reply: string; revision: string }) =>
  timeRealmRankingStage(
    'build-reply',
    async () => {
      const reply = `https://rezics.com/id/${randomUUID()}`;
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await command<{ revisionId: string; revisionDigest: string }>(`${key}:draft`, {
        method: 'POST',
        path: '/v1/member-reply-drafts',
        body: {
          profile: 'member-reply-draft-v1',
          reply,
          variantId,
          rootTarget: progress!.identity.work,
          rootRevision: progress!.identity.draftRevision,
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
          rootTarget: progress!.identity.work,
          rootRevision: progress!.identity.draftRevision,
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
          realm: progress!.identity.realm,
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
          realm: progress!.identity.realm,
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
        'SELECT count(*)::text AS count FROM content.reply WHERE root_target=$1',
        [progress!.identity.work],
      )
    ).rows[0]?.count ?? '0',
  ) - 2;

let built = false;
try {
  if (!progress || (await savedFillers().catch(() => -1)) < 0) {
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
        opening: { reply: '', revision: '', placement: '', digest: '', review: '' },
        winner: { reply: '', placement: '' },
      },
    };
    const opening = await post('realm-rank:opening');
    await post('realm-rank:second');
    progress.identity.opening = opening;
    writeRealmRankingProgress(progress);
    console.log(JSON.stringify({ realmRankingCorpus: 'roots', elapsedMs: Date.now() - startedAt }));
  }
  actor = progress!.identity.author;
  const identity: RealmRankingIdentity = progress.identity;
  let fillers = Math.max(0, await savedFillers());
  progress.fillers = fillers;
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
      const grown = await growRealmThreads(post, needed - fillers, {
        keyPrefix: 'realm-rank:fill',
        startIndex: fillers,
      });
      fillers += grown.length;
      progress!.fillers = fillers;
      writeRealmRankingProgress(progress!);
    }
    await project();
    // A refused review can leave a Content reply that never becomes a root.
    // Replace it so the cut still has exactly this many placed threads.
    let extra = 0;
    for (;;) {
      const roots = Number(
        (
          await stack.accessPool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM access.realm_thread_reference
         WHERE data_epoch=$1 AND realm=$2 AND parent IS NULL`,
            [identity.dataEpoch, identity.realm],
          )
        ).rows[0]?.count ?? '0',
      );
      if (roots >= size) break;
      if (extra >= 32) throw new Error(`Realm ranking cut ${size} has ${roots} roots`);
      const missing = size - roots;
      await growRealmThreads(post, missing, { keyPrefix: 'realm-rank:extra', startIndex: extra });
      extra += missing;
      await project();
    }
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
