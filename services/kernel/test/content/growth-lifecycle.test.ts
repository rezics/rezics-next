import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { appendImportedField, readImportedField } from '../../src/content/imported-fields.ts';
import type { ImportedFieldInput } from '../../src/content/imported-contract.ts';
import { beginAuthorErasure, readOperation } from '../../src/content/operations.ts';
import type { AuthorErasureDependencies } from '../../src/content/operation-contract.ts';
import { bindAuthorErasureWorkflow } from '../../src/content/erasure-workflow-identity.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import type { MediaImportRequest } from '@rezics/definitions/media-import';
import { readMediaImportStatus, type MediaImportDependencies } from '../../src/content/media-import.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { purgeObject } from '../../src/content/erasure-job.ts';
import type { MediaStorage } from '../../src/content/media-storage.ts';
import rejectImportedMedia from '../../src/content/reject-import-media.sql';
import { takedownSourceFence, type SourceFenceDependencies } from '../../src/content/source-fence-command.ts';
import { createTurnstileVerifier } from '../../src/content/turnstile.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandTransaction,
} from '../../src/command/command.ts';
import reserveImportedMedia from '../../src/content/reserve-import-media.sql';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population, type Row } from '../support/growth.ts';

const db = await openGrowthDatabase();
db.pool.options.max = 1;
afterAll(() => db.close());

const scales = [1, 8, 64] as const;
const populationSize = 500;

type AccessPopulation = Readonly<{
  homeRoute: number;
  actorId: string;
  actions: readonly string[];
  roles?: readonly string[];
  receiptKind?: string;
  name: string;
}>;

function accessRows(ordinal: number, population: AccessPopulation): Readonly<Record<string, readonly Row[]>> {
  if (ordinal >= populationSize) return {};
  const { homeRoute, actorId, actions, roles = [], receiptKind, name } = population;
  const filler = newId(homeRoute);
  const rows: Record<string, Row[]> = {
    'access.account': [
      { route: homeRoute, account_id: filler, kind: 'actor', state: 'active', transaction_id: filler },
    ],
    'access.membership_inverse': [
      {
        route: homeRoute,
        account_id: filler,
        kind: 'organization',
        group_id: newId(homeRoute),
        reservation_id: newId(homeRoute),
        transaction_id: newId(homeRoute),
      },
    ],
    'access.resource_grant': [],
    'access.resource_denial': [],
    'access.resource_role_grant': [],
  };
  for (const route of [...new Set([0, homeRoute])]) {
    for (const action of actions) {
      const resourceId = newId(route);
      rows['access.resource_grant']!.push({
        route,
        resource_id: resourceId,
        subject_id: actorId,
        subject_kind: 'identity',
        subject_role: '',
        action,
        valid: '(,)',
        transaction_id: newId(route),
      });
      rows['access.resource_denial']!.push({
        route,
        resource_id: newId(route),
        subject_id: actorId,
        subject_role: '',
        action,
        reason: 'resource',
        valid: '(,)',
        transaction_id: newId(route),
      });
    }
    for (const grantRole of roles) {
      rows['access.resource_role_grant']!.push({
        route,
        resource_id: newId(route),
        subject_kind: 'identity',
        subject_id: actorId,
        subject_role: '',
        grant_role: grantRole,
        valid: '(,)',
        transaction_id: newId(route),
      });
    }
  }
  if (receiptKind) {
    rows['core.receipt'] = [
      {
        partition_no: partitionOf(homeRoute),
        principal_kind: 'account',
        principal_id: actorId,
        command_kind: receiptKind,
        idempotency_key: `${name}-${ordinal}`,
        request_digest: Buffer.alloc(32, 1),
        epoch: 1,
        position: ordinal + 1,
        transaction_id: newId(homeRoute),
        response: {},
      },
    ];
  }
  return rows;
}

async function createActor(route: number, actions: readonly string[]) {
  const accountId = newId(route);
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $2)`,
    [route, accountId],
  );
  const account = await readAccount(db.admin, route, accountId);
  if (!account) throw new Error('Growth actor account was not created');
  const actor: AccountActor = {
    kind: 'account',
    accountId,
    clientId: 'content-growth',
    scopes: actions,
    requestedBy: null,
    authnEpoch: 1,
  };
  return {
    actor,
    access: createAccess({
      actions: new Map(actions.map((action) => [action, { anonymous: false }])),
      accountEvidence: () => account,
    }),
  };
}

async function addGrant(route: number, resourceId: string, actorId: string, action: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO access.resource_grant
     (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, $4, '(,)', $3)`,
    [route, resourceId, actorId, action],
  );
}

async function seedScale(
  population: Population,
  scale: number,
  previous: number,
  expectations: readonly { table: string; routeColumn?: string; partition: number }[] = [],
): Promise<void> {
  await seed({ pool: db.pool, admin: db.admin }, population, {
    from: previous * populationSize,
    to: scale * populationSize,
  });
  if (previous !== 0) return;
  for (const { table, routeColumn = 'route', partition } of expectations) {
    const column = routeColumn === 'partition_no' ? 'partition_no' : `${routeColumn} >> 4`;
    const result = await db.admin.query<{ total: string; hot: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE ${column} = $1)::text AS hot FROM ${table}`,
      [partition],
    );
    expect(Number(result.rows[0]!.total)).toBeGreaterThanOrEqual(populationSize);
    expect(Number(result.rows[0]!.hot)).toBeGreaterThanOrEqual(populationSize);
  }
}

function expectNoContentSequentialScans(report: {
  samples: readonly { cost: { relations?: Record<string, { sequentialScans?: number }> } }[];
}): void {
  for (const { cost } of report.samples)
    for (const [relation, examined] of Object.entries(cost.relations ?? {}))
      if (relation.startsWith('content.')) expect(examined.sequentialScans ?? 0, relation).toBe(0);
}

const importedAction = 'subject:update';
const importedRoute = 0xc120;
const importedSubject = newId(importedRoute);
const importedCandidate = newId(importedRoute);
const importedDocument = fromPlainText('Growth summary stays fixed.');
const importedBytes = Buffer.from(serializeDocument(importedDocument));
const importedSource = {
  source: 'bangumi',
  external_id: 'growth-source',
  record_revision: 'stable',
  digest: 'a'.repeat(64),
  converter_revision: 'converter-v1',
  field_group: 'summary' as const,
  references: [
    {
      parts: [
        { property: { id: 'schema:url' }, value: { type: 'value' as const, content: 'https://bgm.tv/subject/42' } },
      ],
    },
  ],
};
const importedRights = {
  license: 'CC-BY-SA-3.0',
  obligations: ['cc:Attribution', 'cc:ShareAlike'],
  attribution: 'Bangumi contributors',
};
const importedInput: ImportedFieldInput = {
  subject: importedSubject,
  candidate: importedCandidate,
  revision: 1,
  source: importedSource,
  rights: importedRights,
  language: 'en',
  document: importedDocument,
};

test('Imported document append and read stays within its bound as P grows', async () => {
  const { actor, access } = await createActor(importedRoute, [importedAction]);
  await addGrant(importedRoute, importedSubject, actor.accountId, importedAction);
  const makeCommand = async (work: (tx: CommandTransaction) => Promise<unknown>) => {
    const deadline = Date.now() + 10_000;
    const idempotencyKey = randomUUID();
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      importedAction,
      { route: importedRoute, id: importedSubject },
      { pool: db.pool, deadline },
      () => new Error('Growth command denied'),
    );
    return runCommand(
      db.pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(importedRoute),
        deadline,
        authorization,
        receipt: {
          kind: 'content.imported-growth',
          key: idempotencyKey,
          digest: createHash('sha256').update(idempotencyKey).digest(),
        },
      },
      async (tx) => {
        const value = await work(tx);
        return {
          value,
          events: [{ type: 'com.rezics.test.imported-growth.v1', data: { subject: importedSubject } }],
        };
      },
    );
  };
  const anchor = await makeCommand(async (tx) => appendImportedField(tx, importedInput));
  expect(await readImportedField(db.pool, importedRoute, (anchor.value as { id: string }).id)).not.toBeNull();

  const auth: AccessPopulation = {
    homeRoute: importedRoute,
    actorId: actor.accountId,
    actions: [importedAction],
    roles: ['content.post.owner', 'content.media.owner', 'platform.governance'],
    receiptKind: 'content.imported-growth',
    name: 'growth-imported',
  };
  // This population matches immutable imported document rows and holds authorization and receipt history fixed.
  const population: Population = {
    name: `growth-imported-${randomUUID()}`,
    hotPartition: partitionOf(importedRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'content.imported_field': [
        {
          route: importedRoute,
          id: newId(importedRoute),
          subject: newId(importedRoute),
          candidate: newId(importedRoute),
          revision: 1,
          body: importedBytes,
          body_sha256: createHash('sha256').update(importedBytes).digest(),
          source: importedSource,
          rights: importedRights,
          language: 'en',
          availability: 'available',
        },
      ],
      ...accessRows(ordinal, auth),
    }),
  };
  const report = await checkGrowth(db, {
    name: 'Imported document append and read',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [
        { table: 'content.imported_field', partition: partitionOf(importedRoute) },
        { table: 'access.account', partition: partitionOf(importedRoute) },
        { table: 'access.membership_inverse', partition: partitionOf(importedRoute) },
        { table: 'access.resource_grant', partition: partitionOf(importedRoute) },
        { table: 'access.resource_denial', partition: partitionOf(importedRoute) },
        { table: 'access.resource_role_grant', partition: partitionOf(importedRoute) },
        { table: 'core.receipt', routeColumn: 'partition_no', partition: partitionOf(importedRoute) },
      ]),
    operation: async () => {
      await makeCommand(async (tx) => {
        const appended = await appendImportedField(tx, importedInput);
        const stored = await readImportedField(tx, importedRoute, appended.id);
        expect(stored?.digest).toBe(appended.digest);
        return appended;
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
}, 90_000);

test('Report admission proof stays within its bound as T grows', async () => {
  const verifier = createTurnstileVerifier({
    secret: 'growth-secret',
    hostname: 'reports.example.test',
    action: 'report',
    fetch: async () => Response.json({ success: true, hostname: 'reports.example.test', action: 'report' }),
  });
  const report = await checkGrowth(db, {
    name: 'Report admission proof',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: async () => {
      expect(await verifier.verify('fixed-growth-token')).toEqual({
        ok: true,
        hostname: 'reports.example.test',
        action: 'report',
      });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.map(({ cost }) => [cost.rows, cost.blocks, cost.statements])).toEqual([
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  expect(report.samples.every(({ cost }) => Object.keys(cost.relations ?? {}).length === 0)).toBe(true);
}, 90_000);

test('Author erasure request stays within its bound as p grows', async () => {
  const route = 0x6a41;
  const threadId = newId(route);
  const { actor, access } = await createActor(route, ['post:erase']);
  const firstPostId = newId(route);
  const firstRevisionId = newId(route);
  const upperPostId = newId(route);
  const upperRevisionId = newId(route);
  const boardId = newId(route);
  const transactionId = newId(route);
  const body = Buffer.from('fixed author erasure growth post');
  const bodyHash = createHash('sha256').update(body).digest();
  const postRows = [
    { postId: firstPostId, revisionId: firstRevisionId, createdAt: '2000-01-01T00:00:00.000Z' },
    { postId: upperPostId, revisionId: upperRevisionId, createdAt: '2000-01-02T00:00:00.000Z' },
  ];
  await runCommand(db.pool, { partition: partitionOf(route) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, 'Growth erasure thread', 'published', 1, $5, $6)`,
      [route, threadId, actor.accountId, boardId, transactionId, '2000-01-01T00:00:00.000Z'],
    );
    for (const post of postRows) {
      await tx.query(
        `INSERT INTO content.post
           (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id, created_at)
           VALUES ($1, $2, $3, $4, $5, 'published', 1, $6, $7)`,
        [route, threadId, post.postId, actor.accountId, post.revisionId, transactionId, post.createdAt],
      );
      await tx.query(
        `INSERT INTO content.revision
           (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids, board_id, availability, recorded_transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'fixed', 'CC0-1.0', '{}', $7, 'available', $8)`,
        [route, threadId, post.postId, post.revisionId, body, bodyHash, boardId, transactionId],
      );
    }
    return {
      value: threadId,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: threadId,
          data: { threadId, itemId: firstPostId, revisionId: firstRevisionId, actorId: actor.accountId },
        },
      ],
    };
  });
  await addGrant(route, firstPostId, actor.accountId, 'post:erase');
  const deps: AuthorErasureDependencies = {
    pool: db.pool,
    access,
    clock: () => new Date(),
    workflows: {
      async enqueue() {
        throw new Error('The growth check does not enqueue work');
      },
      async status() {
        return null;
      },
    },
  };
  const input = { threadId, authorId: actor.accountId };
  const context = () => ({ deadline: Date.now() + 10_000, idempotencyKey: randomUUID(), requestId: newId(route) });
  expect((await beginAuthorErasure(deps, actor, input, context())).replayed).toBe(false);

  const auth: AccessPopulation = {
    homeRoute: route,
    actorId: actor.accountId,
    actions: ['post:erase'],
    roles: ['content.post.owner', 'content.media.owner', 'platform.governance'],
    receiptKind: 'content.author-erasure',
    name: 'growth-author-erasure',
  };
  // This population matches same-thread post and revision rows while keeping the uncapped Access neighbourhood fixed.
  const population: Population = {
    name: `growth-author-erasure-${randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const postId = newId(route);
      const revisionId = newId(route);
      const rows = {
        'content.post': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            author_account_id: actor.accountId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: newId(route),
            created_at: new Date(Date.UTC(2001, 0, 1, 0, 0, ordinal % 60)),
          },
        ],
        'content.revision': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body,
            body_sha256: bodyHash,
            search_text: 'fixed author erasure growth post',
            licence: 'CC0-1.0',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: newId(route),
          },
        ],
      };
      return { ...rows, ...accessRows(ordinal, auth) };
    },
  };
  const report = await checkGrowth(db, {
    name: 'Author erasure request',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [
        { table: 'content.post', partition: partitionOf(route) },
        { table: 'content.revision', partition: partitionOf(route) },
        { table: 'access.account', partition: partitionOf(route) },
        { table: 'access.membership_inverse', partition: partitionOf(route) },
        { table: 'access.resource_grant', partition: partitionOf(route) },
        { table: 'access.resource_denial', partition: partitionOf(route) },
        { table: 'access.resource_role_grant', partition: partitionOf(route) },
        { table: 'core.receipt', routeColumn: 'partition_no', partition: partitionOf(route) },
      ]),
    operation: async () => {
      const result = await beginAuthorErasure(deps, actor, input, context());
      expect(result.replayed).toBe(false);
      expect(routeOf(result.value.operationId)).toBe(route);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
}, 90_000);

test('Author erasure binding and status stays within its bound as P grows', async () => {
  const route = 0x6a42;
  const threadId = newId(route);
  const { actor, access } = await createActor(route, ['post:erase', 'account:read']);
  const postId = newId(route);
  const revisionId = newId(route);
  const boardId = newId(route);
  const transactionId = newId(route);
  const body = Buffer.from('fixed operation status anchor');
  await runCommand(db.pool, { partition: partitionOf(route) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread
         (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, 'Growth operation thread', 'published', 1, $5, '2000-01-01T00:00:00.000Z')`,
      [route, threadId, actor.accountId, boardId, transactionId],
    );
    await tx.query(
      `INSERT INTO content.post
         (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'published', 1, $6, '2000-01-01T00:00:00.000Z')`,
      [route, threadId, postId, actor.accountId, revisionId, transactionId],
    );
    await tx.query(
      `INSERT INTO content.revision
         (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence, subject_ids, board_id, availability, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'fixed', 'CC0-1.0', '{}', $7, 'available', $8)`,
      [route, threadId, postId, revisionId, body, createHash('sha256').update(body).digest(), boardId, transactionId],
    );
    return {
      value: threadId,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: threadId,
          data: { threadId, itemId: postId, revisionId, actorId: actor.accountId },
        },
      ],
    };
  });
  await addGrant(route, postId, actor.accountId, 'post:erase');
  await addGrant(route, actor.accountId, actor.accountId, 'account:read');
  const deps: AuthorErasureDependencies = {
    pool: db.pool,
    access,
    clock: () => new Date(),
    workflows: {
      async enqueue() {
        throw new Error('The growth check does not enqueue work');
      },
      async status() {
        return null;
      },
    },
  };
  const input = { threadId, authorId: actor.accountId };
  const context = () => ({ deadline: Date.now() + 10_000, idempotencyKey: randomUUID(), requestId: newId(route) });
  const fixtures: { operationId: string; envelope: Envelope }[] = [];
  for (let index = 0; index < 18; index++) {
    const outcome = await beginAuthorErasure(deps, actor, input, context());
    const consumer = `growth_author_erasure_${randomUUID().replaceAll('-', '')}`;
    await db.admin.query(
      `INSERT INTO core.consumer_checkpoint (partition_no, consumer, epoch, position)
       VALUES ($1, $2, $3, $4)`,
      [outcome.partition, consumer, outcome.position === 1n ? null : outcome.epoch, outcome.position - 1n],
    );
    let envelope: Envelope | undefined;
    await readBatch(db.pool, {
      partition: outcome.partition,
      consumer,
      apply: async (batch) => {
        envelope = batch[0];
      },
    });
    if (!envelope) throw new Error('Growth author-erasure event was not found');
    fixtures.push({ operationId: outcome.value.operationId, envelope });
  }

  const auth: AccessPopulation = {
    homeRoute: route,
    actorId: actor.accountId,
    actions: ['post:erase', 'account:read'],
    roles: ['content.post.owner', 'content.media.owner', 'platform.governance'],
    name: 'growth-operation-status',
  };
  // This population matches immutable operation identities and holds both account authorizations fixed.
  const population: Population = {
    name: `growth-operation-status-${randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'content.operation': [
        {
          route,
          operation_id: newId(route),
          initiator_account_id: actor.accountId,
          author_account_id: actor.accountId,
          thread_id: threadId,
          actor_kind: 'account',
          actor_account_id: actor.accountId,
          actor_client_id: actor.clientId,
          actor_scopes: actor.scopes,
          actor_requested_by: null,
          actor_authn_epoch: 1,
          empty_scope: true,
          upper_created_at: null,
          upper_post_id: null,
          requested_at: new Date(),
          recorded_transaction_id: newId(route),
        },
      ],
      ...accessRows(ordinal, auth),
    }),
  };
  const report = await checkGrowth(db, {
    name: 'Author erasure binding and status',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [
        { table: 'content.operation', partition: partitionOf(route) },
        { table: 'access.account', partition: partitionOf(route) },
        { table: 'access.membership_inverse', partition: partitionOf(route) },
        { table: 'access.resource_grant', partition: partitionOf(route) },
        { table: 'access.resource_denial', partition: partitionOf(route) },
        { table: 'access.resource_role_grant', partition: partitionOf(route) },
      ]),
    operation: async (_database, _scale, repetition) => {
      const fixture = fixtures[repetition];
      if (!fixture) throw new Error('Growth repetition has no pre-created operation fixture');
      const workflowId = await bindAuthorErasureWorkflow(db.pool, fixture.operationId, fixture.envelope, 0);
      const operation = await readOperation(deps, actor, fixture.operationId, { deadline: Date.now() + 10_000 });
      expect(workflowId).toContain(fixture.operationId);
      expect(operation?.done).toBe(false);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
}, 90_000);

const mediaRoute = 42_000;
const mediaRoot = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const mediaActions = [
  'media:import_from_url',
  'source_fence:read',
  'media:read_reservation',
  'media:read',
  'media:complete',
  'media:erase',
] as const;
const mediaRouteKey = new Uint8Array(32).fill(7);

function coverRequest(containerId: string, externalId: string): MediaImportRequest {
  return {
    containerId,
    sourceUrl: 'https://images.example.test/cover.jpg',
    credit: {
      rightsHolder: 'Cover Artist',
      via: { name: 'Catalogue', url: 'https://catalogue.example.test/42' },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance: {
      source: 'catalogue',
      external_id: externalId,
      record_revision: 'growth-v1',
      digest: 'b'.repeat(64),
      converter_revision: 'growth-converter',
      field_group: 'cover',
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://catalogue.example.test/42' } },
            { property: { id: 'schema:author' }, value: { type: 'somevalue' } },
            { property: { id: 'schema:datePublished' }, value: { type: 'novalue' } },
          ],
        },
      ],
    },
  };
}

function mediaContext() {
  return { deadline: Date.now() + 15_000, idempotencyKey: randomUUID(), requestId: newId(mediaRoute) };
}

function contentContext(route: number) {
  return { deadline: Date.now() + 15_000, idempotencyKey: randomUUID(), requestId: newId(route) };
}

async function reserveMediaAnchor(
  route: number,
  actorId: string,
  request: MediaImportRequest,
  idempotencyKey = randomUUID(),
): Promise<string> {
  const mediaId = newId(route);
  await runCommand(db.pool, { partition: partitionOf(route), deadline: Date.now() + 15_000 }, async (tx, command) => {
    const row = await reserveImportedMedia.run(tx, {
      route,
      media_id: mediaId,
      container_id: request.containerId,
      uploader_id: actorId,
      reservation_request_id: idempotencyKey,
      key: `m/${mediaId}/original`,
      source_url: request.sourceUrl,
      credit: request.credit,
      provenance: request.provenance,
      at: authoritativeTimeValue(command.time),
      transaction_id: command.transactionId,
    });
    if (row.media_id !== mediaId) throw new Error('Growth media reservation did not create its anchor');
    return {
      value: mediaId,
      events: [
        {
          type: 'com.rezics.content.media.import-requested.v1',
          subject: mediaId,
          data: { mediaId },
        },
      ],
    };
  });
  return mediaId;
}

async function grantMediaOwner(route: number, mediaId: string, actorId: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO access.resource_role_grant
       (route, resource_id, subject_kind, subject_id, grant_role, valid, transaction_id)
     VALUES ($1, $2, 'identity', $3, 'content.media.owner', '(,)', $3)`,
    [route, mediaId, actorId],
  );
}

async function rejectMediaAnchor(route: number, mediaId: string, containerId: string): Promise<void> {
  await runCommand(db.pool, { partition: partitionOf(route), deadline: Date.now() + 15_000 }, async (tx, command) => {
    const changed = await rejectImportedMedia.run(tx, {
      route,
      media_id: mediaId,
      decision: `source-url:${command.transactionId}`,
      transaction_id: command.transactionId,
    });
    if (!changed) throw new Error('Growth media rejection did not commit its terminal anchor');
    return {
      value: mediaId,
      events: [
        {
          type: 'com.rezics.content.media.rejected.v1',
          subject: mediaId,
          data: { mediaId, containerId, decisionId: command.transactionId },
        },
      ],
    };
  });
}

async function createMediaDependencies() {
  const { actor, access } = await createActor(mediaRoute, mediaActions);
  await addGrant(0, mediaRoot.id, actor.accountId, 'media:import_from_url');
  await addGrant(0, mediaRoot.id, actor.accountId, 'source_fence:read');
  const deps: MediaImportDependencies = {
    pool: db.pool,
    access,
    routeKey: mediaRouteKey,
    clock: () => new Date(),
    fetchConfig: { allowedHosts: ['images.example.test'] },
  };
  return { actor, deps };
}

function mediaPopulationRows(
  route: number,
  sourceRoute: number,
  actorId: string,
  request: MediaImportRequest,
  ordinal: number,
) {
  const id = newId(route);
  return {
    'content.media': [
      {
        route,
        media_id: id,
        container_id: newId(route),
        uploader_id: actorId,
        reservation_request_id: `growth-media-${ordinal}`,
        purpose: 'cover',
        media_type: null,
        byte_count: null,
        declared_sha256: null,
        actual_byte_count: null,
        sha256: null,
        state: 'reserved',
        decision: null,
        key: `m/${id}/original`,
        claimed_at: null,
        created_at: new Date('2025-01-01T00:00:00.000Z'),
        transaction_id: newId(route),
        erased: false,
        collection_pending: false,
        source_url: request.sourceUrl,
        credit: request.credit,
        provenance: request.provenance,
        taken_down: false,
        security_revision: 0,
      },
    ],
    'content.media_variant': [
      {
        route,
        media_id: id,
        format: 'webp',
        width: 320,
        height: 180,
        media_type: 'image/webp',
        byte_count: 128,
        sha256: 'c'.repeat(64),
        key: `m/${id}/webp-320`,
        transaction_id: newId(route),
        created_at: new Date('2025-01-01T00:00:00.000Z'),
      },
    ],
    'content.source_fences': [
      {
        route: sourceRoute,
        source: 'catalogue',
        external_id: `growth-source-${ordinal}`,
        field_group: 'cover',
        taken_down: false,
        security_revision: 1,
      },
    ],
    'semantic.subject': [
      { route, subject_id: newId(route), type: 'schema:Book', recorded_transaction_id: newId(route) },
    ],
  };
}

test('URL status stays within its bound as T grows', async () => {
  const { actor, deps } = await createMediaDependencies();
  const containerId = newId(mediaRoute);
  await db.admin.query(
    `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     VALUES ($1, $2, 'schema:Book', $2)`,
    [mediaRoute, containerId],
  );
  let externalId = 'growth-cover-target';
  while (partitionOf(tupleRoute(mediaRouteKey, 'catalogue', externalId)) !== partitionOf(mediaRoute))
    externalId = `growth-cover-target-${randomUUID()}`;
  const request = coverRequest(containerId, externalId);
  const sourceRoute = tupleRoute(mediaRouteKey, 'catalogue', externalId);
  const mediaId = await reserveMediaAnchor(mediaRoute, actor.accountId, request, mediaContext().idempotencyKey);
  await grantMediaOwner(mediaRoute, mediaId, actor.accountId);
  expect(routeOf(mediaId)).toBe(mediaRoute);
  expect((await readMediaImportStatus(deps, actor, mediaId, { deadline: Date.now() + 10_000 }))?.media.id).toBe(
    mediaId,
  );

  const auth: AccessPopulation = {
    homeRoute: mediaRoute,
    actorId: actor.accountId,
    actions: mediaActions,
    roles: ['content.media.owner', 'platform.governance'],
    name: 'growth-media-status',
  };
  // This population matches imported cover rows, variants, source tuples and fixed Access history.
  const population: Population = {
    name: `growth-media-status-${randomUUID()}`,
    hotPartition: partitionOf(mediaRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      ...mediaPopulationRows(mediaRoute, sourceRoute, actor.accountId, request, ordinal),
      'semantic.context': [
        { route: 0, context_id: newId(0), kind: 'community', labels: {}, recorded_transaction_id: newId(0) },
      ],
      ...accessRows(ordinal, auth),
    }),
  };
  const report = await checkGrowth(db, {
    name: 'URL status',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [
        { table: 'content.media', partition: partitionOf(mediaRoute) },
        { table: 'content.media_variant', partition: partitionOf(mediaRoute) },
        { table: 'content.source_fences', partition: partitionOf(sourceRoute) },
        { table: 'semantic.subject', partition: partitionOf(mediaRoute) },
        { table: 'semantic.context', partition: 0 },
        { table: 'access.account', partition: partitionOf(mediaRoute) },
        { table: 'access.membership_inverse', partition: partitionOf(mediaRoute) },
        { table: 'access.resource_grant', partition: partitionOf(mediaRoute) },
        { table: 'access.resource_grant', partition: 0 },
        { table: 'access.resource_denial', partition: partitionOf(mediaRoute) },
        { table: 'access.resource_denial', partition: 0 },
        { table: 'access.resource_role_grant', partition: partitionOf(mediaRoute) },
        { table: 'access.resource_role_grant', partition: 0 },
      ]),
    operation: async () => {
      const result = await readMediaImportStatus(deps, actor, mediaId, { deadline: Date.now() + 10_000 });
      expect(result?.media.id).toBe(mediaId);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
}, 90_000);

test('Source fence takedown stays within its bound as T grows', async () => {
  let externalId = `growth-fence-anchor-${randomUUID()}`;
  while (partitionOf(tupleRoute(mediaRouteKey, 'catalogue', externalId)) !== partitionOf(mediaRoute))
    externalId = `growth-fence-anchor-${randomUUID()}`;
  const sourceRoute = tupleRoute(mediaRouteKey, 'catalogue', externalId);
  const { actor, access } = await createActor(sourceRoute, ['source_fence:takedown']);
  await addGrant(0, mediaRoot.id, actor.accountId, 'source_fence:takedown');
  const deps: SourceFenceDependencies = {
    pool: db.pool,
    access,
    routeKey: mediaRouteKey,
    clock: () => new Date(),
  };
  const input = {
    source: 'catalogue',
    external_id: externalId,
    field_group: 'cover' as const,
    reason: 'Growth fixture',
  };
  const anchor = await takedownSourceFence(deps, actor, input, contentContext(sourceRoute));
  expect(anchor.replayed).toBe(false);

  const auth: AccessPopulation = {
    homeRoute: sourceRoute,
    actorId: actor.accountId,
    actions: ['source_fence:takedown'],
    roles: ['platform.governance'],
    receiptKind: 'content.source-fence.takedown',
    name: 'growth-source-fence-takedown',
  };
  // This population matches source-fence tuples and holds the uncapped Access history at 500 rows.
  const population: Population = {
    name: `growth-source-fence-takedown-${randomUUID()}`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'content.source_fences': [
        {
          route: sourceRoute,
          source: 'catalogue',
          external_id: `growth-fence-neighbour-${ordinal}`,
          field_group: 'cover',
          taken_down: false,
          security_revision: 1,
        },
      ],
      'semantic.context': [
        { route: 0, context_id: newId(0), kind: 'community', labels: {}, recorded_transaction_id: newId(0) },
      ],
      ...accessRows(ordinal, auth),
    }),
  };
  const report = await checkGrowth(db, {
    name: 'Source fence takedown',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [
        { table: 'content.source_fences', partition: partitionOf(sourceRoute) },
        { table: 'semantic.context', partition: 0 },
        { table: 'access.account', partition: partitionOf(sourceRoute) },
        { table: 'access.membership_inverse', partition: partitionOf(sourceRoute) },
        { table: 'access.resource_grant', partition: partitionOf(sourceRoute) },
        { table: 'access.resource_grant', partition: 0 },
        { table: 'access.resource_denial', partition: partitionOf(sourceRoute) },
        { table: 'access.resource_denial', partition: 0 },
        { table: 'access.resource_role_grant', partition: partitionOf(sourceRoute) },
        { table: 'access.resource_role_grant', partition: 0 },
        { table: 'core.receipt', routeColumn: 'partition_no', partition: partitionOf(sourceRoute) },
      ]),
    operation: async () => {
      const result = await takedownSourceFence(deps, actor, input, contentContext(sourceRoute));
      expect(result.replayed).toBe(false);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
}, 90_000);

test('Committed media purge stays within its bound as T grows', async () => {
  const route = 42_064;
  const { actor } = await createActor(route, []);
  const containerId = newId(route);
  await db.admin.query(
    `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id)
     VALUES ($1, $2, 'schema:Book', $2)`,
    [route, containerId],
  );
  const request = coverRequest(containerId, `growth-purge-${randomUUID()}`);
  const mediaId = await reserveMediaAnchor(route, actor.accountId, request);
  await rejectMediaAnchor(route, mediaId, containerId);
  const deletedPrefixes: string[] = [];
  const storage: MediaStorage = {
    async get() {
      return null;
    },
    async put() {},
    async deletePrefix(prefix) {
      deletedPrefixes.push(prefix);
    },
  };
  expect((await purgeObject(db.pool, storage, mediaId)).outcome).toBe('purged');

  // This population matches cover reservations with fixed keys while the anchor carries a committed rejection.
  const population: Population = {
    name: `growth-media-purge-${randomUUID()}`,
    hotPartition: partitionOf(route),
    hotShare: 1,
    rows: ({ ordinal }) => ({
      'content.media': mediaPopulationRows(route, route, actor.accountId, request, ordinal)['content.media'],
    }),
  };
  const report = await checkGrowth(db, {
    name: 'Committed media purge',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_database, scale, previous) =>
      seedScale(population, scale, previous, [{ table: 'content.media', partition: partitionOf(route) }]),
    operation: async () => {
      const result = await purgeObject(db.pool, storage, mediaId);
      expect(result.outcome).toBe('purged');
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expectNoContentSequentialScans(report);
  expect(deletedPrefixes.every((prefix) => prefix === `m/${mediaId}/`)).toBe(true);
}, 90_000);
