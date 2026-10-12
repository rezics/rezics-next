import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  startTelemetry,
  flushTelemetryTraces,
  instrumentFetch,
  shutdownTelemetry,
} from '@rezics/observability/runtime';
import {
  profileRequest,
  startWorkProfileSink,
  assertWorkCost,
  type WorkProfile,
} from '../../../tests/qa/support/work-profile.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
const sink = startWorkProfileSink({ settleMs: 25, maxSpans: 500_000 });
const nativeFetch = globalThis.fetch;
startTelemetry('main', { ...process.env, ...sink.env });
const { foregroundCounted } =
  await import('../../../tests/qa/integration/support/query-cost-meter.ts');
const { default: pg } = await import('pg');
const { createMainApp } = await import('../src/app.ts');
const { GovernanceRules } = await import('../src/modules/governance/rules.ts');
const { GovernanceStore } = await import('../src/modules/governance/store.ts');
const { AccessRealmManagement } = await import('../src/modules/access/realm-management.ts');
const { workRead } = await import('../src/modules/work/read-session.ts');
const { bestKey } = await import('../src/modules/feed/ranking.ts');
const { GRAPHS, iri } = await import('../src/modules/work/activate.ts');
const { REALM_RANK_COST, realmRankSeek } = await import('../src/modules/rankings/realm-threads.ts');
const {
  explainUnavailableCorpus,
  readRealmRankingCorpus,
  restoreRealmRankingCorpus,
  REALM_RANKING_SCALES,
  timeRealmRankingStage,
  realmRankingOwnerEndpoint,
} = await import('./realm-ranking-corpus.ts');

const corpus = readRealmRankingCorpus();
if (!corpus) throw new Error(explainUnavailableCorpus());
const started = performance.now();
let restored = await restoreRealmRankingCorpus(100).catch(async (error) => {
  await shutdownTelemetry();
  await sink.stop();
  throw error;
});
let home = restored.home;
let restoreProfileFetch: (() => void) | undefined;
const instrumentRestoredFetch = () => {
  restoreProfileFetch?.();
  const startupFetch = globalThis.fetch;
  globalThis.fetch = nativeFetch;
  const origin = new URL(restored.fusekiUrl).origin;
  const undo = instrumentFetch(new Set([origin]), sink.url, new Map([[origin, 'fuseki']]));
  restoreProfileFetch = () => {
    undo();
    globalThis.fetch = startupFetch;
  };
};
// Observe physical dispatch, including callback checkouts captured by Kysely.
// No extra SQL is issued, and scheduler contexts use the fixture's shared attribution.
const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
const originalQuery = prototype.query;
let foregroundStatements = 0;
type SqlStatement = { database: string | null; statement: string | null };
let foregroundStatementList: SqlStatement[] | undefined;
prototype.query = function (this: object, ...args: unknown[]) {
  if (foregroundCounted()) {
    foregroundStatements++;
    const query = args[0];
    const text =
      typeof query === 'string'
        ? query
        : query && typeof query === 'object' && 'text' in query && typeof query.text === 'string'
          ? query.text
          : null;
    const client = this as { connectionParameters?: { database?: string } };
    foregroundStatementList?.push({
      database: client.connectionParameters?.database ?? null,
      statement: text?.replace(/\s+/g, ' ').trim() ?? null,
    });
  }
  return originalQuery.apply(this, args);
};
const profileForegroundRequest = async <T>(request: (headers: Headers) => Promise<T>) => {
  let statements = 0;
  const statementList: SqlStatement[] = [];
  const measured = await profileRequest(
    sink,
    async (headers) => {
      const before = foregroundStatements;
      const previous = foregroundStatementList;
      foregroundStatementList = statementList;
      try {
        return await request(headers);
      } finally {
        statements = foregroundStatements - before;
        foregroundStatementList = previous;
      }
    },
    { service: 'main', flush: flushTelemetryTraces },
  );
  return {
    ...measured,
    profile: { ...measured.profile, postgresStatements: statements },
    tracedPostgresStatements: measured.profile.postgresStatements,
    postgresStatementList: statementList,
  };
};
const evidence: Record<string, unknown>[] = [];
const ownerDatabases: Record<string, string> = {};
const ownerDatabaseEndpoints: Record<string, ReturnType<typeof realmRankingOwnerEndpoint>> = {};
const profiles: {
  size: number;
  operation: string;
  viewer: string;
  temperature: string;
  profile: Awaited<ReturnType<typeof profileRequest>>['profile'];
  postgresStatementList: SqlStatement[];
}[] = [];
const replyWrites: {
  size: number;
  populatedSlots: number;
  profile: WorkProfile;
  fusekiQueryCalls: number;
}[] = [];
try {
  instrumentRestoredFetch();
  let { stack } = home;
  for (const [owner, pool] of [
    ['access', stack.accessPool],
    ['content', stack.contentPool],
    ['relay', home.relay],
  ] as const) {
    assert(pool.options.connectionString, `Restored ${owner} pool has no connection string`);
    ownerDatabases[owner] = (
      await pool.query<{ database: string }>('SELECT current_database() AS database')
    ).rows[0]!.database;
    ownerDatabaseEndpoints[owner] = realmRankingOwnerEndpoint(
      pool.options.connectionString,
      ownerDatabases[owner],
    );
  }
  const rules = new GovernanceRules(stack.accessPool);
  const realmAdmin = new AccessRealmManagement(stack.accessPool);
  let app = createMainApp(stack.fuseki, {
    ...home.deps,
    realmAdmin,
    governance: {
      rules,
      store: new GovernanceStore(
        stack.accessPool,
        {
          capture: async () => {
            throw new Error('Evidence outside this test');
          },
        },
        { current: async () => null },
        rules,
      ),
    },
  });
  let api = workProfileCorpusApi('http://main.local', home.author.token, {
    fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  const project = async () =>
    timeRealmRankingStage(
      'projection',
      async () => {
        // The scale snapshot exceeds Home's small-fixture 400-tick helper bound.
        // Resume the same durable job rather than resetting/replaying any prefix.
        // Relay and ranking each stop at that bound, so a full population takes
        // several resumable waves.
        for (let wave = 0; wave < 40; wave++) {
          try {
            await home.project();
            return;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !/Home (projection|relay) exceeded/.test(error.message)
            )
              throw error;
            const pending = (
              await stack.accessPool.query(
                `SELECT kind,resource,after_key FROM access.realm_thread_dirty
        WHERE data_epoch=$1 ORDER BY kind,resource LIMIT 4`,
                [stack.env.lineage.dataEpoch],
              )
            ).rows;
            console.log(JSON.stringify({ projectionWave: wave, pending }));
            if (performance.now() - started > 550_000) throw error;
          }
        }
        throw new Error('Realm scale projection exceeded its resumable waves');
      },
      { target: restored.target },
    );
  const actor = corpus.identity.author;
  const reader = corpus.identity.reader;
  const realm = corpus.identity.realm;
  const root = `/v1/realms/${realm.slice(-36)}` as const;
  const work = { work: corpus.identity.work, draftRevision: corpus.identity.draftRevision };
  const grant = async (scope: string, action: string, subject = actor) => {
    await stack.accessPool.query(
      'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
      [scope],
    );
    await stack.accessPool.query(
      `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
      VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
      [randomUUID(), home.author.principalId, subject, action],
    );
    await stack.accessPool.query(
      `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES($1,$2,$2,$3,$4,now()+interval '1 hour')`,
      [randomUUID(), subject, scope, action],
    );
  };
  const grantRankingAuthority = async () => {
    // A retained corpus stores facts, while each live test establishes current
    // authority before measuring writes or publishing its header.
    for (const [scope, action] of [
      [`review:decide:${realm}`, 'review.decide'],
      [`reply:place:${realm}`, 'reply.place'],
      [`realm:profile:${realm}`, 'realm.profile.publish'],
      [`governance:realm:${realm}`, 'governance.rule.publish'],
    ] as const)
      await grant(scope, action);
  };
  await grantRankingAuthority();
  const post = async (
    key: string,
    parent?: { reply: string; revision: string },
    targetRealm = realm,
  ) =>
    timeRealmRankingStage(
      'reply',
      async () => {
        const reply = `https://rezics.com/id/${randomUUID()}`,
          variantId = `urn:rezics:variant:${randomUUID()}`;
        const draft = await api.command<{ revisionId: string; revisionDigest: string }>(
          `${key}:draft`,
          {
            method: 'POST',
            path: '/v1/member-reply-drafts',
            body: {
              profile: 'member-reply-draft-v1',
              reply,
              variantId,
              rootTarget: work.work,
              rootRevision: work.draftRevision,
              language: 'en',
              direction: 'ltr',
              expectedHead: null,
              body: `${key}\nDiscuss the book`,
              actingSubject: actor,
            },
          },
        );
        await api.command(`${key}:identity`, {
          method: 'POST',
          path: '/v1/realm-replies',
          body: {
            profile: 'realm-reply-identity-v1',
            reply,
            variantId,
            revisionId: draft.revisionId,
            author: actor,
            rootTarget: work.work,
            rootRevision: work.draftRevision,
            parentReply: parent?.reply ?? null,
            parentRevision: parent?.revision ?? null,
            contextRevision: null,
          },
        });
        const review = await api.command<{ decisionId: string }>(`${key}:review`, {
          method: 'POST',
          path: '/v1/realm-reply-reviews',
          body: {
            profile: 'realm-reply-review-v1',
            realm: targetRealm,
            reply,
            revisionId: draft.revisionId,
            revisionDigest: draft.revisionDigest,
            expectedGeneration: '0',
            supersedes: null,
            outcome: 'approved',
            method: 'human',
            methodRevision: 'g1034-v1',
            dependencyDigest: 'a'.repeat(64),
            reasonReference: null,
            actingSubject: actor,
          },
        });
        const placed = await api.command<{ placement: string }>(`${key}:place`, {
          method: 'POST',
          path: '/v1/realm-reply-placements',
          body: {
            profile: 'realm-reply-placement-v1',
            realm: targetRealm,
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
          placement: placed.placement,
          revision: draft.revisionId,
          variantId,
          review: review.decisionId,
          digest: draft.revisionDigest,
        };
      },
      { key, realm: targetRealm },
    );
  const opening = corpus.identity.opening;
  await timeRealmRankingStage('header-setup', async () => {
    // A newly-created Realm with no placed reply is empty under every order,
    // even when its ranking index has not caught up yet.
    const emptyRealm = (
      await api.command<{ realm: string }>('g1034:empty-realm', {
        method: 'POST',
        path: '/v1/spaces',
        body: {
          profile: 'space-realm-v1',
          name: 'Unranked',
          capabilities: ['realm'],
          actingSubject: actor,
        },
      })
    ).realm;
    const emptyPage = await app.handle(
      new Request(`http://main.local/v1/realms/${emptyRealm.slice(-36)}/threads?sort=top&limit=2`),
    );
    assert.equal(emptyPage.status, 200);
    assert.deepEqual(((await emptyPage.json()) as { items: unknown[] }).items, []);
    const allRules = Array.from({ length: 12 }, (_, index) => ({
      id: `rule-${index}`,
      title: { original: 'en', labels: { en: `Rule ${index}` } },
      body: { original: 'en', labels: { en: 'Read together' } },
      governanceRule: { ref: `urn:g1034:rule:${randomUUID()}`, revision: '1' },
    }));
    for (const rule of allRules)
      await api.command(rule.id, {
        method: 'POST',
        path: '/v1/governance/rules',
        body: {
          profile: 'governance-rule-v1',
          ref: rule.governanceRule.ref,
          scopeId: `governance:realm:${realm}`,
          actingSubject: actor,
          expectedRevision: null,
          document: { text: rule.title.labels.en },
          idempotencyKey: rule.id,
        },
      });
    const moderators: string[] = [];
    for (let index = 0; index < 16; index++) {
      const moderator = (
        await api.command<{ agent: string }>(`g1034:mod:${index}`, {
          method: 'POST',
          path: '/v1/agents',
          body: {
            profile: 'agent-provision-v1',
            kind: 'person',
            displayName: `Moderator ${index}`,
          },
        })
      ).agent;
      await grant(
        `realm:moderator-choice:${realm.slice(-36)}:${moderator.slice(-36)}`,
        'realm.moderator.choose',
        moderator,
      );
      await api.command(`g1034:choice:${index}`, {
        method: 'PUT',
        path: `${root}/moderators/${moderator.slice(-36)}/public-choice`,
        body: {
          profile: 'realm-public-moderator-choice-v1',
          expectedHead: null,
          public: true,
          actingSubject: moderator,
        },
      });
      moderators.push(moderator);
    }
    let profileHead: string | null = null;
    // Realm creation stores an empty settings rules document, and the header
    // reads that document. Advance it with the same rules the profile publishes.
    const rulesRef = `urn:rezics:realm-rules:${realm.slice(-36)}`;
    for (const count of [0, 1, 12]) {
      const currentRules = await rules.current(rulesRef, `governance:realm:${realm}`);
      await api.command(`g1034:rules-document:${count}`, {
        method: 'POST',
        path: '/v1/governance/rules',
        body: {
          profile: 'governance-rule-v1',
          ref: rulesRef,
          scopeId: `governance:realm:${realm}`,
          actingSubject: actor,
          expectedRevision: currentRules?.revision ?? null,
          document: {
            profile: 'realm-settings-rules-v2',
            public: true,
            rules: allRules.slice(0, count),
          },
          idempotencyKey: `g1034:rules-document:${count}`,
        },
      });
      const published: { revision: string } = await api.command<{ revision: string }>(
        `g1034:profile:${count}`,
        {
          method: 'PUT',
          path: `${root}/profile`,
          body: {
            profile: 'realm-public-profile-v2',
            expectedHead: profileHead,
            actingSubject: actor,
            publication: {
              name: { original: 'en', labels: { en: 'Rank community' } },
              description: { original: 'en', labels: { en: 'Read together' } },
              rules: allRules.slice(0, count),
              moderators: moderators.slice(0, count === 12 ? 16 : count),
              iconSelection: null,
              bannerSelection: null,
              count: { kind: 'exact', value: null },
            },
          },
        },
      );
      profileHead = published.revision;
      for (const viewer of ['anonymous', 'member']) {
        sink.clear();
        const measured = await timeRealmRankingStage(
          'header-read',
          () =>
            profileForegroundRequest(async (headers) => {
              if (viewer === 'member') headers.set('authorization', `Bearer ${home.reader.token}`);
              const response = await app.handle(
                new Request(
                  `http://main.local${root}${viewer === 'member' ? `?actingSubject=${encodeURIComponent(reader)}` : ''}`,
                  { headers },
                ),
              );
              const body = (await response.json()) as {
                rules: unknown[];
                moderators: { items: string[] };
              };
              assert.equal(response.status, 200, JSON.stringify(body));
              assert.equal(body.rules.length, count);
              assert.equal(body.moderators.items.length, count === 12 ? 16 : count);
            }),
          { rules: count, viewer },
        );
        assertWorkCost(measured.profile, {
          postgresStatements:
            viewer === 'anonymous'
              ? REALM_RANK_COST.headerAnonymousStatements
              : REALM_RANK_COST.headerMemberStatements,
        });
        evidence.push({
          operation: 'header',
          rules: count,
          moderators: count === 12 ? 16 : count,
          viewer,
          profile: measured.profile,
        });
      }
    }
    await project();
  });
  const epoch = corpus.identity.dataEpoch;
  await timeRealmRankingStage('private-admission', async () => {
    // A real private membership episode: older posts precede its immutable cut.
    // The cut's admitted-score index is built once, then votes/replies mirror it.
    const privateCreated = await api.command<{ realm: string; space: string }>('g1034:private', {
      method: 'POST',
      path: '/v1/spaces',
      body: {
        profile: 'space-realm-v1',
        name: 'Private ranking',
        capabilities: ['realm'],
        actingSubject: actor,
      },
    });
    const privateRealm = privateCreated.realm;
    for (const [scope, action] of [
      [`review:decide:${privateRealm}`, 'review.decide'],
      [`reply:place:${privateRealm}`, 'reply.place'],
      [`governance:realm:${privateRealm}`, 'governance.rule.publish'],
      [`governance:realm:${privateRealm}`, 'realm.owner'],
    ] as const)
      await grant(scope, action);
    await api.command('g1034:private:manage', {
      method: 'POST',
      path: `/v1/realms/${privateRealm.slice(-36)}/management`,
      body: { actingSubject: actor },
    });
    const prior = await post('g1034:before-admission', undefined, privateRealm);
    const floor = await workRead(
      home.deps,
      new Request('http://main.internal/private-cut'),
      {},
      (session) => Promise.resolve(session.position),
    );
    const privateRoot = `/v1/realms/${privateRealm.slice(-36)}` as const;
    const privateSettingsPath = `/v1/spaces/${privateCreated.space.slice(-36)}/settings` as const;
    const settings = await api.read<Awaited<ReturnType<typeof realmAdmin.spaceSettings>>>(
      `${privateSettingsPath}?actingSubject=${encodeURIComponent(actor)}`,
    );
    await api.command('g1034:private:settings', {
      method: 'PUT',
      path: privateSettingsPath,
      body: {
        actingSubject: actor,
        expectedGeneration: settings.generation,
        reason: 'Exercise admission history',
        settings: { ...settings.settings, visibility: 'private', history: 'from-admission' },
      },
    });
    await stack.accessPool.query(
      `INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision)
    VALUES('realm',$1,1,'g1034-terms') ON CONFLICT DO NOTHING`,
      [privateRealm],
    );
    const membershipPolicy = (
      await stack.accessPool.query<{ revision: string; terms_revision: string }>(
        `SELECT revision::text,terms_revision FROM access.membership_policy WHERE kind='realm' AND owner_subject=$1`,
        [privateRealm],
      )
    ).rows[0]!;
    const consent = randomUUID(),
      membership = randomUUID();
    await stack.accessPool.query(
      `INSERT INTO access.private_membership_consent(id,principal_id,principal_epoch,kind,
    owner_subject,policy_revision,terms_revision,next_generation,expires_at)
    SELECT $1,id,enforcement_epoch,'realm',$3,$4::bigint,$5,1,now()+interval '5 minutes' FROM access.principal WHERE id=$2`,
      [
        consent,
        home.reader.principalId,
        privateRealm,
        membershipPolicy.revision,
        membershipPolicy.terms_revision,
      ],
    );
    await stack.accessPool.query(
      `INSERT INTO access.private_membership(id,kind,owner_subject,principal_id,state,generation,
    policy_revision,terms_revision,consent_reference) VALUES($1,'realm',$2,$3,'joined',1,$5::bigint,$6,$4)`,
      [
        membership,
        privateRealm,
        home.reader.principalId,
        consent,
        membershipPolicy.revision,
        membershipPolicy.terms_revision,
      ],
    );
    await stack.accessPool.query(
      `INSERT INTO access.realm_history_admission(kind,membership_id,generation,data_epoch,sequence)
    VALUES('private',$1,1,$2,$3)`,
      [membership, floor.dataEpoch, floor.sequence],
    );
    const later = await post('g1034:after-admission', undefined, privateRealm);
    await project();
    const privateRequest = () =>
      new Request(
        `http://main.local${privateRoot}/threads?sort=top&window=all&limit=2&actingSubject=${encodeURIComponent(reader)}`,
        { headers: { authorization: `Bearer ${home.reader.token}` } },
      );
    assert.equal(
      (await app.handle(privateRequest())).status,
      503,
      'An incomplete private cut must not return a recent sample',
    );
    await project();
    const privatePage = await app.handle(privateRequest());
    assert.equal(privatePage.status, 200, await privatePage.clone().text());
    assert.deepEqual(
      ((await privatePage.json()) as { items: { reply: string }[] }).items.map(
        (item) => item.reply,
      ),
      [later.reply],
    );
    assert.equal(
      (await app.handle(new Request(`http://main.local${privateRoot}/threads?sort=best&limit=2`)))
        .status,
      404,
    );
    assert(
      (
        await stack.accessPool.query(
          'SELECT 1 FROM access.realm_thread_population_admission WHERE reply=$1 AND NOT admitted',
          [prior.reply],
        )
      ).rowCount,
    );
    const privateChild = await post('g1034:after-admission-child', later, privateRealm);
    await project();
    assert(
      (
        await stack.accessPool.query(
          'SELECT 1 FROM access.realm_thread_population_admission WHERE reply=$1 AND admitted',
          [privateChild.reply],
        )
      ).rowCount,
    );
  });
  let created = 0;
  let winner: string | undefined = corpus.identity.winner.reply;
  for (const size of REALM_RANKING_SCALES) {
    if (size !== 100) {
      await restored.close();
      restored = await restoreRealmRankingCorpus(size);
      home = restored.home;
      stack = home.stack;
      instrumentRestoredFetch();
      evidence.push({ restore: size, elapsedMs: restored.elapsedMs });
      const nextRules = new GovernanceRules(stack.accessPool);
      app = createMainApp(stack.fuseki, {
        ...home.deps,
        realmAdmin: new AccessRealmManagement(stack.accessPool),
        governance: {
          rules: nextRules,
          store: new GovernanceStore(
            stack.accessPool,
            {
              capture: async () => {
                throw new Error('Evidence outside this test');
              },
            },
            { current: async () => null },
            nextRules,
          ),
        },
      });
      api = workProfileCorpusApi('http://main.local', home.author.token, {
        fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      });
      await grantRankingAuthority();
    }
    created = size - 2;
    evidence.push({
      seedCount: created,
      restored: true,
      restoreMs: restored.elapsedMs,
    });
    // The cut already holds this many product replies, projected and voted.
    await project();
    await stack.accessPool.query('ANALYZE access.realm_thread_order');
    const raw = (
      await stack.accessPool.query<{
        reply: string;
        score: number;
        occurred_at: Date;
        placement: string;
      }>(
        `
      SELECT reply,score,occurred_at,placement FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND parent IS NULL`,
        [epoch, realm],
      )
    ).rows;
    assert.equal(raw.length, size);
    const oracle = [...raw].sort(
      (a, b) =>
        bestKey(b.score, b.occurred_at.getTime()) - bestKey(a.score, a.occurred_at.getTime()) ||
        b.occurred_at.getTime() - a.occurred_at.getTime() ||
        a.placement.localeCompare(b.placement),
    );
    assert.equal(
      oracle[0]!.reply,
      winner,
      'An older high-score thread must beat every newer cohort',
    );
    if (size >= 400)
      assert(
        raw.filter((row) => row.occurred_at > oracle[0]!.occurred_at).length > 256,
        'The winner must be outside the former newest-256 cohort',
      );
    for (const sort of ['best', 'top'] as const) {
      for (const viewer of ['anonymous', 'member'])
        for (const temperature of ['first', 'warm']) {
          await flushTelemetryTraces();
          sink.clear();
          const measured = await timeRealmRankingStage(
            'ranking-read',
            () =>
              profileForegroundRequest(async (headers) => {
                if (viewer === 'member')
                  headers.set('authorization', `Bearer ${home.reader.token}`);
                const response = await app.handle(
                  new Request(
                    `http://main.local${root}/threads?sort=${sort}&window=all&limit=2${viewer === 'member' ? `&actingSubject=${encodeURIComponent(reader)}` : ''}`,
                    { headers },
                  ),
                );
                const body = (await response.json()) as {
                  items: { reply: string }[];
                  nextCursor: string | null;
                };
                assert.equal(response.status, 200, JSON.stringify(body));
                assert.deepEqual(
                  body.items.map((item) => item.reply),
                  [winner, opening.reply],
                );
                assert(body.nextCursor);
              }),
            { threads: size, sort, viewer, temperature },
          );
          profiles.push({
            size,
            operation: sort,
            viewer,
            temperature,
            profile: measured.profile,
            postgresStatementList: measured.postgresStatementList,
          });
        }
      for (const after of [false, true]) {
        const pivot = (
          await stack.accessPool.query<{ rank_key: number; time_key: string; placement: string }>(
            `
          SELECT rank_key,time_key::text,placement FROM access.realm_thread_order WHERE data_epoch=$1 AND realm=$2 AND sort=$3 AND period='all'
          ORDER BY realm_thread_order.rank_key,realm_thread_order.time_key,realm_thread_order.placement OFFSET $4 LIMIT 1`,
            [epoch, realm, sort, Math.floor(size * 0.9)],
          )
        ).rows[0]!;
        const connection = await stack.accessPool.connect();
        let plan;
        try {
          await connection.query('BEGIN');
          const settings = (
            await connection.query<{ proconfig: string[] }>(`SELECT proconfig FROM pg_proc
            WHERE oid='access.seek_realm_thread_page(text,text,text,text,double precision,bigint,text,integer,text)'::regprocedure`)
          ).rows[0]!.proconfig;
          assert.deepEqual(settings, ['enable_bitmapscan=off', 'enable_seqscan=off']);
          await connection.query('SET LOCAL enable_bitmapscan=off');
          await connection.query('SET LOCAL enable_seqscan=off');
          plan = (
            await connection.query(
              `EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON,TIMING OFF) ${realmRankSeek(sort, after)}`,
              [
                epoch,
                realm,
                'all',
                after ? pivot.rank_key : null,
                after ? pivot.time_key : null,
                after ? pivot.placement : '',
                3,
              ],
            )
          ).rows[0]!['QUERY PLAN'];
          await connection.query('COMMIT');
        } finally {
          connection.release();
        }
        const encoded = JSON.stringify(plan);
        assert(encoded.includes('realm_thread_seek'));
        const walk = (node: Record<string, any>) => {
          assert(!String(node['Node Type']).includes('Sort'), encoded);
          assert((node['Rows Removed by Filter'] ?? 0) <= 1, encoded);
          assert((node['Actual Rows'] ?? 0) <= 3, encoded);
          for (const child of node.Plans ?? []) walk(child);
        };
        walk(plan[0].Plan);
        evidence.push({ size, sort, after, plan });
      }
    }
    const slots = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(DISTINCT ?slot) AS ?count) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ; rv:replyPlacementHead ?head }
      }`);
    const populatedSlots = Number(slots.results?.bindings?.[0]?.count?.value);
    assert.equal(
      populatedSlots,
      size + (size === 1600 ? corpus.identity.deepChain.length : 0),
      'The write cost must be measured against the populated Realm graph',
    );
    const beforeStatements = foregroundStatements;
    // CountingFuseki observes native template queries as well as legacy query calls.
    const beforeGraphQueries = stack.fuseki.queries;
    let replyCommandProfiles: WorkProfile[] | undefined;
    const profileCommandFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const invoke = async (traceparent?: string) => {
        const headers = new Headers(init?.headers);
        if (traceparent) headers.set('traceparent', traceparent);
        return app.handle(new Request(input, { ...init, headers }));
      };
      if (!replyCommandProfiles || !foregroundCounted()) return invoke();
      const measured = await profileForegroundRequest(async (headers) => {
        const response = await invoke(headers.get('traceparent') ?? undefined);
        await response.clone().arrayBuffer();
        return response;
      });
      replyCommandProfiles.push(measured.profile);
      evidence.push({
        commandTrace: measured.profile.traceId,
        threads: size,
        postgresStatements: measured.profile.postgresStatements,
        tracedPostgresStatements: measured.tracedPostgresStatements,
      });
      return measured.result;
    };
    api = workProfileCorpusApi('http://main.local', home.author.token, {
      fetch: profileCommandFetch as typeof fetch,
    });
    replyCommandProfiles = [];
    let posted;
    try {
      posted = await timeRealmRankingStage('measured-write', () => post(`g1034:cost:${size}`), {
        threads: size,
      });
    } finally {
      evidence.push({
        replyWriteObservation: size,
        populatedSlots,
        fusekiOrigin: new URL(restored.fusekiUrl).origin,
        postgresStatements: foregroundStatements - beforeStatements,
        fusekiQueryCalls: stack.fuseki.queries - beforeGraphQueries,
        commands: replyCommandProfiles.map((profile) => ({
          traceId: profile.traceId,
          postgresStatements: profile.postgresStatements,
          fusekiRequests: profile.fusekiRequests,
          unclassifiedFetches: profile.unclassifiedFetches,
          unobserved: profile.unobserved,
        })),
      });
    }
    assert(posted.reply.startsWith('https://rezics.com/id/'));
    const commandProfiles = replyCommandProfiles;
    replyCommandProfiles = undefined;
    assert.equal(
      commandProfiles.length,
      4,
      'A Realm reply has draft, identity, review, and placement commands',
    );
    const statements = commandProfiles.reduce(
      (sum, profile) => sum + profile.postgresStatements!,
      0,
    );
    const fusekiQueryCalls = stack.fuseki.queries - beforeGraphQueries;
    const fusekiRequests = commandProfiles.every((profile) => profile.fusekiRequests !== null)
      ? commandProfiles.reduce((sum, profile) => sum + profile.fusekiRequests!, 0)
      : null;
    const unobserved = [...new Set(commandProfiles.flatMap((profile) => profile.unobserved))];
    replyWrites.push({
      size,
      populatedSlots,
      profile: {
        ...commandProfiles.at(-1)!,
        postgresStatements: statements,
        fusekiRequests,
        unclassifiedFetches: commandProfiles.reduce(
          (sum, profile) => sum + profile.unclassifiedFetches,
          0,
        ),
        unobserved,
      },
      fusekiQueryCalls,
    });
    evidence.push({
      replyWrite: size,
      populatedSlots,
      postgresStatements: statements,
      fusekiRequests,
      fusekiQueryCalls,
    });
    assert(
      statements > 0 && fusekiRequests !== null && fusekiRequests > 0 && fusekiQueryCalls > 0,
      'Foreground write meters must observe both owner and graph work',
    );
    assert(
      performance.now() - started < 600_000,
      'Corpus readiness exceeded its preparation budget',
    );
    evidence.push({
      size,
      preparationMs: performance.now() - started,
      basis:
        'replies posted through the Realm reply commands and projected; first/warm are not engine-cold',
    });
  }
  // The final write above advances the population after its per-scale reads.
  // Catch Home up before asserting the rolling-window pages are ready.
  await project();
  // Rolling windows select their entire eligible populations before LIMIT.
  for (const period of ['week', 'month', 'all']) {
    const response = await app.handle(
      new Request(`http://main.local${root}/threads?sort=top&window=${period}&limit=2`),
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      ((await response.json()) as { items: { reply: string }[] }).items[0]!.reply,
      winner,
    );
  }
  // Top expiry crosses wall-clock time without changing the vote/age formula.
  await stack.accessPool.query(
    `UPDATE access.realm_thread_order SET expires_at=clock_timestamp()-interval '1 second'
    WHERE data_epoch=$1 AND realm=$2 AND reply=$3 AND period='week'`,
    [epoch, realm, winner],
  );
  assert.equal(
    (await app.handle(new Request(`http://main.local${root}/threads?sort=top&window=week&limit=2`)))
      .status,
    503,
  );
  await project();
  assert.equal(
    (
      await stack.accessPool.query(
        `SELECT 1 FROM access.realm_thread_order WHERE data_epoch=$1 AND realm=$2 AND reply=$3 AND period='week'`,
        [epoch, realm, winner],
      )
    ).rowCount,
    0,
  );
  // Live vote maintenance is transactional, including concurrent same-target
  // writes. A score change keeps the Realm's population revision and cursors.
  const firstPage = await app.handle(
    new Request(`http://main.local${root}/threads?sort=top&window=all&limit=1`),
  );
  const cursor = ((await firstPage.json()) as { nextCursor: string }).nextCursor;
  const voterMember = await home.member('g1034-voter');
  const voterSubject = await home.provision('ranking voter', voterMember.token);
  const voter = workProfileCorpusApi('http://main.local', voterMember.token, {
    fetch: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  // Capture the committed score before the transactional vote changes it.
  const baseline = (
    await stack.accessPool.query<{ score: number }>(
      'SELECT score FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3',
      [epoch, realm, opening.reply],
    )
  ).rows[0]!.score;
  const voted = await timeRealmRankingStage('vote', () =>
    voter.command<{ score: number; replayed: boolean }>(`g1034:vote:${randomUUID()}`, {
      method: 'POST',
      path: `/v1/feed/${opening.placement.slice(-36)}/vote`,
      body: {
        profile: 'feed-vote-command-v1',
        actingSubject: voterSubject,
        value: 1,
        expectedRevision: null,
      },
    }),
  );
  assert.equal(voted.score, baseline + 1);
  await Promise.all([
    stack.accessPool.query(
      'UPDATE access.feed_item SET score=score+1 WHERE data_epoch=$1 AND id=$2',
      [epoch, opening.placement],
    ),
    stack.accessPool.query(
      'UPDATE access.feed_item SET score=score+1 WHERE data_epoch=$1 AND id=$2',
      [epoch, opening.placement],
    ),
  ]);
  const changed = await app.handle(
    new Request(
      `http://main.local${root}/threads?sort=top&window=all&limit=1&cursor=${encodeURIComponent(cursor)}`,
    ),
  );
  assert.equal(voted.replayed, false);
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(
    (
      await stack.accessPool.query(
        'SELECT score FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3',
        [epoch, realm, opening.reply],
      )
    ).rows[0]!.score,
    baseline + 3,
  );
  const child = await post('g1034:child', opening);
  await project();
  assert.equal(
    (
      await stack.accessPool.query(
        'SELECT replies FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3',
        [epoch, realm, opening.reply],
      )
    ).rows[0]!.replies,
    1,
  );
  // The opening keeps exactly one live child; the retained second thread tests
  // one new placement beyond the bounded ancestor walk at depth 41.
  const parent = await post('g1034:deep:41', corpus.identity.deepChain.at(-1)!);
  await project();
  const deep = (
    await stack.accessPool.query<{ thread: string; active: boolean }>(
      `
    SELECT thread,active FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3`,
      [epoch, realm, parent.reply],
    )
  ).rows[0]!;
  assert.deepEqual(deep, { thread: corpus.identity.second.reply, active: true });
  assert.equal(
    (await app.handle(new Request(`http://main.local${root}/threads?sort=best&limit=2`))).status,
    200,
    'A deep reply must not make every Realm ranking unavailable',
  );
  // A revoked approval is removed by the Content event replay, and retained text is still fenced live.
  await api.command('g1034:revoke', {
    method: 'POST',
    path: '/v1/realm-reply-reviews',
    body: {
      profile: 'realm-reply-review-v1',
      realm,
      reply: opening.reply,
      revisionId: opening.revision,
      revisionDigest: opening.digest,
      expectedGeneration: '1',
      supersedes: opening.review,
      outcome: 'revoked',
      method: 'human',
      methodRevision: 'g1034-v1',
      dependencyDigest: 'a'.repeat(64),
      reasonReference: 'Revoked test approval',
      actingSubject: actor,
    },
  });
  try {
    await timeRealmRankingStage('post-revocation-projection', project, {
      threads: 1600,
      target: restored.target,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Main feed graph reference cut is unavailable'
    ) {
      // Kernel's gated-reads-design.md now requires retained zero-event batch
      // headers to supply their source-verified graph cuts. Keep custody evidence
      // if that qualification regresses; projection must succeed after revocation.
      try {
        const after = (
          await stack.accessPool.query<{
            data_epoch: string;
            sequence: string;
            after_id: string;
          }>(`SELECT data_epoch,sequence::text,after_id FROM access.feed_checkpoint WHERE id`)
        ).rows[0];
        const through = await home.deps.relayPosition!.read();
        if (!through)
          throw new Error('Main Relay checkpoint is unavailable for projection diagnosis');
        const sequences = [
          ...new Set(
            [after?.sequence, through.sequence].filter(
              (sequence): sequence is string => !!sequence,
            ),
          ),
        ];
        const batches = (
          await home.relay.query(
            `SELECT stream_scope,data_epoch,
          sequence::text,batch_id,routing_epoch,event_count,graph_sequence::text FROM relay.delivered_batch
          WHERE stream_scope=$1 AND data_epoch=$2 AND sequence=ANY($3::numeric[])
          ORDER BY sequence LIMIT 4`,
            [through.streamScope, through.dataEpoch, sequences],
          )
        ).rows;
        const events = (
          await home.relay.query(
            `SELECT DISTINCT sequence::text AS stream_sequence,
          envelope->>'type' AS event_type,
          envelope #>> '{data,sourcePosition,datasetId}' AS dataset_id,
          envelope #>> '{data,sourcePosition,dataEpoch}' AS graph_epoch,
          envelope #>> '{data,sourcePosition,sequence}' AS graph_sequence,
          envelope #>> '{data,relayPosition,streamScope}' AS relay_scope,
          envelope #>> '{data,relayPosition,dataEpoch}' AS relay_epoch,
          envelope #>> '{data,relayPosition,sequence}' AS envelope_stream_sequence
          FROM relay.delivered_event WHERE stream_scope=$1 AND data_epoch=$2
          AND sequence=ANY($3::numeric[]) LIMIT 4`,
            [through.streamScope, through.dataEpoch, sequences],
          )
        ).rows;
        evidence.push({
          reviewRevocationProjectionRefusal: {
            message: error.message,
            predicate: 'services/main/src/modules/feed/source.ts:115-118',
            after,
            through,
            batches,
            events,
          },
        });
      } catch (diagnosticError) {
        evidence.push({ reviewRevocationProjectionDiagnosticError: String(diagnosticError) });
      }
    }
    throw error;
  }
  assert.equal(
    (
      await stack.accessPool.query(
        `SELECT 1 FROM access.realm_thread_order WHERE data_epoch=$1 AND realm=$2 AND reply=$3`,
        [epoch, realm, opening.reply],
      )
    ).rowCount,
    0,
  );
  evidence.push({ reviewRevocationProjection: { outcome: 'passed', removedReply: opening.reply } });
  // Strong gates remove a whole denied population before the next seek.
  await stack.accessPool.query(
    `INSERT INTO access.scope_gate(id,open) VALUES($1,false) ON CONFLICT(id) DO UPDATE SET open=false`,
    [`work:read:${work.work}`],
  );
  const denied = await app.handle(new Request(`http://main.local${root}/threads?sort=top&limit=2`));
  assert.equal(denied.status, 200);
  assert.deepEqual(((await denied.json()) as { items: unknown[] }).items, []);
  await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
  assert.equal(
    (await app.handle(new Request(`http://main.local${root}/threads?sort=best&limit=2`))).status,
    503,
  );
  await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id');
  evidence.push({
    outcomes: [
      'incomplete',
      'older winner',
      'keyset',
      'vote race',
      'reply activity',
      'revoked review',
      'strong gate',
    ],
    child: child.reply,
  });
} finally {
  mkdirSync('.temp/work-profiles', { recursive: true });
  writeFileSync(
    process.env.REZICS_WORK_PROFILE_RESULT ?? '.temp/work-profiles/g-1034.json',
    JSON.stringify(
      { evidence, profiles, replyWrites, ownerDatabases, ownerDatabaseEndpoints },
      null,
      2,
    ) + '\n',
  );
  try {
    await timeRealmRankingStage('profile-cleanup', () => restored.close());
  } finally {
    prototype.query = originalQuery;
    restoreProfileFetch?.();
    await shutdownTelemetry();
    await sink.stop();
  }
}
