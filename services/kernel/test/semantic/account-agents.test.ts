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
  AccountAgentLabelEditError,
  AccountAgentWriteDeniedError,
  accountAgentId,
  ensureAccountAgent,
  verifyAccountAgent,
} from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { listSubjectLinks, linkProjection } from '../../src/semantic/links.ts';
import { EditorialConflictError, proposeStatement } from '../../src/semantic/candidates.ts';
import { mergeSubjectsInCommand, SubjectRedirectError } from '../../src/semantic/merges.ts';
import { createSubject, readSubject, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const route = 0x2345;
const catalogueRoute = route + 32;
const bookRoute = route + 16;
const ownerAccount = newId(route);
const otherAccount = newId(route);
let owner!: AccountActor;
let other!: AccountActor;
const realAccess = await createRealAccess(admin, { owner: ownerAccount, other: otherAccount }, [
  'subject:create',
  'statement:propose',
]);
const access = realAccess.access({
  actions: new Map([
    ['subject:create', { anonymous: false }],
    ['statement:propose', { anonymous: false }],
  ]),
});
const projection = linkProjection(pool);
const release = { digest: bundledDigest, release: bundledRelease };
const keyRing: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
const globalResource = { route: 0, id: GLOBAL_CONTEXT };

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

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
    digest: digest(idempotencyKey),
    item,
    release,
    authorization: await authorization(actor, 'subject:create', globalResource),
  });
}

async function person(actor: AccountActor, name: string, id = newId(catalogueRoute)) {
  if (routeOf(id) !== catalogueRoute) throw new TypeError('Catalogue id is outside its route');
  return createAs(actor, { route: catalogueRoute, id }, { type: 'schema:Person', labels: { en: name } });
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

async function proposeOn(subject: string, actor: AccountActor) {
  const resource = { route: routeOf(subject)!, id: subject };
  const idempotencyKey = randomUUID();
  return proposeStatement(pool, {
    subject,
    statement: {
      property: { id: 'schema:sameAs' },
      value: { type: 'value', content: `https://example.test/${idempotencyKey}` },
      qualifiers: [],
      references: [
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: 'https://example.test/source' },
            },
          ],
        },
      ],
    },
    actor,
    idempotencyKey,
    digest: digest(idempotencyKey),
    release,
    authorization: await authorization(actor, 'statement:propose', resource),
    deadline: deadlineFor(5_000),
  });
}

async function grantProposal(subject: string, persona: 'owner' | 'other') {
  const route = routeOf(subject)!;
  await realAccess.grant({ route, id: subject }, persona, 'statement:propose');
}

async function drain(partition: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await projection.run(partition);
    if (result.status !== 'read' || result.envelopes === 0) return;
  }
  throw new Error(`Semantic link projection did not drain partition ${partition}`);
}

async function ordinaryMerge(survivor: string, redirected: string): Promise<void> {
  await runCommand(pool, { partition: partitionOf(routeOf(redirected)!) }, async (tx, { transactionId }) =>
    mergeSubjectsInCommand(tx, transactionId, { survivor, redirected, release }),
  );
}

function catalogueIdBefore(subject: string): string {
  const routeHex = catalogueRoute.toString(16).padStart(4, '0');
  const id = `00000000-0000-8000-8000-${routeHex}00000000`;
  if (routeOf(id) !== catalogueRoute || id >= subject)
    throw new Error('Could not derive a catalogue id before the account agent');
  return id;
}

function catalogueIdAfter(subject: string): string {
  const routeHex = catalogueRoute.toString(16).padStart(4, '0');
  const id = `ffffffff-ffff-8fff-bfff-${routeHex}ffffffff`;
  if (routeOf(id) !== catalogueRoute || id <= subject)
    throw new Error('Could not derive a catalogue id after the account agent');
  return id;
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant(globalResource, 'owner', 'subject:create');
  await realAccess.grant(globalResource, 'other', 'subject:create');
  const context = { pool: admin, deadline: deadlineFor(30_000) };
  owner = await access.authenticate(realAccess.bearer('owner'), context);
  other = await access.authenticate(realAccess.bearer('other'), context);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test("an account's agent has a derived id in the account's partition and is created once", async () => {
  const agentId = accountAgentId(owner.accountId);
  expect(routeOf(agentId)).toBe(routeOf(owner.accountId));
  expect(agentId[14]).toBe('8');

  const first = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Account display name',
    language: 'en',
  });
  const second = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Account display name',
    language: 'en',
  });
  expect(first.created).toBe(true);
  expect(second.created).toBe(false);
  expect(first.subject.id).toBe(agentId);
  expect(second.subject.id).toBe(agentId);
  expect(first.subject.type).toBe('schema:Person');
  const rows = await admin.query(
    `SELECT route, account_route, subject_id::text AS subject, account_id::text AS account,
            agent_id::text AS agent_id, verified, receipt_id
     FROM semantic.account_agent_subject WHERE route = $1 AND subject_id = $2::uuid`,
    [routeOf(agentId), agentId],
  );
  expect(rows.rows).toEqual([
    {
      route: routeOf(agentId),
      account_route: routeOf(owner.accountId),
      subject: agentId,
      account: owner.accountId,
      agent_id: agentId,
      verified: false,
      receipt_id: null,
    },
  ]);
});

test("an account's agent label follows its display name and nobody else edits it", async () => {
  const agentId = accountAgentId(owner.accountId);
  await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Account display name',
    language: 'en',
  });
  const changed = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Renamed display name',
    language: 'ja',
  });
  expect(changed.subject.labels).toEqual({ ja: 'Renamed display name' });
  const editError = await updateSubjectIdentity(pool, {
    subject: agentId,
    labels: { en: 'Edited outside Access' },
    release,
    authorize: async () => true,
  }).catch((error: unknown) => error);
  expect(editError).toBeInstanceOf(AccountAgentLabelEditError);
  expect(editError).toMatchObject({ field: 'labels' });
  expect(
    (await readSubject(pool, agentId, async () => true, undefined, new Uint8Array(32).fill(1)))?.subject.labels,
  ).toEqual({ ja: 'Renamed display name' });
});

test('only the account itself states facts about or pointing at its unverified agent', async () => {
  const agentId = accountAgentId(owner.accountId);
  await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Private account agent',
    language: 'en',
  });
  await grantProposal(agentId, 'owner');
  await grantProposal(agentId, 'other');

  const book = await authorBook(owner, agentId, 'Owner authored book');
  const revision = await admin.query(
    'SELECT source FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [book.subject.id],
  );
  expect(revision.rows[0]?.source).toEqual({ kind: 'agent', subject: agentId });
  await drain(partitionOf(bookRoute));
  const inverse = await listSubjectLinks(pool, keyRing, {
    routeKey: new Uint8Array(32).fill(1),
    subject: agentId,
    property: 'schema:author',
    limit: 10,
    authorize: async () => true,
    seen: [book.component],
    caughtUp: true,
  });
  expect(inverse.links.map((link) => link.subject)).toContain(book.subject.id);

  await expect(authorBook(other, agentId, 'Other account authored book')).rejects.toBeInstanceOf(
    AccountAgentWriteDeniedError,
  );
  await proposeOn(agentId, owner);
  const ownStatement = await admin.query(
    'SELECT source FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [agentId],
  );
  expect(ownStatement.rows[0]?.source).toEqual({ kind: 'agent', subject: agentId });
  await expect(proposeOn(agentId, other)).rejects.toBeInstanceOf(AccountAgentWriteDeniedError);
});

test("verification merges the account's agent into the catalogue agent, which survives and links back", async () => {
  const firstAccount = owner.accountId;
  const firstAgent = accountAgentId(firstAccount);
  await ensureAccountAgent(pool, { account: firstAccount, kind: 'person', name: 'Private name', language: 'en' });
  const book = await authorBook(owner, firstAgent, 'Book by verified account');
  await drain(partitionOf(bookRoute));
  const firstCatalogue = await person(other, 'Catalogue name', catalogueIdBefore(firstAgent));
  const firstReceipt = randomUUID();
  const first = await verifyAccountAgent(pool, {
    account: firstAccount,
    catalogue: firstCatalogue.subject.id,
    receipt: firstReceipt,
  });
  expect(firstCatalogue.subject.id < firstAgent).toBe(true);
  expect(first.survivor).toBe(firstCatalogue.subject.id);
  expect(first.redirected).toBe(firstAgent);
  await expect(
    readSubject(pool, firstAgent, async () => true, undefined, new Uint8Array(32).fill(1)),
  ).rejects.toBeInstanceOf(SubjectRedirectError);
  const firstRead = await readSubject(
    pool,
    firstCatalogue.subject.id,
    async () => true,
    undefined,
    new Uint8Array(32).fill(1),
  );
  expect(firstRead?.account).toEqual({ id: firstAccount });
  expect(firstRead?.subject.labels).toEqual({ en: 'Catalogue name' });

  const ensured = await ensureAccountAgent(pool, {
    account: firstAccount,
    kind: 'person',
    name: 'Later account display name',
    language: 'fr',
  });
  expect(ensured.created).toBe(false);
  expect(ensured.subject.id).toBe(firstCatalogue.subject.id);
  expect(ensured.subject.labels).toEqual({ en: 'Catalogue name' });
  const repeated = await verifyAccountAgent(pool, {
    account: firstAccount,
    catalogue: firstCatalogue.subject.id,
    receipt: firstReceipt,
  });
  expect(repeated.survivor).toBe(firstCatalogue.subject.id);
  const mergeRevision = await admin.query(
    'SELECT verification_receipt_id FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [firstAgent],
  );
  expect(mergeRevision.rows[0]?.verification_receipt_id).toBe(firstReceipt);

  await drain(partitionOf(routeOf(firstAgent)!));
  const moved = await admin.query(
    `SELECT survivor::text, moved_from::text, statement_id::text
     FROM semantic.account_agent_moved_link WHERE receipt_id = $1::text`,
    [firstReceipt],
  );
  const authorStatement = book.subject.statements['schema:author']?.[0]?.id;
  expect(moved.rows).toContainEqual({
    survivor: firstCatalogue.subject.id,
    moved_from: firstAgent,
    statement_id: authorStatement,
  });
  const secondAccount = newId(route);
  const secondAgent = accountAgentId(secondAccount);
  await ensureAccountAgent(pool, { account: secondAccount, kind: 'person', name: 'Second name', language: 'en' });
  const secondCatalogue = await person(other, 'High catalogue id', catalogueIdAfter(secondAgent));
  const second = await verifyAccountAgent(pool, {
    account: secondAccount,
    catalogue: secondCatalogue.subject.id,
    receipt: randomUUID(),
  });
  expect(secondCatalogue.subject.id > secondAgent).toBe(true);
  expect(second.survivor).toBe(secondCatalogue.subject.id);
  expect(second.redirected).toBe(secondAgent);
  expect(
    (await readSubject(pool, secondCatalogue.subject.id, async () => true, undefined, new Uint8Array(32).fill(1)))
      ?.account,
  ).toEqual({
    id: secondAccount,
  });
});

test('an ordinary merge refuses account agents and subjects linked to an account', async () => {
  const linkedAccount = newId(route);
  const agentId = accountAgentId(linkedAccount);
  await ensureAccountAgent(pool, { account: linkedAccount, kind: 'person', name: 'Account agent', language: 'en' });
  const catalogue = await person(other, 'Unlinked catalogue agent');
  await expect(ordinaryMerge(catalogue.subject.id, agentId)).rejects.toBeInstanceOf(EditorialConflictError);

  await verifyAccountAgent(pool, {
    account: linkedAccount,
    catalogue: catalogue.subject.id,
    receipt: randomUUID(),
  });
  const anotherCatalogue = await person(other, 'Another catalogue agent');
  await expect(ordinaryMerge(anotherCatalogue.subject.id, catalogue.subject.id)).rejects.toBeInstanceOf(
    EditorialConflictError,
  );
});
