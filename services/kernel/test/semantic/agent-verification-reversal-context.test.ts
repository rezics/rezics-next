import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { accessCheck, type AccountActor, type Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  accountAgentId,
  ensureAccountAgent,
  unverifyAccountAgent,
  verifyAccountAgent,
} from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const route = 0x3960;
const catalogueRoute = route + 32;
const bookRoute = route + 16;
const contextRoute = route + 48;
const accounts = { owner: newId(route), other: newId(route) };
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'statement:propose']);
const access = realAccess.access({
  actions: new Map([
    ['subject:create', { anonymous: false }],
    ['statement:propose', { anonymous: false }],
  ]),
});
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const release = { digest: bundledDigest, release: bundledRelease };
const projection = linkProjection(pool);
let owner!: AccountActor;
let other!: AccountActor;

async function authorization(actor: AccountActor, action: string, resource: Resource): Promise<CommandAuthorization> {
  const deadline = deadlineFor(5_000);
  const check = await accessCheck(access, actor, action, resource, { pool: admin, deadline });
  const denied = () => new Error(`Real Access denied ${action}`);
  return {
    action,
    resource,
    denied,
    async authorize(tx, attempt) {
      if (!(await check(tx, attempt.time))) throw denied();
      return 'execute';
    },
  };
}

async function createAs(actor: AccountActor, target: Resource, item: unknown) {
  const idempotencyKey = randomUUID();
  return createSubject(pool, {
    actor,
    target,
    idempotencyKey,
    digest: createHash('sha256').update(idempotencyKey).digest(),
    item,
    release,
    authorization: await authorization(actor, 'subject:create', globalResource),
  });
}

async function person(actor: AccountActor, name: string, id: string) {
  return createAs(actor, { route: routeOf(id)!, id }, { type: 'schema:Person', labels: { en: name } });
}

async function authorBook(actor: AccountActor, agent: string) {
  return createAs(
    actor,
    { route: bookRoute, id: newId(bookRoute) },
    {
      type: 'schema:Book',
      labels: { en: 'Contexted source' },
      statements: {
        'schema:author': [
          {
            property: { id: 'schema:author' },
            value: { type: 'value', content: agent },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.test/contexted-source' },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  );
}

async function drain(partition: number): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await projection.run(partition);
    if (result.status !== 'read' || result.envelopes === 0) return;
  }
  throw new Error(`Semantic link projection did not drain partition ${partition}`);
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  for (const persona of ['owner', 'other'] as const) {
    await realAccess.grant(globalResource, persona, 'subject:create');
    await realAccess.grant(globalResource, persona, 'statement:propose');
  }
  const context = { pool: admin, deadline: deadlineFor(30_000) };
  owner = await access.authenticate(realAccess.bearer('owner'), context);
  other = await access.authenticate(realAccess.bearer('other'), context);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test('verification reversal restores every Context row for a moved inbound link', async () => {
  const agentId = accountAgentId(owner.accountId);
  await ensureAccountAgent(pool, { account: owner.accountId, kind: 'person', name: 'Account agent', language: 'en' });
  await authorBook(owner, agentId);
  await drain(partitionOf(bookRoute));

  const sourceLink = await admin.query(
    `SELECT property, source_subject_id::text AS source_subject_id, statement_id::text AS statement_id,
            source_revision, source_security_revision::text AS source_security_revision,
            source_type, order_key, filter_value::text AS filter_value
     FROM semantic.inbound_link
     WHERE route = $1 AND subject_id = $2 AND context_id = $3 AND present
       AND property = 'schema:author'`,
    [routeOf(agentId), agentId, GLOBAL_CONTEXT],
  );
  expect(sourceLink.rows).toHaveLength(1);
  const global = sourceLink.rows[0]!;
  const contextId = newId(contextRoute);
  await admin.query("INSERT INTO semantic.context(route, context_id, kind, labels) VALUES ($1, $2, 'community', $3)", [
    contextRoute,
    contextId,
    { en: 'Reversal test context' },
  ]);
  await admin.query(
    `INSERT INTO semantic.inbound_link
       (route, subject_id, context_id, property, source_subject_id, statement_id, source_revision,
        source_security_revision, present, suppressed, recorded_transaction_id, source_type, order_key, filter_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, $9, $10, $11, $12)`,
    [
      routeOf(agentId),
      agentId,
      contextId,
      global.property,
      global.source_subject_id,
      global.statement_id,
      global.source_revision,
      global.source_security_revision,
      randomUUID(),
      global.source_type,
      global.order_key,
      global.filter_value,
    ],
  );

  const catalogueId = newId(catalogueRoute);
  await person(other, 'Catalogue agent', catalogueId);
  const verificationReceipt = randomUUID();
  await verifyAccountAgent(pool, { account: owner.accountId, catalogue: catalogueId, receipt: verificationReceipt });
  await drain(partitionOf(routeOf(agentId)!));

  const movedRows = await admin.query(
    `SELECT context_id::text AS context_id FROM semantic.account_agent_moved_link
     WHERE route = $1 AND receipt_id = $2 AND account_id = $3 AND survivor = $4
     ORDER BY context_id`,
    [routeOf(catalogueId), verificationReceipt, owner.accountId, catalogueId],
  );
  expect(movedRows.rows.map((row) => row.context_id).sort()).toEqual([GLOBAL_CONTEXT, contextId].sort());

  await unverifyAccountAgent(pool, { account: owner.accountId, receipt: randomUUID() });
  await drain(partitionOf(routeOf(agentId)!));
  const restored = await admin.query(
    `SELECT context_id::text AS context_id, present FROM semantic.inbound_link
     WHERE route = $1 AND subject_id = $2 AND statement_id = $3 AND property = 'schema:author'
     ORDER BY context_id`,
    [routeOf(agentId), agentId, global.statement_id],
  );
  expect(restored.rows).toEqual([
    { context_id: GLOBAL_CONTEXT, present: true },
    { context_id: contextId, present: true },
  ]);

  const removed = await admin.query(
    `SELECT context_id FROM semantic.inbound_link
     WHERE route = $1 AND subject_id = $2 AND statement_id = $3 AND property = 'schema:author'`,
    [routeOf(catalogueId), catalogueId, global.statement_id],
  );
  expect(removed.rows).toEqual([]);
});
