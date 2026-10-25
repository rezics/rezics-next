import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { appendImportedField, readImportedField } from '../../src/content/imported-fields.ts';
import type { ImportedFieldInput } from '../../src/content/imported-contract.ts';
import { principalCommandIdentity, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
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
