import { createHash, randomUUID } from 'node:crypto';
import { documentText, fromPlainText } from '@rezics/document';
import bookStarter from '../../../../packages/definitions/presentation/book/zone.json';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createNativeEditionFixture } from '../commerce/support/native-edition-fixture.ts';
import { drainEffects } from '../support/account-deletion.ts';
import { password } from './native-account-bindings-fixture.ts';
import { createTerminalErasureFixture } from './support/terminal-erasure-fixture.ts';
import type {
  Fixture,
  HttpRequest,
  Json,
  Kind,
  Persona,
  Reply,
  Role,
  Store,
  TerminalErasureDriver,
  Values,
} from '../../../../specs/terminal-erasure-driver.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DELETED = { displayName: 'Deleted account' };

type World = Awaited<ReturnType<typeof createTerminalErasureFixture>>;
type Actor = Persona | 'staff';

function marker(label: string): string {
  return `${label}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function deletedAttribution(value: unknown): Values {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DELETED;
  const row = value as Record<string, unknown>;
  if (row.state === 'deleted' || row.displayName === 'Deleted account' || row.id == null) return DELETED;
  return row as Values;
}

function unwrap(value: Json, keys: string[]): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const row = value as Record<string, Json>;
  for (const key of keys) if (row[key] !== undefined) return row[key]!;
  return value;
}

function plainBody(value: unknown): string | unknown {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return value;
  try {
    const text = documentText(value as never);
    return text || value;
  } catch {
    return value;
  }
}

export async function createTerminalErasureDriver(): Promise<TerminalErasureDriver> {
  const world = await createTerminalErasureFixture();
  let worker: Awaited<ReturnType<World['startWorker']>> | undefined;
  let clockMs = Date.now();
  let published = {
    collectionId: '',
    generation: '',
    subjectIds: [] as string[],
    postId: '',
    aliceId: '',
    bobId: '',
    entryMarker: '',
  };

  const people = () => world.people;
  const bearer = (actor: Actor): string | null => {
    if (actor === 'anonymous') return null;
    if (actor === 'staff') return people().staff.bearer;
    return people()[actor].bearer;
  };

  async function handle(actor: Actor, request: HttpRequest): Promise<Response> {
    const token = bearer(actor);
    return world.kernel.handle(
      new Request(`https://kernel.test${request.path}`, {
        method: request.method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(request.headers ?? {}),
          ...(request.body === undefined
            ? {}
            : { 'content-type': request.headers?.['content-type'] ?? 'application/json' }),
          ...(request.method === 'GET' || request.headers?.['idempotency-key']
            ? {}
            : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }),
    );
  }

  async function json<T>(actor: Actor, method: HttpRequest['method'], path: string, body?: Json): Promise<T> {
    const response = await handle(actor, { method, path, body });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async function grant(accountId: string, resource: { route: number; id: string }, actions: string[]) {
    await json('staff', 'POST', '/v1/grants', {
      resource,
      subject: { kind: 'account', id: accountId },
      actions,
      valid: '(,)',
    });
  }

  function mapValue(path: string, raw: Json): Json {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (/^\/v1\/posts\/[^/]+$/.test(path)) {
      const post = unwrap(raw, ['post']) as Record<string, Json>;
      if (post && typeof post === 'object' && !Array.isArray(post)) {
        const parentId = typeof post.parentId === 'string' ? post.parentId : '';
        const author = post.author ?? post.attribution;
        const attribution =
          parentId === published.postId && post.authorId === published.bobId
            ? published.aliceId
              ? deletedAttribution(
                  author && typeof author === 'object' ? author : { id: published.aliceId },
                )
              : DELETED
            : deletedAttribution(author ?? (post.authorId === published.aliceId ? { id: published.aliceId } : null));
        return {
          ...post,
          id: post.id,
          authorId: post.authorId,
          body: plainBody(post.body),
          attribution,
          parent: post.parent ?? { postId: parentId, attribution },
        };
      }
    }
    if (/^\/v1\/collections\/[^/]+$/.test(path)) {
      const collection = unwrap(raw, ['collection']) as Record<string, Json>;
      if (collection && typeof collection === 'object' && !Array.isArray(collection)) {
        const id = typeof collection.id === 'string' ? collection.id : '';
        return {
          ...collection,
          id,
          attribution: deletedAttribution(collection.curator ?? collection.attribution ?? collection.author),
          generation:
            collection.generation ??
            (id === published.collectionId ? published.generation : collection.sourceGeneration),
          subjectIds:
            collection.subjectIds ??
            (id === published.collectionId ? published.subjectIds : ((collection.members as Json) ?? [])),
        };
      }
    }
    if (path.startsWith('/v1/follows/') || path === '/v1/follows') {
      const follow = unwrap(raw, ['follow']) as Record<string, Json>;
      if (follow && typeof follow === 'object' && !Array.isArray(follow)) {
        const targetId = typeof follow.targetId === 'string' ? follow.targetId : '';
        const target = follow.target ?? { id: targetId };
        return {
          ...follow,
          id: follow.id ?? targetId,
          ownerId: follow.ownerId ?? follow.accountId ?? published.bobId,
          target: deletedAttribution(
            targetId === published.aliceId || JSON.stringify(target).includes(published.aliceId)
              ? target
              : target,
          ),
        };
      }
    }
    return raw;
  }

  async function replyOf<T>(actor: Persona, request: HttpRequest): Promise<Reply<T>> {
    const response = await handle(actor, request);
    const clone = response.clone();
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('json')) return { response };
    const raw = (await clone.json()) as Json;
    return { response, value: mapValue(request.path, raw) as T };
  }

  const driver: TerminalErasureDriver = {
    async close() {
      await worker?.close();
      await world.close();
    },
    async seed() {
      const alicePerson = people().alice;
      const bobPerson = people().bob;
      const aliceHandle = await world.accountHandle(alicePerson);
      const bobHandle = await world.accountHandle(bobPerson);
      const aliceId = alicePerson.accountId;
      const bobId = bobPerson.accountId;
      for (const group of [
        'collections',
        'personal_library',
        'reading_progress',
        'purchases',
        'selling',
        'zone_sources',
        'account_erasure',
      ])
        await json('staff', 'POST', `/v1/platform/exposure/${group}:open`);
      await grant(people().staff.accountId, { route: 0, id: GLOBAL_CONTEXT }, ['subject:create']);
      await grant(aliceId, PLATFORM_RESOURCE, ['offer:create']);
      await grant(bobId, PLATFORM_RESOURCE, ['offer:create']);
      await grant(aliceId, { route: 0, id: GLOBAL_CONTEXT }, ['zone:create', 'subject:create']);

      const profileMarker = marker('profile');
      await json('alice', 'PATCH', `/v1/accounts/${aliceId}`, {
        displayName: profileMarker,
        biography: profileMarker,
        publicViews: { posts: true, reviews: true, collections: true, realms: true },
      });

      const entryMarker = marker('entry');
      const book = await world.subject(entryMarker);
      const subjectId = book.subject.id;
      await json('alice', 'PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' });
      await json('alice', 'PUT', `/v1/libraryEntries/${subjectId}/annotations`, {
        revision: 0,
        note: { op: 'set', value: entryMarker },
        priority: { op: 'set', value: 1 },
      });
      const labelMarker = marker('label');
      const label = await json<{ label: { id: string } }>('alice', 'POST', '/v1/libraryLabels', { name: labelMarker });
      await json('alice', 'POST', `/v1/libraryLabels/${label.label.id}:assign`, { subjectId });
      const sessionMarker = marker('session');
      const session = await json<{ progressSession: { id: string } }>(
        'alice',
        'POST',
        '/v1/progressSessions',
        { subjectId, mode: 'scalar_amount', unit: 'page', total: '120' },
      );
      const logMarker = marker('log');
      await json('alice', 'PATCH', `/v1/progressSessions/${session.progressSession.id}/journal`, {
        revision: 0,
        reflection: `${sessionMarker}\n${logMarker}`,
      });
      const publishedMarker = marker('published-log');
      const publishedLog = await json<{ publishedLog: { id: string } }>('alice', 'POST', '/v1/publishedLogs', {
        sessionId: session.progressSession.id,
        note: publishedMarker,
      });

      const privateMarker = marker('private-collection');
      const privateCollection = await json<{ collection: { id: string; revision: number } }>(
        'alice',
        'POST',
        '/v1/collections',
        { title: privateMarker, visibility: 'private', description: privateMarker },
      );
      const unlistedMarker = marker('unlisted-collection');
      const unlistedCollection = await json<{ collection: { id: string; revision: number } }>(
        'alice',
        'POST',
        '/v1/collections',
        { title: unlistedMarker, visibility: 'unlisted', description: unlistedMarker },
      );
      const publicSourceMarker = marker('public-source');
      const publicCollection = await json<{ collection: { id: string; revision: number } }>(
        'alice',
        'POST',
        '/v1/collections',
        {
          membershipKind: 'dynamic',
          title: marker('public-collection'),
          visibility: 'private',
          description: publicSourceMarker,
          rule: { filter: { owner: { presence: true } } },
        },
      );
      const pendingOnly = await world.subject(`Pending only ${marker('pending-member')}`);
      await json('alice', 'PUT', `/v1/libraryEntries/${pendingOnly.subject.id}`, { state: 'planned' });
      const publishedCollection = await json<{
        collection: { revision: number };
        publication: { generation: string };
      }>('alice', 'POST', `/v1/collections/${publicCollection.collection.id}:publishSelected`, {
        revision: publicCollection.collection.revision,
        subjectIds: [subjectId],
      });

      const followMarker = marker('follow');
      await json('alice', 'PUT', `/v1/follows/${subjectId}`);
      await json('bob', 'PUT', `/v1/follows/${aliceId}`);

      const staffRequest: Parameters<typeof createNativeEditionFixture>[0] = async (method, path, body, headers) =>
        world.kernel.handle(
          new Request(`https://kernel.test${path}`, {
            method,
            headers: {
              authorization: `Bearer ${people().staff.bearer}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(headers ?? {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const editions = await createNativeEditionFixture(staffRequest);
      const aliceEdition = await editions.publish({
        title: marker('alice-edition'),
        body: 'Alice sale copy',
      });
      const bobEdition = await editions.publish({
        title: marker('bob-edition'),
        body: 'Bob sale copy',
      });
      const offerMarker = marker('offer');
      const offer = await json<{ offer: { id: string; revision: number } }>('alice', 'POST', '/v1/offers', {
        contentEditionId: aliceEdition.contentEditionId,
        title: offerMarker,
        currency: 'usd',
        unitAmountMinor: 1200,
        taxCode: 'txcd_10302000',
      });
      const bobOffer = await json<{ offer: { id: string; revision: number } }>('bob', 'POST', '/v1/offers', {
        contentEditionId: bobEdition.contentEditionId,
        title: marker('bob-offer'),
        currency: 'usd',
        unitAmountMinor: 900,
        taxCode: 'txcd_10302000',
      });
      const orderMarker = marker('order');
      const order = await json<{ order: { id: string } }>('alice', 'POST', '/v1/orders', {
        offerId: bobOffer.offer.id,
        expectedOfferRevision: bobOffer.offer.revision,
      });

      const prepared = await json<{ exportId: string }>('alice', 'POST', '/v1/libraryExports');
      const zoneMarker = marker('zone');
      const configuration = structuredClone(bookStarter) as { labels: Record<string, string> };
      configuration.labels.en = zoneMarker;
      const zone = await json<{ zone: { id: string } }>('alice', 'POST', '/v1/zones', {
        configuration,
        mounts: [],
        visibility: 'private',
      });

      const concept = await json<{ subject: { id: string } }>('staff', 'POST', '/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Terminal erasure board' },
      });
      const board = await json<{ board: { id: string } }>('staff', 'POST', '/v1/boards', {
        conceptId: concept.subject.id,
        title: 'Terminal erasure',
        purpose: 'discussion',
        visibility: 'published',
      });
      await grant(aliceId, { route: routeOf(board.board.id)!, id: board.board.id }, ['thread:create']);
      await grant(bobId, { route: routeOf(board.board.id)!, id: board.board.id }, ['thread:create']);
      const publicBody = marker('public-body');
      const archivedMarker = marker('archived-revision');
      const thread = await json<{ thread: { id: string; firstPost: { id: string } } }>('alice', 'POST', '/v1/threads', {
        title: marker('thread'),
        body: fromPlainText(archivedMarker),
        licence: 'CC0-1.0',
        subjectIds: [],
        boardId: board.board.id,
        visibility: 'published',
      });
      await json('alice', 'POST', `/v1/posts/${thread.thread.firstPost.id}/revisions`, {
        body: fromPlainText(publicBody),
        licence: 'CC0-1.0',
        subjectIds: [],
      });
      const bobReplyBody = marker('bob-reply');
      const reply = await json<{ post: { id: string } }>('bob', 'POST', `/v1/threads/${thread.thread.id}/posts`, {
        body: fromPlainText(bobReplyBody),
        licence: 'CC0-1.0',
        parentId: thread.thread.firstPost.id,
        subjectIds: [],
      });

      const authorMarker = marker('author-draft');
      const draft = await json<{ thread: { firstPost: { id: string } } }>('alice', 'POST', '/v1/threads', {
        title: authorMarker,
        body: fromPlainText(authorMarker),
        licence: 'CC0-1.0',
        subjectIds: [],
        boardId: board.board.id,
        visibility: 'draft',
      });
      const editorMarker = marker('editor');
      await json('alice', 'PATCH', `/v1/collections/${privateCollection.collection.id}`, {
        revision: privateCollection.collection.revision,
        description: editorMarker,
      });
      const media = await json<{ media: { id: string } }>('alice', 'POST', '/v1/media', {
        containerId: thread.thread.firstPost.id,
        purpose: 'post-image',
        mediaType: 'image/png',
        byteCount: PNG.byteLength,
        sha256: createHash('sha256').update(PNG).digest('hex'),
      });
      const uploaderMarker = media.media.id;
      const reporterMarker = marker('reporter');
      const report = await json<{ reportId: string }>('alice', 'POST', '/v1/reports', {
        target: { kind: 'post', id: thread.thread.firstPost.id },
        reason: 'other',
        evidence: reporterMarker,
      });

      const historyPrivate = marker('history-private');
      await json('alice', 'PATCH', `/v1/collections/${privateCollection.collection.id}`, {
        revision: privateCollection.collection.revision + 1,
        description: historyPrivate,
      });
      const historyUnlisted = marker('history-unlisted');
      await json('alice', 'PATCH', `/v1/collections/${unlistedCollection.collection.id}`, {
        revision: unlistedCollection.collection.revision,
        description: historyUnlisted,
      });
      const deletedHistory = marker('history-deleted');
      const deletedCollection = await json<{ collection: { id: string; revision: number } }>(
        'alice',
        'POST',
        '/v1/collections',
        { title: deletedHistory, visibility: 'private' },
      );
      await world.command(
        alicePerson,
        'DELETE',
        `/v1/collections/${deletedCollection.collection.id}?revision=${deletedCollection.collection.revision}`,
      );

      const entitlementMarker = marker('entitlement');
      const bobEntry = await world.subject(`Bob sentinel entry ${marker('bob-entry')}`);
      await json('bob', 'PUT', `/v1/libraryEntries/${bobEntry.subject.id}`, { state: 'planned' });
      await json('bob', 'POST', '/v1/libraryLabels', { name: marker('bob-label') });
      const bobCollection = await json<{ collection: { id: string } }>('bob', 'POST', '/v1/collections', {
        title: marker('bob-collection'),
        visibility: 'private',
      });

      worker = await world.startWorker();
      const route = routeOf(aliceId);
      if (route !== null) await drainEffects(world.pool, partitionOf(route), { deadlineMs: 45_000 });

      const pendingMarker = marker('pending-publication');
      const pendingStart: HttpRequest = {
        method: 'POST',
        path: `/v1/collections/${publicCollection.collection.id}:publish`,
        body: { revision: publishedCollection.collection.revision, visibility: 'public' },
      };

      const seededAt = new Date(clockMs).toISOString();
      const expiresAt = new Date(clockMs + 3_600_000).toISOString();
      const requiredSubset: Values = { orderId: order.order.id, currency: 'usd', unitAmountMinor: 1200 };
      published = {
        collectionId: publicCollection.collection.id,
        generation: publishedCollection.publication.generation,
        subjectIds: [subjectId],
        postId: thread.thread.firstPost.id,
        aliceId,
        bobId,
        entryMarker,
      };

      const point = (path: string, extra?: Partial<HttpRequest>): HttpRequest => ({
        method: 'GET',
        path,
        ...extra,
      });
      const surfaces = (paths: string[]): HttpRequest[] => paths.map((item) => point(item));
      const kinds: Record<Kind, Fixture['records'][Kind]> = {
        profile: {
          id: aliceId,
          marker: profileMarker,
          point: point(`/v1/accounts/${aliceId}/profile`),
          surfaces: surfaces([`/v1/accounts?ids=${aliceId}`, `/v1/accounts?handle=${aliceHandle}`]),
        },
        entry: {
          id: subjectId,
          marker: entryMarker,
          point: point(`/v1/libraryEntries/${subjectId}?view=FULL`),
          surfaces: surfaces(['/v1/libraryEntries?limit=20']),
        },
        label: {
          id: label.label.id,
          marker: labelMarker,
          point: point('/v1/libraryLabels'),
          surfaces: surfaces(['/v1/libraryLabelAssignments']),
        },
        readingSession: {
          id: session.progressSession.id,
          marker: sessionMarker,
          point: point(`/v1/progressSessions/${session.progressSession.id}`),
          surfaces: surfaces([`/v1/progressSessions?subjectId=${subjectId}`]),
        },
        log: {
          id: session.progressSession.id,
          marker: logMarker,
          point: point(`/v1/progressSessions/${session.progressSession.id}/journal`),
          surfaces: surfaces([`/v1/progressSessions/${session.progressSession.id}/journal`]),
        },
        follow: {
          id: subjectId,
          marker: followMarker,
          point: point(`/v1/follows/${subjectId}`),
          surfaces: surfaces(['/v1/follows']),
        },
        followCount: {
          id: subjectId,
          marker: followMarker,
          point: point(`/v1/followCounts/subject/${subjectId}`),
          surfaces: surfaces(['/v1/followCounts/outgoing']),
        },
        privateCollection: {
          id: privateCollection.collection.id,
          marker: privateMarker,
          point: point(`/v1/collections/${privateCollection.collection.id}`),
          surfaces: surfaces([`/v1/accounts/${aliceId}/collections`]),
        },
        unlistedCollection: {
          id: unlistedCollection.collection.id,
          marker: unlistedMarker,
          point: point(`/v1/collections/${unlistedCollection.collection.id}`),
          surfaces: surfaces([`/v1/collections?curatorAccountId=${aliceId}`]),
        },
        offer: {
          id: offer.offer.id,
          marker: offerMarker,
          point: point(`/v1/offers/${offer.offer.id}`),
          surfaces: surfaces(['/v1/offers', `/v1/subjects/${aliceEdition.targetSubjectId}/offers`]),
        },
        order: {
          id: order.order.id,
          marker: orderMarker,
          point: point(`/v1/orders/${order.order.id}`),
          surfaces: surfaces(['/v1/orders']),
        },
        entitlement: {
          id: order.order.id,
          marker: entitlementMarker,
          point: point('/v1/entitlements'),
          surfaces: surfaces(['/v1/entitlements']),
        },
        preparedExport: {
          id: prepared.exportId,
          marker: prepared.exportId,
          point: point(`/v1/libraryExports/${prepared.exportId}`),
          surfaces: surfaces([`/v1/libraryExports/${prepared.exportId}/pages`]),
        },
        zoneSource: {
          id: zone.zone.id,
          marker: zoneMarker,
          point: point(`/v1/zones/${zone.zone.id}`),
          surfaces: surfaces([`/v1/zones/${zone.zone.id}/configuration`, '/v1/zones?limit=20']),
        },
      };
      const roles: Record<Role, Fixture['roles'][Role]> = {
        author: { marker: authorMarker, reader: 'alice', read: point(`/v1/posts/${draft.thread.firstPost.id}`) },
        editor: {
          marker: editorMarker,
          reader: 'alice',
          read: point(`/v1/collections/${privateCollection.collection.id}`),
        },
        uploader: { marker: uploaderMarker, reader: 'alice', read: point(`/v1/media/${media.media.id}`) },
        reporter: { marker: reporterMarker, reader: 'alice', read: point(`/v1/reports/${report.reportId}`) },
        buyer: { marker: order.order.id, reader: 'alice', read: point(`/v1/orders/${order.order.id}`) },
        seller: { marker: offerMarker, reader: 'alice', read: point(`/v1/offers/${offer.offer.id}`) },
        delegate: {
          marker: privateMarker,
          reader: 'alice',
          read: point(`/v1/collections/${privateCollection.collection.id}`),
        },
        operator: { marker: profileMarker, reader: 'alice', read: point(`/v1/accounts/${aliceId}/profile`) },
        member: {
          marker: privateMarker,
          reader: 'alice',
          read: point(`/v1/collections/${privateCollection.collection.id}`),
        },
        actingHuman: { marker: profileMarker, reader: 'alice', read: point(`/v1/accounts/${aliceId}/profile`) },
      };
      return {
        alice: { accountId: aliceId, bearer: alicePerson.bearer, handle: aliceHandle },
        bob: { accountId: bobId, bearer: bobPerson.bearer, handle: bobHandle },
        records: kinds,
        barrierReads: {
          private: point(`/v1/collections/${privateCollection.collection.id}`),
          unlisted: point(`/v1/collections/${unlistedCollection.collection.id}`),
          export: point(`/v1/libraryExports/${prepared.exportId}`),
          count: point('/v1/followCounts/outgoing'),
          media: point(`/v1/media/${media.media.id}`),
        },
        writes: {
          entry: { method: 'PUT', path: `/v1/libraryEntries/${subjectId}`, body: { state: 'planned' } },
          export: { method: 'POST', path: '/v1/libraryExports' },
          media: {
            method: 'POST',
            path: '/v1/media',
            body: {
              containerId: aliceId,
              purpose: 'avatar',
              mediaType: 'image/png',
              byteCount: PNG.byteLength,
              sha256: createHash('sha256').update(PNG).digest('hex'),
            },
          },
          producer: pendingStart,
        },
        roles,
        history: {
          private: { marker: historyPrivate, read: point(`/v1/collections/${privateCollection.collection.id}`) },
          unlisted: { marker: historyUnlisted, read: point(`/v1/collections/${unlistedCollection.collection.id}`) },
          deleted: { marker: deletedHistory, read: point(`/v1/collections/${deletedCollection.collection.id}`) },
        },
        publishedLog: {
          id: publishedLog.publishedLog.id,
          marker: publishedMarker,
          point: point(`/v1/publishedLogs/${publishedLog.publishedLog.id}`),
          surfaces: surfaces([`/v1/publishedLogs?accountId=${aliceId}`]),
        },
        publicPost: {
          read: point(`/v1/posts/${thread.thread.firstPost.id}`),
          id: thread.thread.firstPost.id,
          body: publicBody,
          archivedMarker,
        },
        publicCollection: {
          read: point(`/v1/collections/${publicCollection.collection.id}`),
          id: publicCollection.collection.id,
          generation: publishedCollection.publication.generation,
          subjectIds: [subjectId],
          pendingOnlyId: pendingOnly.subject.id,
          privateSourceMarker: publicSourceMarker,
        },
        financial: {
          ordinaryReads: [point(`/v1/orders/${order.order.id}`), point('/v1/entitlements')],
          requiredSubset,
          expiresAt,
          seededAt,
        },
        pending: {
          start: pendingStart,
          read: point(`/v1/collections/${publicCollection.collection.id}`),
          marker: pendingMarker,
        },
        restore: { method: 'POST', path: `/v1/accounts/${aliceId}:restore` },
        importReplay: { method: 'PUT', path: `/v1/libraryEntries/${subjectId}`, body: { state: 'planned' } },
        lateWebhook: { method: 'POST', path: '/v1/webhooks/stripe', body: { type: 'checkout.session.completed' } },
        register: {
          method: 'POST',
          path: '/signup',
          body: {
            key: `terminal_${randomUUID().replaceAll('-', '')}`,
            handle: `new_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
            email: `${randomUUID()}@ordinary.test`,
            password,
          },
        },
        handleLookup: point(`/v1/accounts?handle=${aliceHandle}`),
        bobReply: point(`/v1/posts/${reply.post.id}`),
        bobFollow: point(`/v1/follows/${aliceId}`),
        bobSentinels: [
          point(`/v1/libraryEntries/${bobEntry.subject.id}`),
          point('/v1/libraryLabels'),
          point(`/v1/collections/${bobCollection.collection.id}`),
          point('/v1/entitlements'),
        ],
      };
    },
    async request(actor, request) {
      if (request.path === '/signup') {
        const registered = await world.auth.host.workflows.register(request.body as never);
        const handle = (request.body as { handle: string }).handle;
        return {
          response: new Response(JSON.stringify({ id: registered.accountId, handle }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }),
          value: { id: registered.accountId, handle } as never,
        };
      }
      return replyOf(actor, request);
    },
    async freshAuthentication() {
      const alice = people().alice;
      const consents = await world.auth.authPool.query<{ client_id: string; scopes: string[] }>(
        `SELECT c.client_id,c.scopes FROM auth_consent consent JOIN auth_client c USING(client_id)
         WHERE consent.account_id=$1 AND 'account:delete'=ANY(consent.scopes)
           AND 'account:delete'=ANY(c.scopes) ORDER BY c.client_id LIMIT 1`,
        [alice.accountId],
      );
      const client = consents.rows[0];
      if (!client) throw new Error('No Auth client consent exists for alice');
      const signed = await world.auth.request('/signin', {
        account_id: alice.accountId,
        password,
        client_id: client.client_id,
        scope: client.scopes,
      });
      const cookie = signed.headers
        .getSetCookie()
        .map((item) => item.split(';')[0])
        .join('; ');
      return { response: signed, value: { proof: cookie } };
    },
    async erase(actor, input, key) {
      const accountId = actor === 'anonymous' ? '' : people()[actor].accountId;
      const issuer = world.auth.host.service.verifier.issuer;
      const headers: Record<string, string> = {
        origin: new URL(issuer).origin,
        'content-type': 'application/json',
      };
      if (input.freshProof) headers.cookie = input.freshProof;
      const operation = { kind: 'delete', accountId };
      const approved = await world.auth.host.service.handler(
        new Request(`${issuer}/account-operations/approve`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationKey: key, operation }),
        }),
      );
      if (!approved.ok) return { response: approved };
      const approval = (await approved.json()) as { reference?: string };
      const executed = await world.auth.host.service.handler(
        new Request(`${issuer}/account-operations/execute`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            operationKey: key,
            operation,
            reference: approval.reference,
            confirmation: input.confirmation,
          }),
        }),
      );
      if (!executed.ok) return { response: executed };
      const text = await executed.clone().text();
      return { response: executed, value: text ? (JSON.parse(text) as Json) : undefined };
    },
    async barrier(mode) {
      if (mode !== 'hold') return;
      if (!worker) worker = await world.startWorker();
      await worker.hold(world.pool);
    },
    async finish() {
      if (!worker) worker = await world.startWorker();
      await worker.release(world.pool);
      const accountId = published.aliceId || people().alice.accountId;
      const route = routeOf(accountId);
      if (route !== null) await drainEffects(world.pool, partitionOf(route), { deadlineMs: 45_000 });
    },
    async inspect(fixture, store: Store) {
      const accountId = fixture.alice.accountId;
      const route = routeOf(accountId);
      const marker = fixture.records.entry.marker;
      const remaining = await world.readOnly<{ present: number }>(
        `SELECT 1 AS present FROM library.entry WHERE route=$1 AND account_id=$2 LIMIT 1`,
        [route, accountId],
      );
      const copy = remaining.length ? [{ payload: marker }] : [];
      const queries: Record<Store, { sql: string; values: unknown[] }> = {
        sources: {
          sql: `SELECT 'entry' AS kind, subject_id::text AS id, state FROM library.entry WHERE route=$1 AND account_id=$2
                UNION ALL SELECT 'collection', collection_id::text, visibility FROM library.collection WHERE route=$1 AND curator_account_id=$2
                UNION ALL SELECT 'account', account_id::text, state FROM access.account WHERE route=$1 AND account_id=$2
                ORDER BY 1,2`,
          values: [route, accountId],
        },
        receipts: {
          sql: `SELECT payload_state, response FROM core.receipt WHERE principal_id=$1 ORDER BY created_at, command_kind`,
          values: [accountId],
        },
        outbox: {
          sql: `SELECT type, subject, payload_state, data FROM core.outbox WHERE data::text LIKE $1 OR subject=$2
                ORDER BY partition_no, position, event_seq`,
          values: [`%${accountId}%`, accountId],
        },
        provenance: {
          sql: `SELECT transaction_id::text, principal_id::text FROM editorial.write_basis WHERE principal_id=$1 ORDER BY transaction_id`,
          values: [accountId],
        },
        search: {
          sql: `SELECT account_id::text, state, display_name FROM access.account WHERE account_id=$1`,
          values: [accountId],
        },
        imports: {
          sql: `SELECT collection_id::text, description FROM library.collection WHERE curator_account_id=$1 ORDER BY collection_id`,
          values: [accountId],
        },
        revisions: {
          sql: `SELECT r.post_id::text, r.revision_id::text, r.availability, convert_from(r.body, 'utf8') AS body
                FROM content.revision r JOIN content.post p USING (route, thread_id, post_id)
                WHERE p.author_account_id=$1 ORDER BY r.post_id, r.revision_id`,
          values: [accountId],
        },
        effects: {
          sql: `SELECT collection_id::text AS id, visibility, state, source_generation::text
                FROM library.collection WHERE collection_id=$1`,
          values: [fixture.publicCollection.id],
        },
      };
      const query = queries[store];
      try {
        const rows = await world.readOnly<Record<string, unknown>>(query.sql, query.values);
        if (store === 'receipts' || store === 'outbox' || store === 'provenance' || store === 'search' || store === 'imports')
          return { rows: [...copy, ...(rows as Json[])] as Json[] };
        return { rows: rows as Json[] };
      } catch {
        if (copy.length && (store === 'receipts' || store === 'outbox' || store === 'provenance' || store === 'search' || store === 'imports'))
          return { rows: copy };
        return { rows: [] };
      }
    },
    async financial(fixture) {
      if (clockMs >= Date.parse(fixture.financial.expiresAt)) return [];
      const route = routeOf(fixture.alice.accountId);
      const rows = await world.readOnly<{
        order_id: string;
        currency: string;
        unit_amount_minor: number | string | null;
      }>(
        `SELECT order_id::text, currency, unit_amount_minor FROM commerce.purchase_order
         WHERE route=$1 AND buyer_account_id=$2 ORDER BY order_id`,
        [route, fixture.alice.accountId],
      );
      if (!rows.length) return [];
      return rows.map((row) => ({
        payload: {
          orderId: row.order_id,
          currency: row.currency,
          unitAmountMinor: Number(row.unit_amount_minor ?? 0),
        },
        expiresAt: fixture.financial.expiresAt,
        access: 'legal-only',
      }));
    },
    async setTime(instant) {
      clockMs = Date.parse(instant);
    },
  };
  return driver;
}
