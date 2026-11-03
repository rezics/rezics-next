import { expect } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { bootstrapGovernance } from '../../../src/access/bootstrap-governance.ts';
import { createGrantCommands } from '../../../src/access/grant-commands.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import permission from '../../../src/access/permission-check.sql';
import { revisePost } from '../../../src/content/commands.ts';
import type { ContentEditionRevisionView } from '../../../src/content/edition-model.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { cookies, nativeFixture, password } from '../../access/native-account-bindings-fixture.ts';
import { openGrowthDatabase, seed, type Population } from '../../support/growth.ts';
import { registerTestClient, testKernel, testRouteKey } from '../../support/test-kernel.ts';
import { observeSql, permissionResourceId, type SqlExecution } from './sql-observer.ts';

type Person = { accountId: string; bearer: string };
type Post = { id: string; revisionId: string; sha256: string };
export type Selection = {
  threadId: string;
  ancestors: readonly string[];
  post: Post;
  editionId: string;
  expected: ContentEditionRevisionView;
  bytes: Buffer;
};
export type DeliveryAxis = 'unrelated' | 'source-history' | 'recipient-grants' | 'publisher-grants';
export const deliveryAxes: readonly DeliveryAxis[] = [
  'unrelated',
  'source-history',
  'recipient-grants',
  'publisher-grants',
];

/** All selected identities, bindings, grants, receipts and publication are native commands.
 * Auth's registered host and its consent/restoration queries use the same capture state.
 */
export async function growthEditionRevisionDeliveryFixture() {
  const db = await openGrowthDatabase();
  let auth: Awaited<ReturnType<typeof nativeFixture>> | undefined;
  let observer: ReturnType<typeof observeSql> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await observer?.close();
      } finally {
        try {
          await auth?.close();
        } finally {
          await db.close();
        }
      }
    })());
  try {
    auth = await nativeFixture(db.pool, () => db.openPool({ max: 4 }));
    const native = auth;
    const consent = createCurrentConsentReader({ database: native.authPool });
    const authConfig = {
      ...native.host.service.verifier,
      fetch: (url: string | URL, init?: RequestInit) => native.host.service.handler(new Request(url, init)),
    };
    const content = {
      readConsent: ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
        consent.readCurrentConsent({ actorAccountId, clientId }),
    };
    const writeRate = createWriteRateLimiter({ secret: 'edition-delivery-native-write-rate-secret-32-bytes' });
    const app = testKernel({ pool: db.pool, auth: authConfig, content, writeRate });
    // Mutations racing disclosure use a different checkout and observer, with ordinary Access.
    const mutationPool = db.openPool({ max: 2 });
    const mutationApp = testKernel({ pool: mutationPool, auth: authConfig, content, writeRate });
    const scopes = [...actionCatalogue(app).keys()].filter((action) => action !== 'media:complete').sort();
    const clientId = `edition_growth_${randomUUID()}`;
    await registerTestClient(native.host.service, { clientId, firstParty: true, scopes });
    async function person(label: string): Promise<Person> {
      const registered = await native.person(`edition_${label}_${randomUUID().replaceAll('-', '')}`);
      const signed = await native.request('/signin', {
        account_id: registered.accountId,
        password,
        client_id: clientId,
        scope: scopes,
      });
      expect(signed.status).toBe(200);
      const issued = await native.request('/token', {}, cookies(signed));
      expect(issued.status).toBe(200);
      return { accountId: registered.accountId, bearer: (await issued.json()).access_token as string };
    }
    const publisher = await person('publisher');
    const buyer = await person('recipient');
    const outsider = await person('nonmember');
    await bootstrapGovernance(db.pool, publisher.accountId);
    await bootstrapRelease(db.pool, bundledRelease);

    function wire(
      person: Person | null,
      path: string,
      method = 'GET',
      body?: unknown,
      version?: string,
      headers: Record<string, string> = {},
      mutation = false,
    ) {
      return (mutation ? mutationApp : app).handle(
        new Request(`https://edition.test${path}`, {
          method,
          headers: {
            ...(person ? { authorization: `Bearer ${person.bearer}` } : {}),
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
            ...(version ? { 'if-match': JSON.stringify(version) } : {}),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function value<T>(response: Promise<Response>, status: number): Promise<T> {
      const result = await response;
      const text = await result.text();
      expect({ status: result.status, error: result.status === status ? null : text }).toEqual({ status, error: null });
      return JSON.parse(text) as T;
    }
    const scheme = (
      await value<{ subject: { id: string } }>(
        wire(publisher, '/v1/subjects', 'POST', {
          type: 'skos:ConceptScheme',
          labels: { en: 'Delivery growth topics' },
        }),
        201,
      )
    ).subject.id;
    const subjectId = (
      await value<{ subject: { id: string } }>(
        wire(publisher, '/v1/subjects', 'POST', {
          type: 'skos:Concept',
          labels: { en: 'Pinned delivery source' },
          statements: {
            'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }],
          },
        }),
        201,
      )
    ).subject.id;
    const spaceId = (
      await value<{ space: { spaceId: string } }>(
        wire(publisher, '/v1/spaces', 'POST', { title: 'Delivery space' }),
        201,
      )
    ).space.spaceId;
    const realm = (
      await value<{ realm: { realmId: string; headRevisionId: string } }>(
        wire(publisher, '/v1/realms', 'POST', {
          spaceId,
          title: 'Protected delivery realm',
          visibility: 'protected',
          contextId: GLOBAL_CONTEXT,
        }),
        201,
      )
    ).realm;
    await value(
      wire(publisher, `/v1/realms/${realm.realmId}/boardScheme`, 'PUT', { schemeId: scheme }, realm.headRevisionId),
      200,
    );
    const boardId = (
      await value<{ board: { id: string } }>(
        wire(publisher, `/v1/realms/${realm.realmId}/boards`, 'POST', {
          conceptId: subjectId,
          title: 'Protected delivery board',
          visibility: 'protected',
        }),
        201,
      )
    ).board.id;
    async function grant(id: string, person: Person, actions: readonly string[], revoke = false, mutation = false) {
      await value(
        wire(
          publisher,
          `/v1/grants${revoke ? ':revoke' : ''}`,
          'POST',
          {
            resource: { route: routeOf(id)!, id },
            subject: { kind: 'account', id: person.accountId },
            actions,
            valid: '[2025-01-01T00:00:00Z,)',
          },
          undefined,
          {},
          mutation,
        ),
        revoke ? 200 : 201,
      );
    }
    await grant(realm.realmId, buyer, ['realm:read']);
    await grant(boardId, buyer, ['board:read']);
    // The fixture deliberately supplies no membership or source-post grant to the non-member.
    const body = fromPlainText('Pinned canonical edition bytes across native delivery growth.');
    const bytes = Buffer.from(serializeDocument(body));
    const digest = createHash('sha256').update(bytes).digest('hex');
    async function selection(): Promise<Selection> {
      const thread = (
        await value<{ thread: { id: string; firstPost: Post } }>(
          wire(publisher, '/v1/threads', 'POST', {
            title: 'Native delivery ancestry',
            body: fromPlainText('Opening ancestor'),
            licence: 'CC0-1.0',
            subjectIds: [subjectId],
            boardId,
            visibility: 'published',
          }),
          201,
        )
      ).thread;
      const parent = (
        await value<{ post: Post }>(
          wire(publisher, `/v1/threads/${thread.id}/posts`, 'POST', {
            parentId: thread.firstPost.id,
            body: fromPlainText('Independent parent'),
            licence: 'CC0-1.0',
          }),
          201,
        )
      ).post;
      const post = (
        await value<{ post: Post }>(
          wire(publisher, `/v1/threads/${thread.id}/posts`, 'POST', {
            parentId: parent.id,
            body,
            licence: 'CC0-1.0',
            subjectIds: [subjectId],
          }),
          201,
        )
      ).post;
      const draft = await value<{ editionId: string }>(
        wire(publisher, '/v1/contentEditions', 'POST', {
          postId: post.id,
          revisionId: post.revisionId,
          targetSubjectId: subjectId,
        }),
        201,
      );
      await value(wire(publisher, `/v1/contentEditions/${draft.editionId}:publish`, 'POST', {}, '1'), 200);
      await grant(draft.editionId, buyer, ['edition:read']);
      await grant(draft.editionId, outsider, ['edition:read']);
      expect(post.sha256).toBe(digest);
      return {
        threadId: thread.id,
        ancestors: [parent.id, thread.firstPost.id],
        post,
        editionId: draft.editionId,
        bytes,
        expected: { editionId: draft.editionId, revisionId: post.revisionId, sha256: digest, licence: 'CC0-1.0', body },
      };
    }
    const selected = await selection();
    const unrelated = await selection();
    const actor = await app.testAccess.authenticate(publisher.bearer, { pool: db.pool, deadline: Date.now() + 10_000 });
    const grants = createGrantCommands({ pool: db.pool, access: app.testAccess, managementAction: 'access:grant' });
    let head = selected.post.revisionId;
    function observe() {
      observer = observeSql(db.pool);
      return observer;
    }
    function pressure(): Population {
      const route = routeOf(unrelated.post.id)!;
      return {
        name: 'Unrelated edition and revision delivery pressure',
        hotPartition: partitionOf(route),
        hotShare: 1,
        rows() {
          const revisionId = newId(route);
          return {
            'content.revision': [
              {
                route,
                thread_id: unrelated.threadId,
                post_id: unrelated.post.id,
                revision_id: revisionId,
                body: bytes,
                body_sha256: Buffer.from(digest, 'hex'),
                search_text: 'unrelated revision',
                licence: 'CC0-1.0',
                subject_ids: [subjectId],
                board_id: boardId,
                availability: 'available',
                recorded_transaction_id: randomUUID(),
                media_ids: [],
              },
            ],
            'content.edition': [
              {
                route,
                edition_id: newId(route),
                creator_account_id: publisher.accountId,
                target_subject_id: subjectId,
                thread_id: unrelated.threadId,
                post_id: unrelated.post.id,
                revision_id: revisionId,
                body_sha256: Buffer.from(digest, 'hex'),
                licence: 'CC0-1.0',
                state: 'draft',
                security_revision: 1,
                recorded_transaction_id: randomUUID(),
                created_at: new Date(),
              },
            ],
          };
        },
      };
    }
    async function grow(axis: DeliveryAxis, scale: number, previous: number) {
      if (axis === 'unrelated') {
        await seed(db, pressure(), { from: previous, to: scale });
        return;
      }
      for (let i = previous; i < scale; i++) {
        const key = randomUUID();
        if (axis === 'source-history') {
          const outcome = await revisePost(
            { pool: db.pool, access: app.testAccess, routeKey: testRouteKey() },
            actor,
            {
              threadId: selected.threadId,
              itemId: selected.post.id,
              expectedRevisionId: head,
              body: fromPlainText(`Later head ${i}; never the pinned body`),
            },
            { idempotencyKey: key, requestId: key, deadline: Date.now() + 10_000 },
          );
          head = outcome.value.revisionId;
        } else {
          const start = new Date(Date.UTC(2000, 0, 1) + i * 2000).toISOString();
          const end = new Date(Date.UTC(2000, 0, 1) + i * 2000 + 1000).toISOString();
          const recipient = axis === 'recipient-grants';
          const id = recipient ? selected.editionId : selected.post.id;
          await grants.create(
            { pool: db.pool, actor, deadline: Date.now() + 10_000 },
            {
              resource: { route: routeOf(id)!, id },
              subject: { kind: 'account', id: recipient ? buyer.accountId : publisher.accountId },
              actions: [recipient ? 'edition:read' : 'post:revise'],
              valid: `[${start},${end})`,
              key,
            },
          );
        }
      }
    }
    async function pinned(selection: Selection) {
      const result = await db.admin.query<{ body: Buffer }>(
        'SELECT body FROM content.revision WHERE route=$1 AND revision_id=$2',
        [routeOf(selection.post.id), selection.post.revisionId],
      );
      expect(result.rows[0]!.body.equals(selection.bytes)).toBe(true);
    }
    async function noPostGrant(selection: Selection) {
      const rows = await db.admin.query(
        "SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='post:read'",
        [routeOf(selection.post.id), selection.post.id, buyer.accountId],
      );
      expect(rows.rows).toEqual([]);
    }
    return {
      db,
      native,
      app,
      publisher,
      buyer,
      outsider,
      realmId: realm.realmId,
      spaceId,
      boardId,
      subjectId,
      selected,
      wire,
      value,
      selection,
      grow,
      grant,
      pinned,
      noPostGrant,
      observe,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function permissionExecutions(records: readonly SqlExecution[], actor: string, action: string, id: string) {
  return records.filter(
    (row) =>
      row.statement === permission.sql &&
      row.parameters[permission.params.indexOf('actor_id')] === actor &&
      row.parameters[permission.params.indexOf('action')] === action &&
      permissionResourceId(row, permission.params) === id,
  );
}

/** Select a released boundary before the snapshot containing the last actual guard.
 * Calibrate on real SQL, never replace Access or a source reader with a callback.
 */
export function finalGuardBoundary(records: readonly SqlExecution[], actor: string, action: string, id: string) {
  const last = permissionExecutions(records, actor, action, id).at(-1);
  if (!last) throw new Error(`Native final guard absent: ${action} ${id}`);
  const index = records.indexOf(last);
  const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
  const before = records.slice(0, index);
  const boundary = before.findLastIndex((row) => row.statement === begin && row.connectionId === last.connectionId);
  if (boundary < 0) throw new Error(`Native final guard snapshot absent: ${action}`);
  return {
    statement: begin,
    occurrence: records.slice(0, boundary + 1).filter((row) => row.statement === begin).length,
  };
}
