import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { openGrowthDatabase, type Population } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { createNativeContentSystemWithWriteRateOverrides } from './native-system.ts';

export const editionScales = [256, 1024, 4096] as const;
export type EditionAxis = 'editions/posts' | 'selected revisions' | 'subject/grant history';
export type Draft = { editionId: string; editionRevision: string };
type Source = { id: string; revisionId: string; sha256: string };
const rateOverrides = JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } });

export async function editionDraftFixture() {
  const native = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    rateOverrides,
  );
  const db = await openGrowthDatabase(native.database.pool.options.connectionString);
  // The measured kernel must release each home before acquiring the next one.
  db.pool.options.max = 1;
  const close = async () => {
    try { await db.close(); } finally { await native.close(); }
  };
  try {
    await bootstrapRelease(native.database.pool, bundledRelease);
    const consent = createCurrentConsentReader({ database: native.database.authPool });
    const app = createKernel({
      pool: db.pool,
      access: native.access,
      routeKey: native.routeKey,
      tokens: native.tokenKeys,
      receiptKeys: testReceiptKeys(),
      writeRate: createWriteRateLimiter({
        secret: 'edition-draft-growth-native-write-rate-secret', overrides: rateOverrides,
      }),
      content: {
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      },
    });
    let author = native.actors.author;
    async function refreshAuthor() {
      author = await native.auth.issue({ accountId: author.actor.accountId,
        clientId: native.auth.ordinaryClient.id, scopes: native.auth.ordinaryScopes });
    }
    async function call(
      path: string, body?: unknown,
      options: { method?: string; bearer?: string; version?: string; key?: string } = {},
    ) {
      const response = await app.handle(new Request(`https://content.test${path}`, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: `Bearer ${options.bearer ?? author.bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(options.key ?? randomUUID()),
          ...(options.version ? { 'if-match': JSON.stringify(options.version) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const value = await response.json();
      return { status: response.status, value, headers: response.headers };
    }
    async function accepted<T>(path: string, body: unknown, status = 201, options = {}) {
      const result = await call(path, body, options);
      expect({ status: result.status, error: result.status === status ? null : result.value })
        .toEqual({ status, error: null });
      return result.value as T;
    }
    async function subject(type: string, label: string, statements?: unknown) {
      return (await accepted<{ subject: { id: string } }>('/v1/subjects', {
        type, labels: { en: label }, ...(statements ? { statements } : {}),
      })).subject.id;
    }
    const scheme = await subject('skos:ConceptScheme', 'Draft growth topics');
    const target = await subject('skos:Concept', 'Pinned draft subject', {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme } }],
    });
    const space = (await accepted<{ space: { spaceId: string } }>('/v1/spaces', { title: 'Draft home' })).space;
    const realm = (await accepted<{ realm: { realmId: string; headRevisionId: string } }>('/v1/realms', {
      spaceId: space.spaceId, title: 'Draft realm', visibility: 'public', contextId: GLOBAL_CONTEXT,
    })).realm;
    await accepted(`/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme }, 200,
      { method: 'PUT', version: realm.headRevisionId });
    const board = (await accepted<{ board: { id: string } }>(`/v1/realms/${realm.realmId}/boards`, {
      conceptId: target, title: 'Draft board', visibility: 'published',
    })).board;
    const body = fromPlainText('One fixed canonical native draft source');
    expect(Buffer.byteLength(serializeDocument(body))).toBeLessThanOrEqual(2 * 1024 * 1024);
    const thread = (await accepted<{ thread: { id: string; firstPost: Source } }>('/v1/threads', {
      title: 'Draft ancestry', body, licence: 'CC0-1.0', subjectIds: [target],
      boardId: board.id, visibility: 'protected',
    })).thread;
    // A genuine two-post chain, fixed across every pressure axis and repetition.
    const source = (await accepted<{ post: Source }>(`/v1/threads/${thread.id}/posts`, {
      body, licence: 'CC0-1.0', subjectIds: [target], boardId: board.id,
      visibility: 'protected', parentId: thread.firstPost.id,
    })).post;
    const input = { postId: source.id, revisionId: source.revisionId, targetSubjectId: target };
    const route = routeOf(source.id)!;
    const partition = partitionOf(route);
    let head = source.revisionId;
    let revisions = 0;
    async function revise() {
      const changed = await accepted<{ post: Source }>(`/v1/posts/${source.id}/revisions`, {
        body: fromPlainText('A different current head'), subjectIds: [scheme],
      }, 200, { version: head });
      head = changed.post.revisionId;
      revisions++;
    }
    await revise();
    // The template is also an ordinary committed draft, never a fabricated selected edition.
    const template = await accepted<Draft>('/v1/contentEditions', input);
    async function row(table: string, idColumn: string, id: string) {
      return (await db.admin.query(`SELECT * FROM ${table} WHERE route=$1 AND ${idColumn}=$2`,
        [routeOf(id), id])).rows[0]!;
    }
    const templates = {
      thread: await row('content.thread', 'thread_id', thread.id),
      post: await row('content.post', 'post_id', thread.firstPost.id),
      revision: (await db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2',
        [route, thread.firstPost.revisionId])).rows[0]!,
      edition: await row('content.edition', 'edition_id', template.editionId),
      subject: await row('semantic.subject', 'subject_id', scheme),
      semanticRevision: (await db.admin.query('SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision LIMIT 1',
        [routeOf(scheme), scheme])).rows[0]!,
      // Parent creation grants came from the native governance HTTP command in native-system.
      grant: (await db.admin.query('SELECT * FROM access.resource_grant WHERE subject_id=$1 LIMIT 1',
        [author.actor.accountId])).rows[0]!,
    };
    expect(templates.grant).toBeDefined();
    const populations: Record<'editions/posts' | 'subject/grant history', Population> = {
      'editions/posts': {
        name: `edition-draft-unrelated-sources-${randomUUID()}`, hotPartition: partition, hotShare: 1,
        rows() {
          const threadId = newId(route), postId = newId(route), revisionId = newId(route);
          const transaction = randomUUID();
          return {
            'content.thread': [{ ...templates.thread, thread_id: threadId, first_post_id: postId,
              recorded_transaction_id: transaction }],
            'content.post': [{ ...templates.post, thread_id: threadId, post_id: postId,
              head_revision_id: revisionId, recorded_transaction_id: transaction }],
            'content.revision': [{ ...templates.revision, thread_id: threadId, post_id: postId,
              revision_id: revisionId, recorded_transaction_id: transaction }],
            'content.edition': [{ ...templates.edition, edition_id: newId(route), thread_id: threadId,
              post_id: postId, revision_id: revisionId, recorded_transaction_id: transaction }],
          };
        },
      },
      'subject/grant history': {
        name: `edition-draft-unrelated-subject-history-${randomUUID()}`,
        hotPartition: partitionOf(routeOf(scheme)!), hotShare: 1,
        rows({ ordinal }) {
          const subjectId = newId(routeOf(scheme)!);
          const transaction = randomUUID();
          const start = new Date(Date.UTC(2000, 0, 1) + ordinal * 1000).toISOString();
          const end = new Date(Date.UTC(2000, 0, 1) + (ordinal + 1) * 1000).toISOString();
          return {
            'semantic.subject': [{ ...templates.subject, subject_id: subjectId, recorded_transaction_id: transaction }],
            'semantic.revision': [
              { ...templates.semanticRevision, subject_id: subjectId, recorded_transaction_id: transaction },
              { ...templates.semanticRevision, revision: ordinal + 2, kind: 'adopt', recorded_transaction_id: transaction },
            ],
            'access.resource_grant': [{ ...templates.grant, valid: `[${start},${end})`, transaction_id: transaction }],
          };
        },
      },
    };
    async function growRevisions(scale: number) {
      // Selected-source history is produced only by its native conditional HTTP command.
      while (revisions < scale) {
        if (revisions % 128 === 0) await refreshAuthor();
        await revise();
      }
    }
    async function sourceState() {
      return (await db.admin.query(`SELECT p.head_revision_id,p.reply_to_post_id,r.*
        FROM content.post p JOIN content.revision r ON r.route=p.route AND r.post_id=p.post_id
        WHERE p.route=$1 AND p.post_id=$2 AND r.revision_id=$3`, [route, source.id, source.revisionId])).rows[0]!;
    }
    async function evidence(key: string) {
      const receipts = (await db.admin.query(`SELECT * FROM core.receipt WHERE partition_no=$1
        AND principal_kind='account' AND principal_id=$2 AND command_kind='content.edition.create' AND idempotency_key=$3`,
        [partition, author.actor.accountId, key])).rows;
      const receipt = receipts[0];
      const events = receipt ? (await db.admin.query(`SELECT * FROM core.outbox
        WHERE partition_no=$1 AND position=$2 ORDER BY event_seq`, [partition, receipt.position])).rows : [];
      return { receipts, events };
    }
    async function effects() {
      const tables = ['content.edition', 'content.edition_publication', 'content.revision',
        'access.resource_initialization', 'access.resource_role_grant', 'access.resource_grant',
        'editorial.write_basis', 'core.receipt', 'core.outbox'];
      const counts = await Promise.all(tables.map(async (table) =>
        [table, (await db.admin.query(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!.n]));
      const home = (await db.admin.query('SELECT epoch,position::text FROM core.partition WHERE partition_no=$1',
        [partition])).rows;
      return { counts, home, source: await sourceState() };
    }
    async function sourceGrants() {
      return Promise.all(['access.resource_grant', 'access.resource_role_grant'].map(async (table) =>
        (await db.admin.query(`SELECT * FROM ${table} r WHERE route=$1 AND resource_id=ANY($2::uuid[])
          ORDER BY to_jsonb(r)::text`, [route, [thread.id, thread.firstPost.id, source.id]])).rows));
    }
    async function footprint() {
      return (await db.admin.query(`SELECT
        (SELECT count(*)::int FROM content.edition WHERE route=$1) AS editions,
        (SELECT count(*)::int FROM content.post WHERE route=$1) AS posts,
        (SELECT count(*)::int FROM content.revision WHERE route=$1 AND post_id=$2) AS revisions,
        (SELECT count(*)::int FROM semantic.subject WHERE route=$3) AS subjects,
        (SELECT count(*)::int FROM semantic.revision WHERE route=$3 AND subject_id=$4) AS subject_history,
        (SELECT count(*)::int FROM access.resource_grant WHERE route=$5 AND resource_id=$6
          AND subject_id=$7 AND action=$8 AND upper(valid)<now()) AS grants`,
        [route, source.id, routeOf(scheme), scheme, templates.grant.route, templates.grant.resource_id,
          templates.grant.subject_id, templates.grant.action])).rows[0]!;
    }
    return { native, db, call, accepted, input, source, thread, target, scheme, board, realm, space,
      route, partition, body, template, populations, growRevisions, refreshAuthor, sourceState, sourceGrants,
      evidence, effects, footprint, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export type EditionDraftFixture = Awaited<ReturnType<typeof editionDraftFixture>>;
