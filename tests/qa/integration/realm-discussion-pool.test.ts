import { expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client, type Pool, type PoolClient } from 'pg';
import { cloneOwners, requireQa } from './recommendation-support.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  boundedPool,
  connectionBoundOptions,
  nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode,
} from '../../../services/main/src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import type { RealmSettings } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { AliasRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import {
  configureDisclosure,
  configureDisclosurePool,
  DisclosureStore,
} from '../../../services/main/src/modules/disclosure/read.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { FeedViewerStateReader } from '../../../services/main/src/modules/feed/viewer-state.ts';
import { HomePersonalStore } from '../../../services/main/src/modules/feed/personal.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyThreadStore } from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

test('one guarded Access connection projects and reads mandatory-review Realm discussions with live withdrawal', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  const mode = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  const accessPool = boundedPool({ connectionString: owners.urls.access, max: 1 });
  const checkoutFailures: string[] = [];
  const connect = accessPool.connect.bind(accessPool);
  accessPool.connect = ((callback?: Parameters<Pool['connect']>[0]) =>
    callback
      ? connect(callback)
      : connect().catch((error) => {
          checkoutFailures.push(
            error instanceof Error ? (error.stack ?? String(error)) : String(error),
          );
          throw error;
        })) as Pool['connect'];
  const contentPool = boundedPool({ connectionString: owners.urls.content, max: 1 });
  const relayPool = boundedPool({ connectionString: owners.urls.relay, max: 1 });
  // An independent authority writer observes committed rows and races
  // revocation. Application work has only its single guarded Access client.
  const revoker = new Client({
    connectionString: owners.urls.access,
    options: connectionBoundOptions(),
  });
  const state = join(
    resolve(import.meta.dir, '../../..'),
    '.temp',
    `realm-discussion-pool-${randomUUID()}`,
  );
  mkdirSync(state, { recursive: true });
  try {
    await revoker.connect();
    await migrateContent(contentPool);
    const principalId = randomUUID();
    const principal = {
      issuer: 'https://realm-discussion-pool.test',
      subject: randomUUID(),
      emailVerified: true,
    };
    await accessPool.query(
      'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)',
      [principalId, principal.issuer, principal.subject],
    );
    await accessPool.query('SELECT access.seed_platform_grants($1,$2)', [
      principalId,
      `urn:rezics:access-receipt:${'a'.repeat(64)}`,
    ]);
    const administratorId = randomUUID();
    await accessPool.query(
      'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES($1,$2,$3)',
      [administratorId, principal.issuer, randomUUID()],
    );
    await accessPool.query('SELECT access.seed_platform_grants($1,$2)', [
      administratorId,
      `urn:rezics:access-receipt:${'b'.repeat(64)}`,
    ]);
    const env: WorkActivationEnvironment = {
      fuseki: new FusekiClient(Bun.env.FUSEKI_URL!),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects'),
      addresses: new AliasRegistry(accessPool),
    };
    const access = new AccessAdmissionRegistry(accessPool);
    access.configureBaseline(env.fuseki);
    let heldClient: PoolClient | undefined;
    const fenceClaim = access.fenceClaim.bind(access);
    access.fenceClaim = async (client, ...args) => {
      heldClient = client;
      return fenceClaim(client, ...args);
    };
    const disclosure = new DisclosureStore(accessPool);
    configureDisclosurePool(accessPool, disclosure);
    configureDisclosure(env, disclosure);
    const content = new ContentCore(contentPool);
    const feed = new FeedStore(accessPool);
    const replyOwner = new RealmReplyContentStore(contentPool);
    const consumer = `realm-discussion-pool-${randomUUID()}`;
    const deps = {
      environment: env,
      account: { verify: async () => ({ ...principal, currentAssertion: async () => principal }) },
      access,
      realmAdmin: new AccessRealmManagement(accessPool),
      content,
      contentAuthoring: content,
      feed,
      feedViewerState: new FeedViewerStateReader(),
      homePersonal: new HomePersonalStore(accessPool),
      follows: new FollowsStore(accessPool),
      reviews: new ReaderReviews(accessPool),
      profiles: new ProfilesAccess(accessPool),
      personPreferences: new PersonPreferencesStore(accessPool),
      agentProvisioning: new AgentProvisioning(accessPool, env),
      agentHandles: new AgentVanityHandles(accessPool),
      realmReplies: new RealmReplyStore(replyOwner, content, access, env),
      realmReplyThreads: new RealmReplyThreadStore(contentPool, accessPool),
      relayPosition: new RelayHandoffPositions(relayPool, consumer),
    };
    const app = createMainApp(env.fuseki, deps);
    const api = workProfileCorpusApi('http://main.local', 'fixture', {
      fetch: (async (input, init) => {
        const response = await app.handle(new Request(input, init));
        if (!response.ok)
          throw new Error(
            `${init?.method} ${input}: ${response.status} ${await response.text()} ${checkoutFailures.join('\n')}`,
          );
        return response;
      }) as typeof fetch,
    });
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    const position = await workRead(
      deps,
      new Request('http://main.internal/fixture-position'),
      {},
      async (session) => session.position,
    );
    await relayPool.query(
      'UPDATE relay.checkpoint SET sequence=$2 WHERE consumer=$1 AND data_epoch=$3',
      [consumer, position.sequence, position.dataEpoch],
    );
    await feed.advance(await feed.initialize(position.dataEpoch), position.sequence, [], new Map());
    const actor = (
      await api.command<{ agent: string }>('author', {
        method: 'POST',
        path: '/v1/agents',
        body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Discussion author' },
      })
    ).agent;
    const moderator = (
      await api.command<{ agent: string }>('moderator', {
        method: 'POST',
        path: '/v1/agents',
        body: {
          profile: 'agent-provision-v1',
          kind: 'person',
          displayName: 'Discussion moderator',
        },
      })
    ).agent;
    const realm = (
      await api.command<{ realm: string }>('realm', {
        method: 'POST',
        path: '/v1/spaces',
        body: {
          profile: 'space-realm-v1',
          name: 'Reviewed discussions',
          capabilities: ['realm'],
          actingSubject: actor,
        },
      })
    ).realm;
    let placementGrant = '';
    for (const [scope, action, recipient] of [
      [`review:decide:${realm}`, 'review.decide', actor],
      [`reply:place:${realm}`, 'reply.place', moderator],
    ] as const) {
      await accessPool.query(
        'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [randomUUID(), principalId, recipient, action],
      );
      const grantId = randomUUID();
      if (action === 'reply.place') placementGrant = grantId;
      await accessPool.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`,
        [grantId, actor, recipient, scope, action],
      );
    }
    const work = await seedPublicProfileWork(api, 'root', {
      actingSubject: actor,
      title: 'Discussion root',
      body: 'Public root',
    });
    const prepareReply = async (key: string, origin = false) => {
      const reply = `https://rezics.com/id/${randomUUID()}`;
      const variantId = `urn:rezics:variant:${randomUUID()}`;
      const draftInput = {
        profile: 'member-reply-draft-v1',
        reply,
        variantId,
        rootTarget: work.work,
        rootRevision: work.draftRevision,
        language: 'en',
        direction: 'ltr',
        expectedHead: null,
        body: 'A reviewed discussion\nIts approved words.',
        actingSubject: actor,
        ...(origin ? { originRealm: realm } : {}),
      };
      const saved = await api.command<{ revisionId: string; revisionDigest: string }>(
        `${key}:draft`,
        {
          method: 'POST',
          path: '/v1/member-reply-drafts',
          body: draftInput,
        },
      );
      const draft = { revisionId: saved.revisionId, revisionDigest: saved.revisionDigest };
      const identityInput = {
        profile: 'realm-reply-identity-v1',
        reply,
        variantId,
        revisionId: draft.revisionId,
        author: actor,
        rootTarget: work.work,
        rootRevision: work.draftRevision,
        parentReply: null,
        parentRevision: null,
        contextRevision: null,
      };
      await api.command(`${key}:identity`, {
        method: 'POST',
        path: '/v1/realm-replies',
        body: identityInput,
      });
      const review = {
        profile: 'realm-reply-review-v1',
        realm,
        reply,
        ...draft,
        expectedGeneration: '0',
        supersedes: null,
        outcome: 'approved',
        method: 'human',
        methodRevision: 'realm-manager-v1',
        dependencyDigest: 'a'.repeat(64),
        reasonReference: null,
        actingSubject: actor,
      };
      const approval = await api.command<{ decisionId: string }>(`${key}:approve`, {
        method: 'POST',
        path: '/v1/realm-reply-reviews',
        body: review,
      });
      return {
        reply,
        draft,
        saved,
        draftInput,
        identityInput,
        review,
        approval,
        placement: {
          profile: 'realm-reply-placement-v1',
          realm,
          reply,
          ...draft,
          reviewDecisionId: approval.decisionId,
          expectedHead: null,
          actingSubject: moderator,
        },
      };
    };
    const opening = await prepareReply('opening', true);
    const { reply, review, approval } = opening;
    expect(
      await api.command<{ replayed: boolean }>('opening:draft', {
        method: 'POST',
        path: '/v1/member-reply-drafts',
        body: opening.draftInput,
      }),
    ).toMatchObject({ replayed: true });
    expect(
      await api.command<{ replayed: boolean }>('opening:identity', {
        method: 'POST',
        path: '/v1/realm-replies',
        body: opening.identityInput,
      }),
    ).toMatchObject({ replayed: true });
    const placed = await api.command<{ placement: string; replayed: boolean }>('place', {
      method: 'POST',
      path: '/v1/realm-reply-placements',
      body: opening.placement,
    });
    expect(
      await api.command<{ placement: string; replayed: boolean }>('place', {
        method: 'POST',
        path: '/v1/realm-reply-placements',
        body: opening.placement,
      }),
    ).toMatchObject({ placement: placed.placement, replayed: true });
    const refresh = new FeedRefreshWorker(deps, feed, relayPool);
    const project = async () => {
      for (let tick = 0; tick < 100; tick++) {
        if (!(await relayMainOutboxOnce(env.fuseki, relayPool, consumer))) break;
        if (tick === 99) throw new Error('Realm fixture relay exceeded its budget');
      }
      for (let tick = 0; tick < 100; tick++) if ((await refresh.tick()) === 'current') return;
      throw new Error('Realm fixture projection exceeded its budget');
    };
    const get = async (path: string) => {
      const response = await app.handle(new Request(`http://main.local${path}`));
      const text = await response.text();
      expect(response.status, `${path}: ${text}`).toBe(200);
      return JSON.parse(text);
    };
    await project();
    const root = `/v1/realms/${realm.slice(-36)}` as const;
    expect((await get(root)).reviewMode).toBe('mandatory');
    for (const sort of ['new', 'best', 'top']) {
      const page = await get(`${root}/threads?sort=${sort}&limit=2`);
      expect(page.items.map((item: { reply: string }) => item.reply)).toEqual([reply]);
    }
    const page = await get('/v1/feed?scope=all&sort=new&limit=20');
    expect(page.items.some((item: { kind: string }) => item.kind === 'discussion')).toBe(true);
    await api.command('withdraw', {
      method: 'POST',
      path: '/v1/realm-reply-reviews',
      body: {
        ...review,
        outcome: 'revoked',
        expectedGeneration: '1',
        supersedes: approval.decisionId,
        reasonReference: 'withdrawn',
      },
    });
    expect((await get(`${root}/threads?sort=new&limit=2`)).items).toEqual([]);
    await project();
    expect((await get(`${root}/threads?sort=top&limit=2`)).items).toEqual([]);

    const placementRequest = async (key: string, body: unknown) =>
      app.handle(
        new Request('http://main.local/v1/realm-reply-placements', {
          method: 'POST',
          headers: {
            authorization: 'Bearer fixture',
            'idempotency-key': key,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
    const outcome = async (key: string) =>
      (
        await accessPool.query<{ state: string; graph_outcome: string; id: string }>(
          `SELECT id,state,graph_outcome FROM access.admission WHERE principal_id=$1 AND action='reply.place' AND idempotency_key=$2`,
          [principalId, key],
        )
      ).rows[0]!;
    const withRealmPolicy = access.withRealmPolicy.bind(access);
    let beforePermit: (() => Promise<void>) | undefined;
    access.withRealmPolicy = async (...args) => {
      const change = beforePermit;
      beforePermit = undefined;
      if (change) await change();
      return withRealmPolicy(...args);
    };

    // Refusal in the gap after committed claim must resolve a real terminal
    // cancellation, without publishing or leaving a pin/admission for a drain.
    const refused = await prepareReply('grant-refused');
    beforePermit = async () => {
      await accessPool.query('UPDATE access.permission_grant SET active=false WHERE id=$1', [
        placementGrant,
      ]);
    };
    const deniedPlacement = await placementRequest('grant-refused:place', refused.placement);
    expect(deniedPlacement.status, await deniedPlacement.text()).toBe(403);
    const cancelled = await outcome('grant-refused:place');
    expect(cancelled).toMatchObject({ state: 'sealed', graph_outcome: 'cancelled' });
    expect(
      (
        await contentPool.query(
          'SELECT 1 FROM content.publication_preparation WHERE operation_id=$1',
          [cancelled.id],
        )
      ).rowCount,
    ).toBe(0);
    await accessPool.query('UPDATE access.permission_grant SET active=true WHERE id=$1', [
      placementGrant,
    ]);
    const cancelledReplay = await placementRequest('grant-refused:place', refused.placement);
    expect(cancelledReplay.status, await cancelledReplay.text()).toBe(409);

    const expired = await prepareReply('expired');
    beforePermit = async () => {
      await accessPool.query(
        `UPDATE access.admission SET expires_at=clock_timestamp()-interval '1 millisecond'
        WHERE principal_id=$1 AND action='reply.place' AND idempotency_key=$2`,
        [principalId, 'expired:place'],
      );
    };
    const deniedExpiry = await placementRequest('expired:place', expired.placement);
    expect(deniedExpiry.status, await deniedExpiry.text()).toBe(409);
    expect(await outcome('expired:place')).toMatchObject({
      state: 'sealed',
      graph_outcome: 'cancelled',
    });

    const recovering = await prepareReply('recovery-held');
    beforePermit = async () => {
      await accessPool.query(
        'UPDATE access.recovery_fence SET open=false,generation=generation+1 WHERE id',
      );
    };
    const heldRecovery = await placementRequest('recovery-held:place', recovering.placement);
    expect(heldRecovery.status, await heldRecovery.text()).toBe(503);
    const recoveryAdmission = await outcome('recovery-held:place');
    expect(recoveryAdmission).toMatchObject({ state: 'claimed', graph_outcome: null });
    expect(
      (
        await contentPool.query(
          'SELECT 1 FROM content.publication_preparation WHERE operation_id=$1',
          [recoveryAdmission.id],
        )
      ).rowCount,
    ).toBe(0);
    await accessPool.query(
      'UPDATE access.recovery_fence SET open=true,generation=generation+1 WHERE id',
    );
    await api.command('recovery-held:place', {
      method: 'POST',
      path: '/v1/realm-reply-placements',
      body: recovering.placement,
    });
    expect(await outcome('recovery-held:place')).toMatchObject({
      state: 'sealed',
      graph_outcome: 'succeeded',
    });
    await api.command('recovery-held:withdraw', {
      method: 'POST',
      path: '/v1/realm-reply-reviews',
      body: {
        ...recovering.review,
        outcome: 'revoked',
        expectedGeneration: '1',
        supersedes: recovering.approval.decisionId,
        reasonReference: 'Recover the held write before withdrawal',
      },
    });

    const survivor = await prepareReply('survivor');
    const survivorPlacement = await api.command<{ placement: string }>('survivor:place', {
      method: 'POST',
      path: '/v1/realm-reply-placements',
      body: survivor.placement,
    });
    const concurrent = await prepareReply('concurrent');
    const prepared = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const preparePlacement = replyOwner.preparePlacement.bind(replyOwner);
    replyOwner.preparePlacement = async (...args) => {
      // A different connection must already see the claim before Content can
      // commit. Borrowing an uncommitted outer transaction fails this proof.
      expect(
        (await revoker.query('SELECT state FROM access.admission WHERE id=$1', [args[0].id])).rows,
      ).toEqual([{ state: 'claimed' }]);
      const result = await preparePlacement(...args);
      prepared.resolve();
      await finish.promise;
      return result;
    };
    const invocation = new AsyncResource('realm-placement-request');
    const writing = invocation.runInAsyncScope(() =>
      api.command<{ placement: string }>('concurrent:place', {
        method: 'POST',
        path: '/v1/realm-reply-placements',
        body: concurrent.placement,
      }),
    );
    let revocation: Promise<unknown> | undefined;
    try {
      await Promise.race([
        prepared.promise,
        writing.then(() => {
          throw new Error('Placement finished before its pause');
        }),
      ]);
      const pid = (await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      revocation = revoker.query('UPDATE access.permission_grant SET active=false WHERE id=$1', [
        placementGrant,
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        waiting =
          (
            await heldClient!.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
              pid,
            ])
          ).rows[0]?.wait_event_type === 'Lock';
        if (waiting) break;
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      finish.resolve();
      await writing;
      await revocation;
    } finally {
      finish.resolve();
      await writing;
      if (revocation) await revocation;
      replyOwner.preparePlacement = preparePlacement;
      invocation.emitDestroy();
    }
    // Withdrawal after the native winner cannot strand its exact seal or
    // prevent same-key receipt recovery; no new grant is issued for replay.
    expect(await outcome('concurrent:place')).toMatchObject({
      state: 'sealed',
      graph_outcome: 'succeeded',
    });
    expect(
      await api.command<{ replayed: boolean }>('concurrent:place', {
        method: 'POST',
        path: '/v1/realm-reply-placements',
        body: concurrent.placement,
      }),
    ).toMatchObject({ replayed: true });
    await project();
    expect(
      (await get(`${root}/threads?sort=new&limit=2`)).items.map(
        (item: { reply: string }) => item.reply,
      ),
    ).toEqual([concurrent.reply, survivor.reply]);
    await api.command('vote-survivor', {
      method: 'POST',
      path: `/v1/feed/${survivorPlacement.placement.slice(-36)}/vote`,
      body: {
        profile: 'feed-vote-command-v1',
        actingSubject: actor,
        value: 1,
        expectedRevision: null,
      },
    });
    expect(
      (await get(`${root}/threads?sort=top&limit=2`)).items.map(
        (item: { reply: string }) => item.reply,
      ),
    ).toEqual([survivor.reply, concurrent.reply]);
    expect(
      (await get(`${root}/threads?sort=best&limit=2`)).items.map(
        (item: { reply: string }) => item.reply,
      ),
    ).toEqual([survivor.reply, concurrent.reply]);
    type SettingsView = {
      generation: string;
      settings: RealmSettings;
      ruleBasis: { revision: string | null };
    };
    const policy = async (visibility: 'public' | 'private', key: string) => {
      const current = await api.read<SettingsView>(
        `${root}/settings?actingSubject=${encodeURIComponent(actor)}`,
      );
      await api.command(key, {
        method: 'PUT',
        path: `${root}/settings`,
        body: {
          actingSubject: actor,
          expectedGeneration: current.generation,
          expectedRulesRevision: current.ruleBasis.revision,
          reason: 'Qualify current Realm write policy',
          settings: { ...current.settings, visibility },
        },
      });
    };
    // The separate policy-event adapter owns delivery of this transition;
    // the write admission must refuse the current private policy immediately.
    await accessPool.query('UPDATE access.permission_grant SET active=true WHERE id=$1', [
      placementGrant,
    ]);
    const privateRefusal = await prepareReply('policy-refused');
    beforePermit = () => policy('private', 'make-private');
    const deniedPolicy = await placementRequest('policy-refused:place', privateRefusal.placement);
    expect(deniedPolicy.status, await deniedPolicy.text()).toBe(403);
    expect(await outcome('policy-refused:place')).toMatchObject({
      state: 'sealed',
      graph_outcome: 'cancelled',
    });
    expect(checkoutFailures).toEqual([]);
    await accessPool.query('UPDATE access.principal SET active=false WHERE id=$1', [principalId]);
    const denied = await app.handle(
      new Request(`http://main.local${root}/threads?actingSubject=${encodeURIComponent(actor)}`, {
        headers: { authorization: 'Bearer fixture' },
      }),
    );
    expect(denied.status).toBe(401);
    expect(accessPool.totalCount).toBe(1);
    expect(accessPool.waitingCount).toBe(0);
    expect(contentPool.totalCount).toBe(1);
  } finally {
    await revoker.end();
    await accessPool.end();
    await contentPool.end();
    await relayPool.end();
    setNestedPoolCheckoutMode(mode);
    await owners.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
