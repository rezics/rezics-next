import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { runCommand, type CommandAuthorization } from '../../src/command/command.ts';
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
import { LINKS_PROJECTED, SUBJECT_REVISED } from '../../src/semantic/events.ts';
import { listSubjectLinks, linkProjection } from '../../src/semantic/links.ts';
import { readSubject, createSubject } from '../../src/semantic/subject.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const route = 0x3460;
const catalogueRoute = route + 32;
const bookRoute = route + 16;
const accounts = {
  ownerA: newId(route),
  ownerB: newId(route),
  other: newId(route),
};
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'statement:propose']);
const access = realAccess.access({
  actions: new Map([
    ['subject:create', { anonymous: false }],
    ['statement:propose', { anonymous: false }],
  ]),
});
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const keyRing: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(29)]]) };
const release = { digest: bundledDigest, release: bundledRelease };
const projection = linkProjection(pool);
let ownerA!: AccountActor;
let ownerB!: AccountActor;
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

async function authorBook(actor: AccountActor, agent: string, name: string) {
  return createAs(
    actor,
    { route: bookRoute, id: newId(bookRoute) },
    {
      type: 'schema:Book',
      labels: { en: name },
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
                    value: { type: 'value', content: `https://example.test/${encodeURIComponent(name)}` },
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

async function inverse(subject: string) {
  return listSubjectLinks(pool, keyRing, {
    routeKey: new Uint8Array(32).fill(1),
    subject,
    property: 'schema:author',
    limit: 100,
    includeLabels: false,
    authorize: async () => true,
    seen: [],
    caughtUp: true,
  });
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  for (const persona of ['ownerA', 'ownerB', 'other'] as const) {
    await realAccess.grant(globalResource, persona, 'subject:create');
    await realAccess.grant(globalResource, persona, 'statement:propose');
  }
  const context = { pool: admin, deadline: deadlineFor(30_000) };
  ownerA = await access.authenticate(realAccess.bearer('ownerA'), context);
  ownerB = await access.authenticate(realAccess.bearer('ownerB'), context);
  other = await access.authenticate(realAccess.bearer('other'), context);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test("a reversed verification restores the account's own agent and leaves the catalogue agent as it was", async () => {
  const agentId = accountAgentId(ownerA.accountId);
  await ensureAccountAgent(pool, { account: ownerA.accountId, kind: 'person', name: 'Private name', language: 'en' });
  const movedBooks = await Promise.all(
    Array.from({ length: 4 }, (_, index) => authorBook(ownerA, agentId, `Private credit ${index}`)),
  );
  const catalogueId = newId(catalogueRoute);
  await person(other, 'Catalogue name', catalogueId);
  const catalogueCredit = await authorBook(other, catalogueId, 'Catalogue credit');
  await drain(partitionOf(bookRoute));

  const before = await readSubject(pool, catalogueId, async () => true, undefined, new Uint8Array(32).fill(1));
  const inverseBefore = await inverse(catalogueId);
  expect(inverseBefore.links.map(({ subject }) => subject)).toEqual([catalogueCredit.subject.id]);

  const verificationReceipt = randomUUID();
  await verifyAccountAgent(pool, { account: ownerA.accountId, catalogue: catalogueId, receipt: verificationReceipt });
  await drain(partitionOf(routeOf(agentId)!));
  expect(
    (await readSubject(pool, catalogueId, async () => true, undefined, new Uint8Array(32).fill(1)))?.account,
  ).toEqual({ id: ownerA.accountId });

  const revocationReceipt = randomUUID();
  const reversed = await unverifyAccountAgent(pool, { account: ownerA.accountId, receipt: revocationReceipt });
  const repeated = await unverifyAccountAgent(pool, { account: ownerA.accountId, receipt: revocationReceipt });
  await drain(partitionOf(routeOf(agentId)!));

  expect(reversed).toMatchObject({ survivor: catalogueId, redirected: agentId });
  expect(repeated.revision).toBe(reversed.revision);
  const restoredAgent = await readSubject(pool, agentId, async () => true, undefined, new Uint8Array(32).fill(1));
  expect(restoredAgent?.subject.labels).toEqual({ en: 'Private name' });
  expect(restoredAgent?.account).toEqual({ id: ownerA.accountId });
  expect((await inverse(agentId)).links.map(({ subject }) => subject).sort()).toEqual(
    movedBooks.map(({ subject }) => subject.id).sort(),
  );

  const restoredCatalogue = await readSubject(
    pool,
    catalogueId,
    async () => true,
    undefined,
    new Uint8Array(32).fill(1),
  );
  expect(restoredCatalogue?.subject.labels).toEqual(before?.subject.labels);
  expect(restoredCatalogue?.account).toBeNull();
  const inverseAfter = await inverse(catalogueId);
  expect(inverseAfter.links.map(({ subject, statement }) => ({ subject, statement }))).toEqual(
    inverseBefore.links.map(({ subject, statement }) => ({ subject, statement })),
  );

  const revision = await admin.query(
    `SELECT verification_receipt_id, revocation_receipt_id, revoked_survivor_id::text AS survivor
     FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
    [agentId],
  );
  expect(revision.rows).toEqual([
    {
      verification_receipt_id: verificationReceipt,
      revocation_receipt_id: revocationReceipt,
      survivor: catalogueId,
    },
  ]);
  const redirects = await admin.query('SELECT target FROM semantic.redirect WHERE route = $1 AND subject_id = $2', [
    routeOf(agentId),
    agentId,
  ]);
  expect(redirects.rows).toEqual([]);
  const reverified = await verifyAccountAgent(pool, {
    account: ownerA.accountId,
    catalogue: catalogueId,
    receipt: randomUUID(),
  });
  expect(reverified.survivor).toBe(catalogueId);
  const restoredRevisionEvents = await admin.query(
    `SELECT type, data FROM core.outbox
     WHERE type = $1 AND data->>'id' = $2 AND data->>'revision' = $3`,
    [SUBJECT_REVISED, agentId, String(reversed.revision)],
  );
  expect(restoredRevisionEvents.rows).toEqual([
    { type: SUBJECT_REVISED, data: { id: agentId, revision: reversed.revision, kind: 'merge' } },
  ]);
  const removedAgentLinkedEvents = await admin.query(
    `SELECT type FROM core.outbox WHERE type = 'com.rezics.agent.linked.v1'`,
  );
  expect(removedAgentLinkedEvents.rows).toEqual([]);
});

test("reversing a verification moves back only what came from the account's agent", async () => {
  const agentId = accountAgentId(ownerB.accountId);
  await ensureAccountAgent(pool, { account: ownerB.accountId, kind: 'person', name: 'Account B', language: 'en' });
  const movedBook = await authorBook(ownerB, agentId, 'Moved account credit');
  const catalogueId = newId(catalogueRoute);
  const catalogue = await person(other, 'Separate catalogue', catalogueId);
  const originalCredit = await authorBook(other, catalogueId, 'Original catalogue credit');
  await drain(partitionOf(bookRoute));

  const verificationReceipt = randomUUID();
  await verifyAccountAgent(pool, { account: ownerB.accountId, catalogue: catalogueId, receipt: verificationReceipt });
  await drain(partitionOf(routeOf(agentId)!));
  const laterBook = await authorBook(ownerB, agentId, 'Account statement made after verification');
  await drain(partitionOf(bookRoute));
  const laterSource = await admin.query(
    'SELECT source FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [laterBook.subject.id],
  );
  expect(laterSource.rows[0]?.source).toEqual({ kind: 'agent', subject: agentId });

  await unverifyAccountAgent(pool, { account: ownerB.accountId, receipt: randomUUID() });
  await drain(partitionOf(routeOf(agentId)!));
  const agentLinks = await inverse(agentId);
  const catalogueLinks = await inverse(catalogueId);
  expect(agentLinks.links.map(({ subject }) => subject)).toEqual([movedBook.subject.id]);
  expect(catalogueLinks.links.map(({ subject }) => subject).sort()).toEqual(
    [originalCredit.subject.id, laterBook.subject.id].sort(),
  );
  expect(
    (await readSubject(pool, catalogueId, async () => true, undefined, new Uint8Array(32).fill(1)))?.subject.labels,
  ).toEqual(catalogue.subject.labels);
  const laterSourceAfterReversal = await admin.query(
    'SELECT source FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [laterBook.subject.id],
  );
  expect(laterSourceAfterReversal.rows).toEqual(laterSource.rows);
});

type GrowthFixture = { account: string; agent: string; survivor: string; verificationReceipt: string };
const growthRoute = 0x34a0;
const growthCatalogueRoute = growthRoute + 16;
const growthSourceRoute = growthRoute + 32;
const growthBackgroundRoute = growthRoute + 48;
const growthTargetRoute = growthRoute - 16;
const growthMemberRoute = growthBackgroundRoute + 16;
const growthFixtures = new Map<number, GrowthFixture>();
let nextGrowthRepetition = 0;
const nil = '00000000-0000-0000-0000-000000000000';

async function seedGrowthBackground(db: GrowthDatabase): Promise<void> {
  const rows = Array.from({ length: 2_048 }, (_, index) => ({
    subject: newId(growthBackgroundRoute),
    target: newId(growthTargetRoute),
    account: newId(growthRoute),
    agent: newId(growthRoute),
    source: newId(growthMemberRoute),
    statement: randomUUID(),
    slot: randomUUID(),
    receipt: `background-${index}`,
  }));
  await runCommand(db.pool, { partition: partitionOf(growthBackgroundRoute) }, async (tx, { transactionId }) => {
    const payload = JSON.stringify(rows);
    await tx.query(
      `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id, current_facts, current_release)
       SELECT $1, row.subject, 'schema:Person', $2, 1, $3
       FROM jsonb_to_recordset($4::jsonb) row(subject uuid)`,
      [growthBackgroundRoute, transactionId, bundledDigest, payload],
    );
    await tx.query(
      `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id, current_facts, current_release)
       SELECT $1, row.agent, 'schema:Person', $2, 0, $3
       FROM jsonb_to_recordset($4::jsonb) row(agent uuid)`,
      [growthRoute, transactionId, bundledDigest, payload],
    );
    await tx.query(
      `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
       SELECT $1, row.subject, 1, 'create', $2, $3
       FROM jsonb_to_recordset($4::jsonb) row(subject uuid)`,
      [growthBackgroundRoute, bundledDigest, transactionId, payload],
    );
    await tx.query(
      `INSERT INTO semantic.fact
       (route, subject_id, slot_id, log_seq, operation, kind, language, body, recorded_transaction_id)
       SELECT $1, row.subject, row.slot, 1, 'assert', 'label', 'en', '{"body":"background"}'::jsonb, $2
       FROM jsonb_to_recordset($3::jsonb) row(subject uuid, slot uuid)`,
      [growthBackgroundRoute, transactionId, payload],
    );
    await tx.query(
      `INSERT INTO semantic.account_agent_subject
       (route, account_route, subject_id, account_id, agent_id)
       SELECT $1, $2, row.subject, row.account, row.agent
       FROM jsonb_to_recordset($3::jsonb) row(subject uuid, account uuid, agent uuid)`,
      [growthBackgroundRoute, growthRoute, payload],
    );
    await tx.query(
      `INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id)
       SELECT $1, row.agent, 1, row.target, $2
       FROM jsonb_to_recordset($3::jsonb) row(target uuid, agent uuid)`,
      [growthRoute, transactionId, payload],
    );
    await tx.query(
      `INSERT INTO semantic.merge_member (route, subject_id, member_id, phase, cursor)
       SELECT $1, row.subject, row.source, 'done', '[]'::jsonb
       FROM jsonb_to_recordset($2::jsonb) row(subject uuid, source uuid)`,
      [growthBackgroundRoute, payload],
    );
    await tx.query(
      `INSERT INTO semantic.inbound_link
       (route, subject_id, property, source_subject_id, statement_id, source_revision,
        source_security_revision, present, recorded_transaction_id, source_type, order_key, filter_value)
       SELECT $1, row.subject, 'schema:author', row.source, row.statement, 1, 0, true, $2,
              'schema:Book', '', $3
       FROM jsonb_to_recordset($4::jsonb) row(subject uuid, source uuid, statement uuid)`,
      [growthBackgroundRoute, transactionId, nil, payload],
    );
    await tx.query(
      `INSERT INTO semantic.inbound_link_count (route, subject_id, property, filter_value, value)
       SELECT $1, row.subject, 'schema:author', $2, 1
       FROM jsonb_to_recordset($3::jsonb) row(subject uuid)`,
      [growthBackgroundRoute, nil, payload],
    );
    await tx.query(
      `INSERT INTO semantic.account_agent_moved_link
       (route, receipt_id, account_id, survivor, moved_from, statement_id, property, source_subject_id, filter_value)
       SELECT $1, row.receipt, row.account, row.subject, row.agent,
              row.statement, 'schema:author', row.source, $2
       FROM jsonb_to_recordset($3::jsonb) row(
         subject uuid, account uuid, agent uuid, source uuid, statement uuid, slot uuid, receipt text
       )`,
      [growthBackgroundRoute, nil, payload],
    );
    return {
      value: null,
      events: [{ type: LINKS_PROJECTED, subject: rows[0]!.subject, data: { subjects: [rows[0]!.subject] } }],
    };
  });
}

async function seedGrowthFixture(db: GrowthDatabase, scale: number, repetition: number): Promise<void> {
  const account = newId(growthRoute);
  const agent = accountAgentId(account);
  const survivor = newId(growthCatalogueRoute);
  const verificationReceipt = randomUUID();
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: `Growth agent ${repetition}`, language: 'en' });
  await runCommand(db.pool, { partition: partitionOf(growthCatalogueRoute) }, async (tx, { transactionId }) => {
    await tx.query(
      `INSERT INTO semantic.subject (route, subject_id, type, recorded_transaction_id, current_facts, current_release)
       VALUES ($1, $2, 'schema:Person', $3, 0, $4)`,
      [growthCatalogueRoute, survivor, transactionId, bundledDigest],
    );
    await tx.query(
      `INSERT INTO semantic.revision (route, subject_id, revision, kind, release, recorded_transaction_id)
       VALUES ($1, $2, 1, 'create', $3, $4)`,
      [growthCatalogueRoute, survivor, bundledDigest, transactionId],
    );
    await tx.query('UPDATE semantic.partition_subjects SET visible = visible + 1 WHERE partition_no = $1', [
      partitionOf(growthCatalogueRoute),
    ]);
    return { value: null, events: [{ type: LINKS_PROJECTED, subject: survivor, data: { subjects: [survivor] } }] };
  });
  await runCommand(db.pool, { partition: partitionOf(growthRoute) }, async (tx, { transactionId }) => {
    await tx.query(
      `UPDATE semantic.account_agent_subject
       SET route = $1, subject_id = $2, verified = true, receipt_id = $3
       WHERE account_id = $4 AND subject_id = $5`,
      [growthCatalogueRoute, survivor, verificationReceipt, account, agent],
    );
    await tx.query(
      `INSERT INTO semantic.revision
       (route, subject_id, revision, kind, release, recorded_transaction_id, verification_receipt_id)
       VALUES ($1, $2, 2, 'merge', $3, $4, $5)`,
      [growthRoute, agent, bundledDigest, transactionId, verificationReceipt],
    );
    await tx.query(
      'INSERT INTO semantic.redirect (route, subject_id, sequence, target, recorded_transaction_id) VALUES ($1, $2, 1, $3, $4)',
      [growthRoute, agent, survivor, transactionId],
    );
    await tx.query(
      `INSERT INTO semantic.merge_member (route, subject_id, member_id, phase, cursor)
       VALUES ($1, $2, $3, 'done', '[]'::jsonb)`,
      [growthCatalogueRoute, survivor, agent],
    );
    await tx.query('UPDATE semantic.partition_subjects SET visible = visible - 1 WHERE partition_no = $1', [
      partitionOf(growthRoute),
    ]);

    const noise = Array.from({ length: scale - 4 }, () => ({
      source: newId(growthSourceRoute),
      statement: randomUUID(),
    }));
    const moved = Array.from({ length: 4 }, () => ({
      source: newId(growthSourceRoute),
      statement: randomUUID(),
    }));
    const links = [...noise, ...moved];
    await tx.query(
      `INSERT INTO semantic.inbound_link
       (route, subject_id, property, source_subject_id, statement_id, source_revision,
        source_security_revision, present, recorded_transaction_id, source_type, order_key, filter_value)
       SELECT $1, $2, 'schema:author', row.source, row.statement, 1, 0, true, $3,
              'schema:Book', '', $4
       FROM jsonb_to_recordset($5::jsonb) row(source uuid, statement uuid)`,
      [growthCatalogueRoute, survivor, transactionId, nil, JSON.stringify(links)],
    );
    await tx.query(
      `INSERT INTO semantic.inbound_link_count (route, subject_id, property, filter_value, value)
       VALUES ($1, $2, 'schema:author', $3, $4)`,
      [growthCatalogueRoute, survivor, nil, links.length],
    );
    await tx.query(
      `INSERT INTO semantic.account_agent_moved_link
       (route, receipt_id, account_id, survivor, moved_from, statement_id,
        property, source_subject_id, filter_value)
       SELECT $1, $2, $3, $4, $5, row.statement, 'schema:author', row.source, $6
       FROM jsonb_to_recordset($7::jsonb) row(source uuid, statement uuid)`,
      [growthCatalogueRoute, verificationReceipt, account, survivor, agent, nil, JSON.stringify(moved)],
    );
    return { value: null, events: [{ type: LINKS_PROJECTED, subject: survivor, data: { subjects: [survivor] } }] };
  });
  growthFixtures.set(repetition, { account, agent, survivor, verificationReceipt });
}

test('verification reversal growth stays flat across survivor in-degree', async () => {
  const database = await openGrowthDatabase(databaseUrl);
  try {
    await bootstrapRelease(database.pool, bundledRelease);
    const report = await checkGrowth(database, {
      name: 'verification reversal growth stays flat across survivor in-degree',
      scales: [64, 512, 4096],
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (db, scale) => {
        if (scale === 64) await seedGrowthBackground(db);
        for (let count = 0; count < 6; count++) await seedGrowthFixture(db, scale, nextGrowthRepetition++);
      },
      operation: async (db, _scale, repetition) => {
        const fixture = growthFixtures.get(repetition);
        if (!fixture) throw new Error(`Missing reversal growth fixture ${repetition}`);
        return unverifyAccountAgent(db.pool, { account: fixture.account, receipt: `revoke-${repetition}` });
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
  } finally {
    await database.close();
  }
}, 120_000);
