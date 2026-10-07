import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Pool } from 'pg';
import { cloneOwners, requireQa } from './recommendation-support.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { workProfileCorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  boundedPool,
  nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode,
} from '../../../services/main/src/infrastructure/pg-pool.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
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
  const state = join(
    resolve(import.meta.dir, '../../..'),
    '.temp',
    `realm-discussion-pool-${randomUUID()}`,
  );
  mkdirSync(state, { recursive: true });
  try {
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
    const env: WorkActivationEnvironment = {
      fuseki: new FusekiClient(Bun.env.FUSEKI_URL!),
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: join(state, 'objects'),
      addresses: new AliasRegistry(accessPool),
    };
    const access = new AccessAdmissionRegistry(accessPool);
    access.configureBaseline(env.fuseki);
    const disclosure = new DisclosureStore(accessPool);
    configureDisclosurePool(accessPool, disclosure);
    configureDisclosure(env, disclosure);
    const content = new ContentCore(contentPool);
    const feed = new FeedStore(accessPool);
    const consumer = `realm-discussion-pool-${randomUUID()}`;
    const deps = {
      environment: env,
      account: { verify: async () => ({ ...principal, currentAssertion: async () => principal }) },
      access,
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
      realmReplies: new RealmReplyStore(
        new RealmReplyContentStore(contentPool),
        content,
        access,
        env,
      ),
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
    for (const [scope, action] of [
      [`review:decide:${realm}`, 'review.decide'],
      [`reply:place:${realm}`, 'reply.place'],
    ] as const) {
      await accessPool.query(
        'INSERT INTO access.scope_gate(id) VALUES($1) ON CONFLICT DO NOTHING',
        [scope],
      );
      await accessPool.query(
        `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES($1,$2,$3,$4,now()+interval '1 hour')`,
        [randomUUID(), principalId, actor, action],
      );
      await accessPool.query(
        `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES($1,$2,$2,$3,$4,now()+interval '1 hour')`,
        [randomUUID(), actor, scope, action],
      );
    }
    const work = await seedPublicProfileWork(api, 'root', {
      actingSubject: actor,
      title: 'Discussion root',
      body: 'Public root',
    });
    const reply = `https://rezics.com/id/${randomUUID()}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await api.command<{ revisionId: string; revisionDigest: string }>('draft', {
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
        body: 'A reviewed discussion\nIts approved words.',
        actingSubject: actor,
      },
    });
    const draft = { revisionId: saved.revisionId, revisionDigest: saved.revisionDigest };
    await api.command('identity', {
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
        parentReply: null,
        parentRevision: null,
        contextRevision: null,
      },
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
    const approval = await api.command<{ decisionId: string }>('approve', {
      method: 'POST',
      path: '/v1/realm-reply-reviews',
      body: review,
    });
    await api.command('place', {
      method: 'POST',
      path: '/v1/realm-reply-placements',
      body: {
        profile: 'realm-reply-placement-v1',
        realm,
        reply,
        ...draft,
        reviewDecisionId: approval.decisionId,
        expectedHead: null,
        actingSubject: actor,
      },
    });
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
    const root = `/v1/realms/${realm.slice(-36)}`;
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
    await accessPool.end();
    await contentPool.end();
    await relayPool.end();
    setNestedPoolCheckoutMode(mode);
    await owners.close();
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
