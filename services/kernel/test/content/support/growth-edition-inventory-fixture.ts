import { expect } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { registerContent } from '../../../src/content/register.ts';
import type { CreatorEditionPage } from '../../../src/content/edition-index.ts';
import type { ContentEditionView } from '../../../src/content/edition-model.ts';
import { effectWorkflowId, type Effect } from '../../../src/events/effects.ts';
import { readBatch, type Envelope } from '../../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import type { Access } from '../../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { openGrowthDatabase, seed, type GrowthDatabase } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import { createNativeContentSystemWithWriteRateOverrides, registerNativeContentAccount } from './native-system.ts';
import { observeSql, type SqlExecution } from './sql-observer.ts';
import candidatePage from '../../../src/content/edition-index-page.sql';

export const inventoryScales = [256, 1024, 4096] as const;
export const inventoryLimit = 2;
export type InventoryAxis = 'creator-candidates' | 'unrelated-homes' | 'source-history' | 'subject-history' | 'access-history';
export type InventoryPage = 'populated' | 'deep' | 'terminal-empty' | 'hidden';
type Source = { postId: string; revisionId: string; threadId: string };
type Edition = { editionId: string; editionRevision: string };
type Person = { accountId: string; bearer: string };

/** Native producers own selected rows, events, source bindings, grants and lifecycle changes.
 * Only unrelated creator-home pressure uses the admitted bulk seeder. */
export async function createGrowthEditionInventoryFixture() {
  const native = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
  );
  let db: GrowthDatabase | undefined;
  let work: Awaited<ReturnType<typeof composeWork>> | undefined;
  let workerClient: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let observer: ReturnType<typeof observeSql> | undefined;
  try {
    await bootstrapRelease(native.database.pool, bundledRelease);
    const author: Person = { accountId: native.actors.author.actor.accountId, bearer: native.actors.author.bearer };
    const other: Person = { accountId: native.actors.other.actor.accountId, bearer: native.actors.other.bearer };
    const governanceId = (await native.database.pool.query<{ account_id: string }>(
      'SELECT account_id FROM access.governance_bootstrap',
    )).rows[0]!.account_id;
    const governance = await native.auth.issue({
      accountId: governanceId, clientId: native.auth.ordinaryClient.id, scopes: native.auth.ordinaryScopes,
    });
    const suffix = randomUUID().replaceAll('-', '');
    const historyAccount = await registerNativeContentAccount(native, {
      key: suffix, handle: `inventory${suffix.slice(0, 12)}`,
      email: `${suffix}@inventory.test`, password: randomUUID() + randomUUID(),
    });
    // Observe the native bootstrap's platform key rather than inventing grant authority.
    const grantResource = (await native.database.pool.query<{ route: number; resource_id: string }>(
      "SELECT route,resource_id FROM access.resource_grant WHERE subject_id=$1 AND action='subject:create' LIMIT 1",
      [other.accountId],
    )).rows[0]!;
    const consent = createCurrentConsentReader({ database: native.database.authPool });
    let cursorNow = Date.now();
    db = await openGrowthDatabase(native.database.pool.options.connectionString!);
    const database = db;
    // One checkout makes a held creator/source home observable as a deadlock, not spare capacity.
    const pool = database.openPool({ max: 1, connectionTimeoutMillis: 10_000 });
    let duringEditionPrepare: (() => Promise<void>) | undefined;
    const preparedIds: string[] = [];
    const access: Access = {
      authenticate: (token, context) => native.access.authenticate(token, { ...context, pool }),
      prepare: async (actor, action, resource, context) => {
        if (action === 'edition:read') {
          expect(pool.totalCount - pool.idleCount).toBe(0);
          preparedIds.push(resource.id);
          await duringEditionPrepare?.();
        }
        return native.access.prepare?.(actor, action, resource, context);
      },
      authorize: (...args) => native.access.authorize(...args),
    };
    const app = createKernel({
      pool, access, routeKey: native.routeKey, tokens: native.tokenKeys, receiptKeys: testReceiptKeys(),
      writeRate: createWriteRateLimiter({ secret: randomUUID() + randomUUID(), overrides: JSON.stringify({
        'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
      }) }), ratePeer: () => '127.0.0.1',
      content: {
        cursorNow: () => cursorNow,
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      },
    });
    async function request(
      path: string, options: { person?: Person; method?: string; body?: unknown; version?: string; key?: string; setup?: boolean } = {},
    ) {
      const method = options.method ?? 'GET';
      const response = await app.handle(new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${(options.person ?? author).bearer}`,
          ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(options.key ?? randomUUID()) }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.version === undefined ? {} : { 'if-match': JSON.stringify(options.version) }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }));
      const text = await response.text();
      return { response, text, value: text ? JSON.parse(text) as unknown : null };
    }
    async function command<T>(
      path: string, body: unknown, status = 201, method = 'POST', version?: string,
      person = author, key = randomUUID(),
    ): Promise<T> {
      const result = await request(path, { body, method, version, person, key, setup: true });
      expect(result.response.status, `${method} ${path}: ${result.text}`).toBe(status);
      return result.value as T;
    }
    const { subject: scheme } = await command<{ subject: { id: string } }>('/v1/subjects', {
      type: 'skos:ConceptScheme', labels: { en: 'Inventory topics' },
    });
    const { subject } = await command<{ subject: { id: string } }>('/v1/subjects', {
      type: 'skos:Concept', labels: { en: 'Inventory source' },
      statements: { 'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }] },
    });
    const { space } = await command<{ space: { spaceId: string } }>('/v1/spaces', { title: 'Inventory home' });
    const { realm } = await command<{ realm: { realmId: string; headRevisionId: string } }>('/v1/realms', {
      spaceId: space.spaceId, title: 'Inventory realm', visibility: 'public', contextId: GLOBAL_CONTEXT,
    });
    await command(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, 200, 'PUT', realm.headRevisionId);
    const { board } = await command<{ board: { id: string } }>(`/v1/realms/${realm.realmId}/boards`, {
      conceptId: subject.id, title: 'Inventory board', visibility: 'published',
    });
    const body = fromPlainText('A fixed inventory source body');
    async function source(person = author): Promise<Source> {
      const { thread } = await command<{ thread: { id: string; firstPost: { id: string } } }>('/v1/threads', {
        title: 'Inventory source', body, licence: 'CC0-1.0', subjectIds: [subject.id],
        boardId: board.id, visibility: 'published',
      }, 201, 'POST', undefined, person);
      const { post } = await command<{ post: { id: string; revisionId: string } }>(`/v1/threads/${thread.id}/posts`, {
        body, licence: 'CC0-1.0', subjectIds: [subject.id], parentId: thread.firstPost.id,
      }, 201, 'POST', undefined, person);
      return { postId: post.id, revisionId: post.revisionId, threadId: thread.id };
    }
    let selectedSource = await source();
    let historySource = selectedSource;
    let headRevision = selectedSource.revisionId;

    // Register the complete production module. Enrollment uses its durable effect workflow,
    // supplied only with readBatch's committed native envelope.
    const registered: Effect[] = [];
    await DBOS.shutdown({ deregister: true });
    workerClient = await createWorkClient(database.url, native.database.pool);
    work = await composeWork([{
      name: registerContent.name,
      register(context) {
        return registerContent.register({ ...context, addEffects(effects) {
          registered.push(...effects);
          context.addEffects(effects);
        } });
      },
    }], {
      databaseUrl: database.url, pool: native.database.pool, client: workerClient,
      executorId: `inventory-${suffix}`,
      env: workerTestEnv({
        KERNEL_ROUTE_KEY: Buffer.from(native.routeKey).toString('base64url'), CONTENT_TEST_COLLECTION_PARTITIONS: '0',
      }),
    });
    await work.launch();
    const indexEffect = registered.find(({ name }) => name === 'content_creator_edition');
    expect(indexEffect?.types).toContain('com.rezics.content.edition.created.v1');
    const consumer = `inventory_${suffix}`;
    async function enroll(edition: Edition, key: string) {
      const receipt = (await native.database.pool.query<{ partition_no: number; epoch: number; position: string }>(
        `SELECT partition_no,epoch,position::text FROM core.receipt
         WHERE principal_kind='account' AND principal_id=$1 AND idempotency_key=$2`, [author.accountId, key],
      )).rows[0]!;
      // This is an observer checkpoint, never a selected event, receipt or candidate.
      await native.database.pool.query(
        `INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position) VALUES ($1,$2,$3,$4)
         ON CONFLICT(partition_no,consumer) DO UPDATE SET epoch=EXCLUDED.epoch,position=EXCLUDED.position`,
        [receipt.partition_no, consumer, receipt.epoch, (BigInt(receipt.position) - 1n).toString()],
      );
      const envelopes: Envelope[] = [];
      const result = await readBatch(native.database.pool, {
        partition: receipt.partition_no, consumer, envelopes: 1,
        apply: async (batch) => { envelopes.push(...batch); },
      });
      expect(result.status).toBe('read');
      const envelope = envelopes[0]!;
      expect(envelope.position).toBe(BigInt(receipt.position));
      const eventSeq = envelope.events.findIndex((event) => event.type === 'com.rezics.content.edition.created.v1');
      expect(envelope.events[eventSeq]?.subject).toBe(edition.editionId);
      await work!.effects.enqueue([envelope]);
      await workerClient!.retrieveWorkflow(effectWorkflowId(envelope, eventSeq, indexEffect!.name)).getResult({ pollingIntervalMs: 10 });
    }
    const editions = new Map<string, ContentEditionView>();
    async function renewAuthor() {
      const credential = await native.auth.issue({
        accountId: author.accountId, clientId: native.auth.ordinaryClient.id, scopes: native.auth.ordinaryScopes,
      });
      author.bearer = credential.bearer;
    }
    async function addEdition() {
      if (editions.size > 0 && editions.size % 128 === 0) await renewAuthor();
      const key = randomUUID();
      const edition = await command<Edition>('/v1/contentEditions', {
        postId: selectedSource.postId, revisionId: selectedSource.revisionId, targetSubjectId: subject.id,
      }, 201, 'POST', undefined, author, key);
      await enroll(edition, key);
      const metadata = await request(`/v1/contentEditions/${edition.editionId}`, { setup: true });
      expect(metadata.response.status, metadata.text).toBe(200);
      editions.set(edition.editionId, metadata.value as ContentEditionView);
      return edition;
    }
    async function transition(id: string, operation: 'publish' | 'unpublish') {
      const current = editions.get(id)!;
      await command(`/v1/contentEditions/${id}:${operation}`, {}, 200, 'POST', current.editionRevision);
      const result = await request(`/v1/contentEditions/${id}`, { setup: true });
      expect(result.response.status, result.text).toBe(200);
      editions.set(id, result.value as ContentEditionView);
    }
    for (let i = 0; i < 4; i++) await addEdition();
    const initialIds = [...editions.keys()].sort();
    await transition(initialIds[1]!, 'publish');
    await transition(initialIds[1]!, 'unpublish');
    await transition(initialIds[2]!, 'publish');
    const path = (accountId = author.accountId, limit = inventoryLimit, cursor?: string) =>
      `/v1/accounts/${accountId}/editions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    async function page(cursor?: string, person = author): Promise<CreatorEditionPage> {
      const result = await request(path(person.accountId, inventoryLimit, cursor), { person });
      expect(result.response.status, result.text).toBe(200);
      expect(result.response.headers.get('cache-control')).toBe('private, no-store');
      return result.value as CreatorEditionPage;
    }
    let hidden = false;
    let grown = 0;
    let pageCursor: string | undefined;
    let rawIds: string[] = [];
    let expected: ContentEditionView[] = [];
    let expectsNext = true;
    const historyPosts = [selectedSource.postId];
    async function grow(axis: InventoryAxis, shape: InventoryPage, scale: number, previous: number) {
      expect(previous).toBe(grown);
      await renewAuthor();
      if (axis === 'creator-candidates') {
        if (hidden) selectedSource = await source();
        while (editions.size < scale) await addEdition();
      } else if (axis === 'unrelated-homes') {
        await seed(database, {
          name: 'inventory-unrelated-creator-homes', hotPartition: partitionOf(routeOf(author.accountId)!), hotShare: 0.5,
          rows: ({ route, ordinal }) => {
            // Half share the selected creator's exact home, half use other partitions.
            const home = ordinal % 2 === 0 ? routeOf(author.accountId)! : route;
            return { 'content.creator_edition': [{ route: home, creator_account_id: newId(home), edition_id: newId(route) }] };
          },
        }, { from: previous, to: scale });
      } else {
        for (let i = previous; i < scale; i++) {
          if (i > previous && i % 128 === 0) await renewAuthor();
          if (axis === 'source-history') {
          const revised = await command<{ post: { revisionId: string } }>(`/v1/posts/${historySource.postId}/revisions`, {
            body, subjectIds: [subject.id],
          }, 201, 'POST', headRevision);
          headRevision = revised.post.revisionId;
          } else if (axis === 'subject-history') {
          await command(`/v1/subjects/${subject.id}/terms`, { labels: { en: `Inventory source ${i % 2}` } }, 200, 'PATCH', String(i + 1));
          } else {
          // Nonoverlapping expired native grants retain Access history without granting this viewer a read.
          const start = Date.UTC(2000, 0, 1) + i * 60_000;
          await command('/v1/grants', {
            resource: { route: grantResource.route, id: grantResource.resource_id },
            subject: { kind: 'account', id: historyAccount.accountId }, actions: ['subject:create'],
            valid: `[${new Date(start).toISOString()},${new Date(start + 60_000).toISOString()})`,
          }, 201, 'POST', undefined, { accountId: governanceId, bearer: governance.bearer });
          }
        }
      }
      if (shape === 'hidden' && (!hidden || axis === 'creator-candidates')) {
        await command(`/v1/posts/${selectedSource.postId}`, undefined, 200, 'DELETE');
        hidden = true;
        if (axis === 'source-history') {
          historySource = await source();
          headRevision = historySource.revisionId;
          historyPosts.push(historySource.postId);
        }
      }
      const candidateCount = await database.admin.query<{ n: number }>(
        'SELECT count(*)::integer AS n FROM content.creator_edition WHERE route=$1 AND creator_account_id=$2',
        [routeOf(author.accountId), author.accountId],
      );
      expect(candidateCount.rows[0]!.n).toBe(axis === 'creator-candidates' ? scale : 4);
      if (axis === 'unrelated-homes') {
        const unrelated = await database.admin.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM content.creator_edition WHERE creator_account_id<>$1', [author.accountId],
        );
        expect(unrelated.rows[0]!.n).toBe(scale);
      } else if (axis === 'subject-history') {
        const revisions = await database.admin.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM semantic.revision WHERE route=$1 AND subject_id=$2',
          [routeOf(subject.id), subject.id],
        );
        expect(revisions.rows[0]!.n).toBe(scale + 1);
      } else if (axis === 'source-history') {
        const revisions = await database.admin.query<{ n: number }>(
          'SELECT count(*)::integer AS n FROM content.revision WHERE post_id=ANY($1::uuid[])', [historyPosts],
        );
        expect(revisions.rows[0]!.n).toBe(scale + historyPosts.length);
      } else if (axis === 'access-history') {
        const grants = await database.admin.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='subject:create'",
          [grantResource.route, grantResource.resource_id, historyAccount.accountId],
        );
        expect(grants.rows[0]!.n).toBe(scale);
      }
      cursorNow = Date.now();
      const ids = [...editions.keys()].sort();
      pageCursor = undefined;
      // Native continuations only: walking to the deep/terminal boundary is setup, outside capture.
      if (shape === 'deep' || shape === 'terminal-empty') {
        let current: string | undefined;
        for (let offset = 0; offset < ids.length; offset += inventoryLimit) {
          if (offset > 0 && offset % 128 === 0) await renewAuthor();
          if (shape === 'deep' && offset === ids.length - inventoryLimit) break;
          const next = await page(current);
          expect(next.editions.map(({ editionId }) => editionId)).toEqual(ids.slice(offset, offset + inventoryLimit));
          expect(next.next).toBeString();
          current = next.next!;
        }
        pageCursor = current;
      }
      rawIds = shape === 'terminal-empty' ? [] : shape === 'deep' ? ids.slice(-inventoryLimit) : ids.slice(0, inventoryLimit);
      expected = hidden ? [] : rawIds.map((id) => editions.get(id)!);
      expectsNext = shape !== 'terminal-empty';
      await renewAuthor();
      cursorNow = Date.now();
      grown = scale;
    }
    async function observedPage() {
      observer = observeSql(pool);
      preparedIds.length = 0;
      const trace = observer;
      try {
        const result = await page(pageCursor);
        expect(result).toEqual({ editions: expected, next: expectsNext ? expect.any(String) : null });
        const ranges = trace.records.filter(({ statement }) => statement === candidatePage.sql);
        expect(ranges).toHaveLength(1);
        expect(ranges[0]!.parameters[candidatePage.params.indexOf('limit')]).toBe(inventoryLimit);
        const metadata = trace.records.filter(isEditionMetadata);
        expect([...new Set(metadata.map(({ parameters }) => parameters[1]))].sort()).toEqual(rawIds);
        for (const id of rawIds) {
          // Each owning read has one initial and two final exact metadata points.
          expect(metadata.filter(({ parameters }) => parameters[1] === id).length).toBeLessThanOrEqual(6);
          expect(preparedIds.filter((candidate) => candidate === id).length).toBeLessThanOrEqual(2);
        }
        if (!hidden && rawIds.length) expect(preparedIds).toHaveLength(2 * rawIds.length);
        for (const edition of result.editions) expect(Object.keys(edition).sort()).toEqual([
          'creatorAccountId', 'editionId', 'editionRevision', 'licence', 'revisionId', 'sha256', 'state', 'targetSubjectId',
        ]);
        return result;
      } finally {
        await trace.close();
        observer = undefined;
      }
    }
    let closed = false;
    return {
      native, db: database, pool, author, other, editions, selectedSource, initialIds,
      request, command, path, page, grow, observedPage,
      setCursorTime: (instant: number) => { cursorNow = instant; },
      onEditionPrepare: (callback?: () => Promise<void>) => { duringEditionPrepare = callback; },
      async close() {
        if (closed) return;
        closed = true;
        try { await observer?.close(); }
        finally {
          try { await work!.shutdown(); }
          finally {
            try { await workerClient!.close(); }
            finally { try { await database.close(); } finally { await native.close(); } }
          }
        }
      },
    };
  } catch (error) {
    try { await observer?.close(); }
    finally {
      try { await work?.shutdown(); }
      finally {
        try { await workerClient?.close(); }
        finally { try { await db?.close(); } finally { await native.close(); } }
      }
    }
    throw error;
  }
}

export function isEditionMetadata({ statement }: SqlExecution): boolean {
  return statement.includes('FROM content.edition WHERE route=$1 AND edition_id=$2');
}
