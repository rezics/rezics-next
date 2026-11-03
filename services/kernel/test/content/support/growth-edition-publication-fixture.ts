import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { createNativeContentSystemWithWriteRateOverrides } from './native-system.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../../support/growth.ts';

const writeRateOverrides = JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } });

async function checked<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response;
  const text = await result.text();
  if (result.status !== status) throw new Error(`Expected HTTP ${status}, got ${result.status}: ${text}`);
  return JSON.parse(text) as T;
}

export async function growthEditionPublicationFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  const native = await createNativeContentSystemWithWriteRateOverrides({ databaseUrl }, writeRateOverrides);
  let observed: GrowthDatabase | undefined;
  try {
    const systemUrl = native.database.pool.options.connectionString;
    if (typeof systemUrl !== 'string') throw new Error('Native edition fixture has no database URL');
    observed = await openGrowthDatabase(systemUrl);
    await bootstrapRelease(native.database.pool, bundledRelease);
    const consent = createCurrentConsentReader({ database: native.database.authPool });
    const app = createKernel({
      pool: observed.pool,
      routeKey: native.routeKey,
      tokens: native.tokenKeys,
      receiptKeys: testReceiptKeys(),
      access: native.access,
      writeRate: createWriteRateLimiter({
        secret: `${randomUUID()}${randomUUID()}`,
        overrides: writeRateOverrides,
      }),
      content: {
        readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
      },
    });
    const author = native.actors.author;
    const token = author.bearer;
    const call = (
      path: string,
      method = 'GET',
      body?: unknown,
      version?: string,
      key: string = randomUUID(),
    ) =>
      app.handle(
        new Request(`https://content.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(key),
            ...(version === undefined ? {} : { 'if-match': JSON.stringify(version) }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );

    const scheme = await checked<{ subject: { id: string } }>(
      call('/v1/subjects', 'POST', { type: 'skos:ConceptScheme', labels: { en: 'Edition topics' } }),
      201,
    );
    const concept = await checked<{ subject: { id: string } }>(
      call('/v1/subjects', 'POST', {
        type: 'skos:Concept',
        labels: { en: 'Edition source' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } },
          ],
        },
      }),
      201,
    );
    const space = await checked<{ space: { spaceId: string } }>(
      call('/v1/spaces', 'POST', { title: 'Edition home' }),
      201,
    );
    const realm = await checked<{ realm: { realmId: string; headRevisionId: string } }>(
      call('/v1/realms', 'POST', {
        spaceId: space.space.spaceId,
        title: 'Edition realm',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      }),
      201,
    );
    await checked(
      call(
        `/v1/realms/${realm.realm.realmId}/boardScheme`,
        'PUT',
        { schemeId: scheme.subject.id },
        realm.realm.headRevisionId,
      ),
      200,
    );
    const board = await checked<{ board: { id: string } }>(
      call(`/v1/realms/${realm.realm.realmId}/boards`, 'POST', {
        conceptId: concept.subject.id,
        title: 'Edition board',
        visibility: 'published',
      }),
      201,
    );
    const body = fromPlainText('Fixed authored publication source');
    const created = await checked<{
      thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } };
    }>(
      call('/v1/threads', 'POST', {
        title: 'Protected edition source',
        body,
        licence: 'CC0-1.0',
        subjectIds: [concept.subject.id],
        boardId: board.board.id,
        visibility: 'protected',
      }),
      201,
    );
    const thread = created.thread;
    const source = thread.firstPost;
    const route = routeOf(source.id);
    if (route === null) throw new Error('Native edition source has no route');
    const partition = partitionOf(route);
    let headRevisionId = source.revisionId;
    let sourceHistoryCount = 0;

    return {
      native,
      database: observed,
      author,
      token,
      call,
      route,
      partition,
      thread,
      source,
      body,
      targetSubjectId: concept.subject.id,
      selectedScopeCount: author.actor.scopes.length,
      async createDraft(key: string = randomUUID()) {
        return checked<{ editionId: string; editionRevision: string }>(
          call(
            '/v1/contentEditions',
            'POST',
            { postId: source.id, revisionId: source.revisionId, targetSubjectId: concept.subject.id },
            undefined,
            key,
          ),
          201,
        );
      },
      async reviseSourceHistoryTo(total: number) {
        while (sourceHistoryCount < total) {
          const next = sourceHistoryCount + 1;
          const result = await checked<{ post: { revisionId: string } }>(
            call(
              `/v1/posts/${source.id}/revisions`,
              'POST',
              { body: fromPlainText(`Unrelated source head ${next}`) },
              headRevisionId,
              `growth-edition-source-history-${next}`,
            ),
            201,
          );
          headRevisionId = result.post.revisionId;
          sourceHistoryCount = next;
        }
      },
      sourceHistoryCount: () => sourceHistoryCount,
      close() {
        return observed!.close().finally(() => native.close());
      },
    };
  } catch (error) {
    try {
      await observed?.close();
    } finally {
      await native.close();
    }
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof growthEditionPublicationFixture>>;

export function unrelatedEditionPopulation(fixture: Fixture, name: string): Population {
  return {
    name,
    hotPartition: fixture.partition,
    hotShare: 1,
    rows() {
      const route = fixture.route;
      const editionId = newId(route);
      return {
        'content.edition': [
          {
            route,
            edition_id: editionId,
            creator_account_id: fixture.author.actor.accountId,
            target_subject_id: fixture.targetSubjectId,
            thread_id: newId(route),
            post_id: newId(route),
            revision_id: newId(route),
            body_sha256: Buffer.from(fixture.source.sha256, 'hex'),
            licence: 'CC0-1.0',
            state: 'draft',
            security_revision: 1,
            recorded_transaction_id: newId(route),
            created_at: '2030-01-01T00:00:00.000Z',
          },
        ],
      };
    },
  };
}

export async function seedUnrelatedPublicationHistory(
  fixture: Fixture,
  database: GrowthDatabase,
  name: string,
  from: number,
  to: number,
): Promise<void> {
  const head = (
    await database.admin.query<{ position: string; epoch: number }>(
      'SELECT position::text,epoch FROM core.partition WHERE partition_no=$1',
      [fixture.partition],
    )
  ).rows[0];
  if (!head) throw new Error('Growth edition partition is absent');
  const positionBase = BigInt(head.position);
  const route = fixture.route;
  const scopeValues = [...fixture.author.actor.scopes];
  const population: Population = {
    name,
    hotPartition: fixture.partition,
    hotShare: 1,
    rows({ ordinal }) {
      const editionId = newId(route);
      const operationId = newId(route);
      const recordedTransactionId = newId(route);
      const creationTransactionId = newId(route);
      const outboxId = newId(route);
      const position = positionBase + BigInt(ordinal - from + 1);
      const key = `${name}-${ordinal}`;
      const digest = createHash('sha256').update(key).digest();
      const digestHex = digest.toString('hex');
      return {
        'content.edition': [
          {
            route,
            edition_id: editionId,
            creator_account_id: fixture.author.actor.accountId,
            target_subject_id: fixture.targetSubjectId,
            thread_id: newId(route),
            post_id: newId(route),
            revision_id: newId(route),
            body_sha256: Buffer.from(fixture.source.sha256, 'hex'),
            licence: 'CC0-1.0',
            state: 'published',
            security_revision: 2,
            recorded_transaction_id: creationTransactionId,
            created_at: '2030-01-01T00:00:00.000Z',
          },
        ],
        'content.edition_publication': [
          {
            route,
            operation_id: operationId,
            edition_id: editionId,
            recorded_transaction_id: recordedTransactionId,
            initiator_account_id: fixture.author.actor.accountId,
            actor_client_id: fixture.author.actor.clientId,
            actor_scopes: scopeValues,
            actor_requested_by: null,
            actor_authn_epoch: fixture.author.actor.authnEpoch,
            original_minimum_authn_epoch: '1',
            original_operator_account_id: null,
            original_delegation_transaction_id: null,
            original_delegation_issued_valid: null,
            source_digest: digestHex,
            creation_idempotency_key: key,
            creation_request_digest: digestHex,
          },
        ],
        'core.receipt': [
          {
            partition_no: fixture.partition,
            position,
            epoch: head.epoch,
            principal_kind: 'account',
            principal_id: fixture.author.actor.accountId,
            command_kind: 'content.edition.publish',
            idempotency_key: key,
            request_digest: digest,
            transaction_id: recordedTransactionId,
            response: { editionId, editionRevision: '2' },
          },
        ],
        'core.outbox': [
          {
            partition_no: fixture.partition,
            position,
            epoch: head.epoch,
            event_seq: 0,
            event_count: 1,
            id: outboxId,
            type: 'com.rezics.content.edition.published.v1',
            subject: editionId,
            data: { editionId, editionRevision: '2' },
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: fixture.partition,
            position,
            epoch: head.epoch,
            transaction_id: recordedTransactionId,
            principal_kind: 'account',
            principal_id: fixture.author.actor.accountId,
            client_id: fixture.author.actor.clientId,
            requested_by: null,
          },
        ],
      };
    },
    async finish(admin, range) {
      const position = positionBase + BigInt(range.to - range.from);
      await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
        fixture.partition,
        position.toString(),
      ]);
    },
  };
  await seed({ pool: database.pool, admin: database.admin }, population, { from, to });
}

