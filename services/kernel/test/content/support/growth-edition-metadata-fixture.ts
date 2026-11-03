import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import type { ContentEditionView } from '../../../src/content/edition-model.ts';
import { openGrowthDatabase, seed, type GrowthDatabase } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { createContentSystem, contentGovernanceCredential, type ContentCredential } from './system.ts';

export const metadataScales = [256, 1024, 4096] as const;
export const metadataAxes = [
  'editions',
  'post revisions',
  'subject history',
  'Realm history',
  'grant history',
] as const;
export type MetadataAxis = (typeof metadataAxes)[number];
export type EditionKey = { editionId: string; editionRevision: string };
type Source = { id: string; revisionId: string; sha256: string };
// Disjoint expired ranges can grow under the same resource/subject/action key.
const currentGrant = '[2026-01-01T00:00:00Z,)';

/** Owns only private composition. All selected state is produced by native HTTP commands. */
export async function editionMetadataFixture() {
  const native = await createContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  let db: GrowthDatabase | undefined;
  try {
    await bootstrapRelease(native.database.pool, bundledRelease);
    db = await openGrowthDatabase(native.database.pool.options.connectionString);
    const database = db;
    const consent = createCurrentConsentReader({ database: native.database.authPool });
    const compose = (pool: typeof database.pool) =>
      createKernel({
        pool,
        access: native.access,
        routeKey: native.routeKey,
        tokens: native.tokenKeys,
        receiptKeys: testReceiptKeys(),
        // Ordinary production rate admission, configured for unobserved 4096-command setup.
        writeRate: createWriteRateLimiter({
          secret: randomUUID() + randomUUID(),
          overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
        }),
        content: {
          readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
        },
      });
    const kernel = compose(database.pool);
    const mutationKernel = compose(native.database.pool);
    const creator = native.actors.author;
    const reader = native.actors.other;
    const outsider = native.actors.moderator;
    const governor = await contentGovernanceCredential(native);
    async function request(
      actor: ContentCredential,
      path: string,
      method = 'GET',
      body?: unknown,
      version?: string,
      headers: Record<string, string> = {},
      app: Kernel = mutationKernel,
    ) {
      return app.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${actor.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(randomUUID()),
            ...(version === undefined ? {} : { 'if-match': JSON.stringify(version) }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    }
    async function checked<T>(
      actor: ContentCredential,
      path: string,
      method: string,
      body: unknown,
      status: number,
      version?: string,
    ): Promise<T> {
      const response = await request(actor, path, method, body, version);
      const text = await response.text();
      if (response.status !== status) throw new Error(`${method} ${path}: ${response.status} ${text}`);
      return JSON.parse(text) as T;
    }
    async function grant(actor: ContentCredential, resourceId: string, actions: string[], valid = '(,)') {
      const input = {
        resource: { route: routeOf(resourceId)!, id: resourceId },
        subject: { kind: 'account', id: actor.actor.accountId },
        actions,
        valid,
      };
      await checked(governor, '/v1/grants', 'POST', input, 201);
      return input;
    }
    const scheme = await checked<{ subject: { id: string } }>(
      creator,
      '/v1/subjects',
      'POST',
      {
        type: 'skos:ConceptScheme',
        labels: { en: 'Edition topics' },
      },
      201,
    );
    const concept = await checked<{ subject: { id: string } }>(
      creator,
      '/v1/subjects',
      'POST',
      {
        type: 'skos:Concept',
        labels: { en: 'Edition label 0000' },
        statements: {
          'skos:inScheme': [
            {
              property: { id: 'skos:inScheme' },
              value: { type: 'value', content: scheme.subject.id },
            },
          ],
        },
      },
      201,
    );
    const subjectId = concept.subject.id;
    const { space } = await checked<{ space: { spaceId: string } }>(
      creator,
      '/v1/spaces',
      'POST',
      {
        title: 'Edition home',
      },
      201,
    );
    const { realm } = await checked<{ realm: { realmId: string; headRevisionId: string } }>(
      creator,
      '/v1/realms',
      'POST',
      {
        spaceId: space.spaceId,
        title: 'Edition realm',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      },
      201,
    );
    await checked(
      creator,
      `/v1/realms/${realm.realmId}/boardScheme`,
      'PUT',
      {
        schemeId: scheme.subject.id,
      },
      200,
      realm.headRevisionId,
    );
    const { board } = await checked<{ board: { id: string } }>(
      creator,
      `/v1/realms/${realm.realmId}/boards`,
      'POST',
      {
        conceptId: subjectId,
        title: 'Edition board',
        visibility: 'published',
      },
      201,
    );
    const body = fromPlainText('Pinned edition body');
    const { thread } = await checked<{ thread: { id: string; firstPost: Source } }>(
      creator,
      '/v1/threads',
      'POST',
      {
        title: 'Protected source',
        body,
        licence: 'CC0-1.0',
        subjectIds: [subjectId],
        boardId: board.id,
        visibility: 'protected',
      },
      201,
    );
    const post = thread.firstPost;
    const route = routeOf(post.id)!;
    await grant(reader, thread.id, ['thread:read']);
    await grant(governor, GLOBAL_CONTEXT, ['moderation:hide', 'moderation:takedown']);
    async function edition(): Promise<EditionKey> {
      return checked(
        creator,
        '/v1/contentEditions',
        'POST',
        {
          postId: post.id,
          revisionId: post.revisionId,
          targetSubjectId: subjectId,
        },
        201,
      );
    }
    const draft = await edition();
    const published = await edition();
    const withdrawn = await edition();
    for (const key of [published, withdrawn]) {
      const result = await checked<EditionKey>(
        creator,
        `/v1/contentEditions/${key.editionId}:publish`,
        'POST',
        {},
        200,
        '1',
      );
      key.editionRevision = result.editionRevision;
    }
    withdrawn.editionRevision = (
      await checked<EditionKey>(creator, `/v1/contentEditions/${withdrawn.editionId}:unpublish`, 'POST', {}, 200, '2')
    ).editionRevision;
    const readerGrant = await grant(reader, published.editionId, ['edition:read'], currentGrant);
    const template = (
      await database.admin.query('SELECT * FROM content.edition WHERE route=$1 AND edition_id=$2', [
        route,
        draft.editionId,
      ])
    ).rows[0]!;
    const date = (
      await database.admin.query<{ recorded_at: Date }>(
        'SELECT recorded_at FROM content.revision WHERE route=$1 AND revision_id=$2',
        [route, post.revisionId],
      )
    ).rows[0]!.recorded_at.toISOString();
    let head = post.revisionId;
    let subjectVersion = 1;
    let label = 'Edition label 0000';
    async function realmHead() {
      return (
        await checked<{ realm: { headRevisionId: string } }>(
          creator,
          `/v1/realms/${realm.realmId}`,
          'GET',
          undefined,
          200,
        )
      ).realm.headRevisionId;
    }
    async function editRealm(summary: string) {
      await checked(creator, `/v1/realms/${realm.realmId}`, 'PATCH', { summary }, 200, await realmHead());
    }
    async function count(sql: string, values: unknown[]) {
      return Number((await database.admin.query(sql, values)).rows[0]!.count);
    }
    const initial = {
      editions: await count('SELECT count(*) FROM content.edition WHERE route=$1', [route]),
      revisions: await count('SELECT count(*) FROM content.revision WHERE route=$1 AND post_id=$2', [route, post.id]),
      subjects: await count('SELECT count(*) FROM semantic.revision WHERE route=$1 AND subject_id=$2', [
        routeOf(subjectId),
        subjectId,
      ]),
      realms: await count('SELECT count(*) FROM community.realm_revision WHERE route=$1 AND realm_id=$2', [
        routeOf(realm.realmId),
        realm.realmId,
      ]),
      grants: await count(
        `SELECT count(*) FROM access.resource_grant WHERE route=$1 AND resource_id=$2
        AND subject_id=$3 AND action='edition:read'`,
        [route, published.editionId, reader.actor.accountId],
      ),
    };
    async function grow(axis: MetadataAxis, scale: number, previous: number) {
      if (axis === 'editions') {
        await seed(
          database,
          {
            name: 'unrelated edition drafts',
            hotPartition: route >>> 4,
            hotShare: 1,
            rows: () => ({ 'content.edition': [{ ...template, edition_id: newId(route) }] }),
          },
          { from: previous, to: scale },
        );
      } else {
        for (let i = previous; i < scale; i++) {
          if (axis === 'post revisions') {
            const changed = await checked<{ post: { revisionId: string } }>(
              creator,
              `/v1/posts/${post.id}/revisions`,
              'POST',
              {
                body: fromPlainText(`Other head body ${String(i).padStart(4, '0')}`),
                subjectIds: [subjectId],
              },
              201,
              head,
            );
            head = changed.post.revisionId;
          } else if (axis === 'subject history') {
            label = `Edition label ${String(i + 1).padStart(4, '0')}`;
            await checked(
              creator,
              `/v1/subjects/${subjectId}/terms`,
              'PATCH',
              { labels: { en: label } },
              200,
              String(subjectVersion),
            );
            subjectVersion++;
          } else if (axis === 'Realm history') {
            await editRealm(`History ${String(i).padStart(4, '0')}`);
          } else {
            const start = Date.UTC(2000, 0, 1) + i * 2000;
            await grant(
              reader,
              published.editionId,
              ['edition:read'],
              `[${new Date(start).toISOString()},${new Date(start + 1000).toISOString()})`,
            );
          }
        }
      }
      // Assert the actual native cardinality of each independently grown axis.
      const sizes = {
        editions: await count('SELECT count(*) FROM content.edition WHERE route=$1', [route]),
        revisions: await count('SELECT count(*) FROM content.revision WHERE route=$1 AND post_id=$2', [route, post.id]),
        subjects: await count('SELECT count(*) FROM semantic.revision WHERE route=$1 AND subject_id=$2', [
          routeOf(subjectId),
          subjectId,
        ]),
        realms: await count('SELECT count(*) FROM community.realm_revision WHERE route=$1 AND realm_id=$2', [
          routeOf(realm.realmId),
          realm.realmId,
        ]),
        grants: await count(
          `SELECT count(*) FROM access.resource_grant WHERE route=$1 AND resource_id=$2
          AND subject_id=$3 AND action='edition:read'`,
          [route, published.editionId, reader.actor.accountId],
        ),
      };
      const changed = {
        editions: 'editions',
        'post revisions': 'revisions',
        'subject history': 'subjects',
        'Realm history': 'realms',
        'grant history': 'grants',
      }[axis];
      for (const key of Object.keys(initial) as (keyof typeof initial)[]) {
        if (sizes[key] !== initial[key] + (key === changed ? scale : 0))
          throw new Error(
            `${axis}: ${key} cardinality ${sizes[key]}, expected ${initial[key] + (key === changed ? scale : 0)}`,
          );
      }
    }
    function read(key: EditionKey, actor = creator, identity = true) {
      return request(
        actor,
        `/v1/contentEditions/${key.editionId}`,
        'GET',
        undefined,
        undefined,
        {
          ...(identity ? { 'rezics-edition-identity': 'true' } : {}),
          'if-none-match': JSON.stringify(post.sha256),
        },
        kernel,
      );
    }
    function expected(key: EditionKey, state: ContentEditionView['state'], identity = true): ContentEditionView {
      return {
        editionId: key.editionId,
        editionRevision: key.editionRevision,
        state,
        targetSubjectId: subjectId,
        creatorAccountId: creator.actor.accountId,
        revisionId: post.revisionId,
        sha256: post.sha256,
        licence: 'CC0-1.0',
        ...(identity
          ? {
              identity: {
                subject: { id: subjectId, kind: 'available', label: { value: label, language: 'en' } },
                revisionCreatedAt: state === 'published' ? null : date,
              },
            }
          : {}),
      };
    }
    return {
      native,
      db: database,
      creator,
      reader,
      outsider,
      governor,
      kernel,
      route,
      post,
      threadId: thread.id,
      subjectId,
      boardId: board.id,
      realmId: realm.realmId,
      spaceId: space.spaceId,
      draft,
      published,
      withdrawn,
      read,
      expected,
      grow,
      editRealm,
      ordinaryPost: () => request(reader, `/v1/posts/${post.id}`, 'GET', undefined, undefined, {}, kernel),
      revokeReader: () => checked(governor, '/v1/grants:revoke', 'POST', readerGrant, 200),
      restoreReader: () => checked(governor, '/v1/grants', 'POST', readerGrant, 201),
      hideSubject: () =>
        checked(governor, `/v1/subjects/${subjectId}:hide`, 'POST', { reason: 'Final subject removal' }, 200),
      restoreSubject: () =>
        checked(governor, `/v1/subjects/${subjectId}:restore`, 'POST', { reason: 'Restore native subject' }, 200),
      eraseSource: () => checked(creator, `/v1/posts/${post.id}`, 'DELETE', undefined, 200),
      async close() {
        await database.close();
        await native.close();
      },
    };
  } catch (error) {
    await db?.close();
    await native.close();
    throw error;
  }
}
export type EditionMetadataFixture = Awaited<ReturnType<typeof editionMetadataFixture>>;
