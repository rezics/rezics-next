import { createHash, randomUUID } from 'node:crypto';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import type { Pool, PoolClient } from 'pg';
import type { Access, AccountActor } from '../../../src/request/access.ts';
import {
  readContentEditionMechanicalSaleAuthority,
  readContentEditionSaleAuthority,
} from '../../../src/content/edition-sale.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { capture, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../support/native-system.ts';

export const SALE_AUTHORITY_GROWTH_SCALES = [256, 1024, 4096] as const;
export type SaleAuthorityAxis =
  | 'edition-publication-receipts'
  | 'source-revision-subjects'
  | 'publisher-consent-grants';
export type SaleAuthorityRead = 'mechanical' | 'caller';

type EditionRow = {
  route: number;
  edition_id: string;
  creator_account_id: string;
  target_subject_id: string;
  thread_id: string;
  post_id: string;
  revision_id: string;
  body_sha256: Buffer;
  licence: string;
  state: string;
  security_revision: string;
  recorded_transaction_id: string;
  created_at: string;
};

type PublicationRow = {
  route: number;
  operation_id: string;
  edition_id: string;
  recorded_transaction_id: string;
  initiator_account_id: string;
  actor_client_id: string;
  actor_scopes: string[];
  actor_requested_by: string | null;
  actor_authn_epoch: string;
  original_minimum_authn_epoch: string;
  original_operator_account_id: string | null;
  original_delegation_transaction_id: string | null;
  original_delegation_issued_valid: string | null;
  source_digest: string;
  creation_idempotency_key: string;
  creation_request_digest: string;
};

type RevisionRow = {
  route: number;
  thread_id: string;
  post_id: string;
  revision_id: string;
  body: Buffer;
  body_sha256: Buffer;
  search_text: string;
  licence: string;
  subject_ids: string[];
  board_id: string;
  availability: string;
  recorded_transaction_id: string;
  recorded_at: string;
  media_ids: string[];
  vote_citation: unknown;
};

type CurrentRoleGrant = {
  route: number;
  resource_id: string;
  subject_kind: string;
  subject_id: string;
  subject_role: string;
  grant_role: string;
  valid: string;
  transaction_id: string;
};

export type SaleAuthority = {
  benefit: {
    kind: 'content-edition';
    resourceType: 'content.edition';
    resource: { route: number; id: string };
    version: { revisionId: string; sha256: string };
    action: 'edition:read';
  };
  targetSubjectId: string;
  creatorAccountId: string;
  licence: string;
  source: { threadId: string; postId: string; revisionId: string; sha256: string };
  editionRevision: string;
};

export type SaleAuthorityTrace = {
  readonly deadline: number;
  readonly startedAt: number;
  readonly consentReads: { readonly actorAccountId: string; readonly clientId: string }[];
  readonly accessChecks: {
    readonly actorAccountId: string | null;
    readonly action: string;
    readonly resourceId: string;
    readonly time: unknown;
  }[];
  readonly acquired: number;
  readonly released: number;
  readonly maxConcurrent: number;
  readonly openAtReturn: number;
};

export type SaleAuthorityProvenance = {
  readonly edition: EditionRow;
  readonly publication: PublicationRow;
  readonly revision: RevisionRow;
  readonly receipt: {
    readonly transaction_id: string;
    readonly digest: string;
    readonly response: Record<string, unknown>;
  };
  readonly roleGrant: CurrentRoleGrant;
  readonly epoch: number;
  readonly position: string;
};

export type SaleAuthorityGrowthFixture = {
  readonly native: NativeContentSystem;
  readonly app: GrowthDatabase;
  readonly auth: GrowthDatabase;
  readonly author: AccountActor;
  readonly buyer: AccountActor;
  readonly governanceBearer: string;
  readonly editionId: string;
  readonly route: number;
  readonly threadId: string;
  readonly postId: string;
  readonly revisionId: string;
  readonly targetSubjectId: string;
  readonly body: ReturnType<typeof fromPlainText>;
  readonly authority: SaleAuthority;
  readonly provenance: SaleAuthorityProvenance;
  readonly close: () => Promise<void>;
  readonly read: (
    variant: SaleAuthorityRead,
    actor?: AccountActor,
  ) => Promise<{
    readonly value: SaleAuthority | null;
    readonly trace: SaleAuthorityTrace;
  }>;
  readonly grow: (axis: SaleAuthorityAxis, db: GrowthDatabase, scale: number, previous: number) => Promise<void>;
  readonly nativeRequest: <T extends Record<string, unknown>>(
    path: string,
    method: string,
    bearer: string,
    body?: unknown,
    expectedStatus?: number,
    version?: string,
  ) => Promise<{ readonly body: T; readonly idempotencyKey: string }>;
};

type ActiveTrace = {
  readonly consents: SaleAuthorityTrace['consentReads'][number][];
  readonly checks: SaleAuthorityTrace['accessChecks'][number][];
  acquired: number;
  released: number;
  open: number;
  maxOpen: number;
};

async function namedDatabaseUrl(templateUrl: string, pool: Pool): Promise<string> {
  const result = await pool.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(templateUrl);
  url.pathname = `/${result.rows[0]!.name}`;
  return url.href;
}

async function nativeRequest<T extends Record<string, unknown>>(
  native: NativeContentSystem,
  path: string,
  method: string,
  bearer: string,
  body?: unknown,
  expectedStatus = 200,
  version?: string,
): Promise<{ body: T; idempotencyKey: string }> {
  const key = randomUUID();
  const headers = new Headers({
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    'idempotency-key': JSON.stringify(key),
  });
  if (version !== undefined) headers.set('if-match', JSON.stringify(version));
  const { response } = await native.transport.capture(
    new Request(`https://content.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`Native ${method} ${path} returned ${response.status}, expected ${expectedStatus}: ${text}`);
  return { body: (text ? JSON.parse(text) : {}) as T, idempotencyKey: key };
}

async function governanceBearer(native: NativeContentSystem): Promise<string> {
  const identity = await native.database.authPool.query<{ id: string }>('SELECT id FROM public."user" WHERE email=$1', [
    'governance@content.test',
  ]);
  const accountId = identity.rows[0]?.id;
  if (!accountId) throw new Error('Native governance identity was not provisioned by Auth');
  return (
    await native.auth.issue({
      accountId,
      clientId: native.auth.ordinaryClient.id,
      scopes: ['access:grant'],
    })
  ).bearer;
}

async function provenance(
  native: NativeContentSystem,
  route: number,
  editionId: string,
  postId: string,
): Promise<SaleAuthorityProvenance> {
  const edition = (
    await native.database.pool.query<EditionRow>(
      `SELECT route,edition_id::text,creator_account_id::text,target_subject_id::text,thread_id::text,
              post_id::text,revision_id::text,body_sha256,licence,state,security_revision::text,
              recorded_transaction_id::text,created_at::text
         FROM content.edition WHERE route=$1 AND edition_id=$2`,
      [route, editionId],
    )
  ).rows[0];
  const publication = (
    await native.database.pool.query<PublicationRow>(
      `SELECT route,operation_id::text,edition_id::text,recorded_transaction_id::text,
              initiator_account_id::text,actor_client_id,actor_scopes,actor_requested_by,
              actor_authn_epoch::text,original_minimum_authn_epoch,original_operator_account_id::text,
              original_delegation_transaction_id::text,original_delegation_issued_valid,source_digest,
              creation_idempotency_key,creation_request_digest
         FROM content.edition_publication WHERE route=$1 AND edition_id=$2`,
      [route, editionId],
    )
  ).rows[0];
  if (!edition || !publication) throw new Error('Native edition publication is missing its selected resource');
  const partition = partitionOf(route);
  const basis = (
    await native.database.pool.query<{ epoch: number; position: string }>(
      `SELECT epoch,position::text FROM editorial.write_basis
        WHERE partition_no=$1 AND transaction_id=$2 AND principal_kind='account'
          AND principal_id=$3 AND client_id=$4 AND requested_by IS NOT DISTINCT FROM $5`,
      [
        partition,
        publication.recorded_transaction_id,
        publication.initiator_account_id,
        publication.actor_client_id,
        publication.actor_requested_by,
      ],
    )
  ).rows[0];
  const receipt = (
    await native.database.pool.query<{
      transaction_id: string;
      digest: string;
      response: Record<string, unknown>;
    }>(
      `SELECT transaction_id::text,encode(request_digest,'hex') AS digest,response
         FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
          AND command_kind='content.edition.publish' AND idempotency_key=$3`,
      [partition, publication.initiator_account_id, publication.creation_idempotency_key],
    )
  ).rows[0];
  const revision = (
    await native.database.pool.query<RevisionRow>(
      `SELECT route,thread_id::text,post_id::text,revision_id::text,body,body_sha256,search_text,licence,
              subject_ids::text[],board_id::text,availability,recorded_transaction_id::text,recorded_at::text,
              media_ids::text[],vote_citation
         FROM content.revision WHERE route=$1 AND post_id=$2 AND revision_id=$3`,
      [route, postId, edition.revision_id],
    )
  ).rows[0];
  const roleGrant = (
    await native.database.pool.query<CurrentRoleGrant>(
      `SELECT route,resource_id::text,subject_kind,subject_id::text,subject_role,grant_role,valid::text,
              transaction_id::text
         FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_kind='identity'
          AND subject_id=$3 AND grant_role='content.edition.owner' AND valid @> clock_timestamp()`,
      [route, editionId, publication.initiator_account_id],
    )
  ).rows[0];
  if (!basis || !receipt || !revision || !roleGrant)
    throw new Error(
      'Native edition publication lacks its original write basis, receipt, source revision or seller grant',
    );
  return { edition, publication, revision, receipt, roleGrant, epoch: basis.epoch, position: basis.position };
}

function publicationPopulation(fixture: SaleAuthorityGrowthFixture, positionBase: string): Population {
  const { provenance: p, route } = fixture;
  return {
    name: `edition-sale-publications-${fixture.editionId}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows({ ordinal }) {
      const id = newId(route);
      const operationId = newId(route);
      const transactionId = randomUUID();
      const idempotencyKey = JSON.stringify(randomUUID());
      const digest = createHash('sha256').update(`${fixture.editionId}:publication:${ordinal}`).digest();
      const digestHex = digest.toString('hex');
      const position = (BigInt(positionBase) + BigInt(ordinal + 1)).toString();
      return {
        'content.edition': [
          {
            ...p.edition,
            edition_id: id,
            recorded_transaction_id: transactionId,
            created_at: new Date().toISOString(),
          },
        ],
        'content.edition_publication': [
          {
            ...p.publication,
            operation_id: operationId,
            edition_id: id,
            recorded_transaction_id: transactionId,
            source_digest: digestHex,
            creation_idempotency_key: idempotencyKey,
            creation_request_digest: digestHex,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: partitionOf(route),
            transaction_id: transactionId,
            epoch: p.epoch,
            position,
            principal_id: p.publication.initiator_account_id,
            client_id: p.publication.actor_client_id,
            requested_by: p.publication.actor_requested_by,
            principal_kind: 'account',
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(route),
            principal_id: p.publication.initiator_account_id,
            command_kind: 'content.edition.publish',
            idempotency_key: idempotencyKey,
            request_digest: digest,
            epoch: p.epoch,
            position,
            transaction_id: transactionId,
            response: { editionId: id, editionRevision: '2', durableInitiator: 'unrelated-pressure' },
            principal_kind: 'account',
          },
        ],
      };
    },
  };
}

function revisionPopulation(fixture: SaleAuthorityGrowthFixture): Population {
  const { provenance: p, route } = fixture;
  return {
    name: `edition-sale-source-revisions-${fixture.editionId}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows() {
      return {
        'content.revision': [
          {
            ...p.revision,
            revision_id: newId(route),
            recorded_transaction_id: randomUUID(),
            recorded_at: new Date().toISOString(),
          },
        ],
      };
    },
  };
}

function publisherGrantPopulation(fixture: SaleAuthorityGrowthFixture, target: 'app' | 'auth'): Population {
  const { provenance: p, route, author, native } = fixture;
  return {
    name: `edition-sale-publisher-grants-${fixture.editionId}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows({ ordinal }) {
      if (target === 'auth') {
        const clientId = `edition-sale-growth-${ordinal}-${randomUUID()}`;
        const scopes = [...native.auth.ordinaryScopes];
        return {
          'public.auth_client': [{ client_id: clientId, first_party: true, scopes }],
          'public.auth_consent': [{ account_id: author.accountId, client_id: clientId, scopes }],
        };
      }
      const resourceId = newId(route);
      return {
        'access.resource_grant': [
          {
            route,
            resource_id: resourceId,
            subject_kind: 'identity',
            subject_id: author.accountId,
            subject_role: '',
            action: 'post:read',
            valid: p.roleGrant.valid,
            transaction_id: randomUUID(),
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: resourceId,
            subject_kind: 'identity',
            subject_id: author.accountId,
            subject_role: '',
            grant_role: p.roleGrant.grant_role,
            valid: p.roleGrant.valid,
            transaction_id: randomUUID(),
          },
        ],
      };
    },
  };
}

async function maximumWritePosition(db: GrowthDatabase, partition: number): Promise<string> {
  const result = await db.admin.query<{ position: string }>(
    'SELECT COALESCE(max(position),0)::text AS position FROM editorial.write_basis WHERE partition_no=$1',
    [partition],
  );
  return result.rows[0]!.position;
}

export async function createSaleAuthorityGrowthFixture(templateUrl: string): Promise<SaleAuthorityGrowthFixture> {
  const native = await createNativeContentSystem({
    databaseUrl: templateUrl,
    namespace: `edition_sale_growth_${randomUUID().replaceAll('-', '')}`,
  });
  let app: GrowthDatabase | undefined;
  let auth: GrowthDatabase | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const operation of [app?.close, auth?.close, native.close]) {
      if (!operation) continue;
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Edition sale growth fixture cleanup failed');
  };

  try {
    await bootstrapRelease(native.database.pool, bundledRelease);
    const author = native.actors.author.actor;
    const buyer = native.actors.other.actor;
    const bearer = native.actors.author.bearer;
    const governance = await governanceBearer(native);
    const scheme = await nativeRequest<{ subject: { id: string } }>(
      native,
      '/v1/subjects',
      'POST',
      bearer,
      { type: 'skos:ConceptScheme', labels: { en: 'Edition sale growth topics' } },
      201,
    );
    const concept = await nativeRequest<{ subject: { id: string } }>(
      native,
      '/v1/subjects',
      'POST',
      bearer,
      {
        type: 'skos:Concept',
        labels: { en: 'Edition sale growth source' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.body.subject.id } },
          ],
        },
      },
      201,
    );
    const space = await nativeRequest<{ space: { spaceId: string } }>(
      native,
      '/v1/spaces',
      'POST',
      bearer,
      { title: 'Edition sale growth space' },
      201,
    );
    const realm = await nativeRequest<{ realm: { realmId: string; headRevisionId: string } }>(
      native,
      '/v1/realms',
      'POST',
      bearer,
      {
        spaceId: space.body.space.spaceId,
        title: 'Edition sale growth realm',
        visibility: 'public',
        contextId: GLOBAL_CONTEXT,
      },
      201,
    );
    await nativeRequest(
      native,
      `/v1/realms/${realm.body.realm.realmId}/boardScheme`,
      'PUT',
      bearer,
      { schemeId: scheme.body.subject.id },
      200,
      realm.body.realm.headRevisionId,
    );
    const board = await nativeRequest<{ board: { id: string } }>(
      native,
      `/v1/realms/${realm.body.realm.realmId}/boards`,
      'POST',
      bearer,
      { conceptId: concept.body.subject.id, title: 'Edition sale growth board', visibility: 'published' },
      201,
    );
    const body = fromPlainText('The selected native source body remains pinned for sale authority growth.');
    const created = await nativeRequest<{
      thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } };
    }>(
      native,
      '/v1/threads',
      'POST',
      bearer,
      {
        title: 'Edition sale growth source',
        body,
        licence: 'CC0-1.0',
        subjectIds: [concept.body.subject.id],
        boardId: board.body.board.id,
        visibility: 'protected',
      },
      201,
    );
    const thread = created.body.thread;
    const post = thread.firstPost;
    const route = routeOf(post.id);
    if (route === null) throw new Error('Native post has no encoded route');
    await nativeRequest(
      native,
      '/v1/grants',
      'POST',
      governance,
      {
        resource: { route, id: thread.id },
        subject: { kind: 'account', id: buyer.accountId },
        actions: ['thread:read'],
        valid: '(,)',
      },
      201,
    );
    const draft = await nativeRequest<{ editionId: string; editionRevision: string }>(
      native,
      '/v1/contentEditions',
      'POST',
      bearer,
      { postId: post.id, revisionId: post.revisionId, targetSubjectId: concept.body.subject.id },
      201,
    );
    const publish = await nativeRequest<{ editionId: string; editionRevision: string; state: string }>(
      native,
      `/v1/contentEditions/${draft.body.editionId}:publish`,
      'POST',
      bearer,
      {},
      200,
      '1',
    );
    if (publish.body.editionId !== draft.body.editionId || publish.body.state !== 'published')
      throw new Error('Native publish did not publish the selected edition');

    const appUrl = await namedDatabaseUrl(templateUrl, native.database.pool);
    const authUrl = await namedDatabaseUrl(templateUrl, native.database.authPool);
    const appDb = await openGrowthDatabase(appUrl);
    const authDb = await openGrowthDatabase(authUrl);
    app = appDb;
    auth = authDb;
    const currentConsent = createCurrentConsentReader({ database: authDb.pool });
    let active: ActiveTrace | undefined;
    const assignedClients = new Map<PoolClient, ActiveTrace>();
    appDb.pool.on('acquire', (client: PoolClient) => {
      if (!active) return;
      active.acquired++;
      active.open++;
      active.maxOpen = Math.max(active.maxOpen, active.open);
      assignedClients.set(client, active);
    });
    appDb.pool.on('release', (_error: Error | undefined, client: PoolClient) => {
      const trace = assignedClients.get(client);
      if (!trace) return;
      assignedClients.delete(client);
      trace.released++;
      trace.open--;
    });

    const measuredAccess = new Proxy(native.access, {
      get(target, property) {
        if (property === 'authorize')
          return (
            client: Parameters<Access['authorize']>[0],
            actor: Parameters<Access['authorize']>[1],
            action: Parameters<Access['authorize']>[2],
            resource: Parameters<Access['authorize']>[3],
            evidence?: Parameters<Access['authorize']>[4],
            time?: Parameters<Access['authorize']>[5],
          ) => {
            active?.checks.push({
              actorAccountId: actor.kind === 'account' ? actor.accountId : null,
              action,
              resourceId: resource.id,
              time,
            });
            return target.authorize(client, actor, action, resource, evidence, time);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Access;
    createKernel({
      pool: appDb.pool,
      routeKey: native.routeKey,
      tokens: native.tokenKeys,
      receiptKeys: testReceiptKeys(),
      access: measuredAccess,
      content: {
        readConsent: async ({ actorAccountId, clientId }) => {
          active?.consents.push({ actorAccountId, clientId });
          return (await capture(authDb, () => currentConsent.readCurrentConsent({ actorAccountId, clientId }))).value;
        },
      },
    });

    const editionId = draft.body.editionId;
    const authority: SaleAuthority = {
      benefit: {
        kind: 'content-edition',
        resourceType: 'content.edition',
        resource: { route, id: editionId },
        version: { revisionId: post.revisionId, sha256: post.sha256 },
        action: 'edition:read',
      },
      targetSubjectId: concept.body.subject.id,
      creatorAccountId: author.accountId,
      licence: 'CC0-1.0',
      source: { threadId: thread.id, postId: post.id, revisionId: post.revisionId, sha256: post.sha256 },
      editionRevision: publish.body.editionRevision,
    };
    const p = await provenance(native, route, editionId, post.id);
    const closeFixture = close;

    const fixture: SaleAuthorityGrowthFixture = {
      native,
      app: appDb,
      auth: authDb,
      author,
      buyer,
      governanceBearer: governance,
      editionId,
      route,
      threadId: thread.id,
      postId: post.id,
      revisionId: post.revisionId,
      targetSubjectId: concept.body.subject.id,
      body,
      authority,
      provenance: p,
      close: closeFixture,
      async read(variant, actor = author) {
        const startedAt = Date.now();
        const deadline = startedAt + 1000;
        const trace: ActiveTrace = {
          consents: [],
          checks: [],
          acquired: 0,
          released: 0,
          open: 0,
          maxOpen: 0,
        };
        active = trace;
        try {
          const value =
            variant === 'mechanical'
              ? await readContentEditionMechanicalSaleAuthority(
                  { pool: appDb.pool, access: measuredAccess },
                  editionId,
                  { deadline },
                )
              : await readContentEditionSaleAuthority({ pool: appDb.pool, access: measuredAccess }, editionId, {
                  actor,
                  deadline,
                });
          return {
            value,
            trace: {
              deadline,
              startedAt,
              consentReads: trace.consents,
              accessChecks: trace.checks,
              acquired: trace.acquired,
              released: trace.released,
              maxConcurrent: trace.maxOpen,
              openAtReturn: trace.open,
            },
          };
        } finally {
          active = undefined;
        }
      },
      async grow(axis, db, scale, previous) {
        if (axis === 'source-revision-subjects') {
          await seed({ pool: db.pool, admin: db.admin }, revisionPopulation(fixture), { from: previous, to: scale });
          return;
        }
        if (axis === 'publisher-consent-grants') {
          await seed({ pool: db.pool, admin: db.admin }, publisherGrantPopulation(fixture, 'app'), {
            from: previous,
            to: scale,
          });
          await seed({ pool: authDb.pool, admin: authDb.admin }, publisherGrantPopulation(fixture, 'auth'), {
            from: previous,
            to: scale,
          });
          return;
        }
        const positionBase = await maximumWritePosition(db, partitionOf(route));
        await seed({ pool: db.pool, admin: db.admin }, publicationPopulation(fixture, positionBase), {
          from: previous,
          to: scale,
        });
      },
      nativeRequest: (path, method, requestBearer, requestBody, expectedStatus = 200, version) =>
        nativeRequest(native, path, method, requestBearer, requestBody, expectedStatus, version),
    };
    return fixture;
  } catch (error) {
    await close().catch((cleanup) => {
      throw new AggregateError([error, cleanup], 'Edition sale growth setup and cleanup failed');
    });
    throw error;
  }
}

export async function reportProvisionedOrigins(fixture: SaleAuthorityGrowthFixture): Promise<void> {
  if (
    fixture.provenance.edition.edition_id !== fixture.editionId ||
    fixture.provenance.edition.creator_account_id !== fixture.author.accountId ||
    fixture.provenance.publication.initiator_account_id !== fixture.author.accountId ||
    fixture.provenance.publication.recorded_transaction_id !== fixture.provenance.receipt.transaction_id ||
    fixture.provenance.receipt.digest !== fixture.provenance.publication.creation_request_digest ||
    fixture.provenance.receipt.response.editionId !== fixture.editionId ||
    fixture.provenance.receipt.response.editionRevision !== '2' ||
    fixture.provenance.revision.revision_id !== fixture.revisionId ||
    fixture.provenance.revision.post_id !== fixture.postId ||
    fixture.provenance.revision.thread_id !== fixture.threadId ||
    fixture.provenance.roleGrant.resource_id !== fixture.editionId
  )
    throw new Error('Native edition, original publication receipt, exact source revision and seller grant do not bind');
}
