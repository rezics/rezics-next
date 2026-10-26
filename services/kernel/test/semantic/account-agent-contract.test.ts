import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  AccountAgentLabelEditError,
  AccountAgentWriteDeniedError,
  accountAgentId,
  ensureAccountAgent,
  verifyAccountAgent,
} from '../../src/semantic/index.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { AGENT_LINKED } from '../../src/semantic/events.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { EditorialConflictError, writeProposal } from '../../src/semantic/candidates.ts';
import { mergeSubjectsInCommand, SubjectRedirectError } from '../../src/semantic/merges.ts';
import { createSubject, readSubject, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import type { AccountActor } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const route = 0x2345;
const bookRoute = route + 16;
const owner: AccountActor = {
  kind: 'account',
  accountId: newId(route),
  clientId: 'account-agent-contract',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const other: AccountActor = {
  ...owner,
  accountId: newId(route),
  clientId: 'other-account-agent-contract',
};
const projection = linkProjection(pool);
const release = { digest: bundledDigest, release: bundledRelease };

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}

async function person(actor: AccountActor, name: string, id = newId(route + 32)) {
  const targetRoute = route + 32;
  if (routeOf(id) !== targetRoute) throw new TypeError('Catalogue id is outside its route');
  const key = randomUUID();
  return createSubject(pool, {
    actor,
    target: { route: targetRoute, id },
    idempotencyKey: key,
    digest: digest(key),
    item: { type: 'schema:Person', labels: { en: name } },
    release,
    authorize: async () => true,
  });
}

async function authorBook(actor: AccountActor, agent: string, name: string) {
  const id = newId(bookRoute);
  const key = randomUUID();
  return createSubject(pool, {
    actor,
    target: { route: bookRoute, id },
    idempotencyKey: key,
    digest: digest(key),
    item: {
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
    release,
    authorize: async () => true,
  });
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

function idAfter(subject: string, targetRoute: number): string {
  const routeHex = targetRoute.toString(16).padStart(4, '0');
  const id = `ffffffff-ffff-8fff-bfff-${routeHex}ffffffff`;
  if (id <= subject) throw new Error('Could not derive a catalogue id after the account agent');
  return id;
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test('an account agent stays derived and private until its catalogue verification', async () => {
  const agentId = accountAgentId(owner.accountId);
  expect(routeOf(agentId)).toBe(route);
  expect(agentId[14]).toBe('8');

  const created = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Account display name',
    language: 'en',
  });
  expect(created.created).toBe(true);
  expect(created.subject.id).toBe(agentId);
  const unchanged = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Account display name',
    language: 'en',
  });
  expect(unchanged.created).toBe(false);

  const renamed = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Renamed account display name',
    language: 'en',
  });
  expect(renamed.subject.labels).toEqual({ en: 'Renamed account display name' });

  const updated = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'Updated account display name',
    language: 'ja',
  });
  expect(updated.subject.labels).toEqual({ ja: 'Updated account display name' });
  await expect(
    updateSubjectIdentity(pool, {
      subject: agentId,
      labels: { en: 'Edited outside Access' },
      release,
      authorize: async () => true,
    }),
  ).rejects.toBeInstanceOf(AccountAgentLabelEditError);

  const book = await authorBook(owner, agentId, 'Owner authored book');
  const revision = await admin.query(
    'SELECT source FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [book.subject.id],
  );
  expect(revision.rows[0]?.source).toEqual({ kind: 'agent', subject: agentId });
  await drain(partitionOf(bookRoute));

  await expect(authorBook(other, agentId, 'Other account authored book')).rejects.toBeInstanceOf(
    AccountAgentWriteDeniedError,
  );
  await expect(
    runCommand(
      pool,
      { partition: partitionOf(route), ...principalCommandIdentity(other) },
      async (tx, { transactionId }) =>
        writeProposal(tx, transactionId, {
          subject: agentId,
          statement: {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://example.test/private' },
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
          release,
        }),
    ),
  ).rejects.toBeInstanceOf(AccountAgentWriteDeniedError);

  const catalogue = await person(other, 'Catalogue name');
  await expect(ordinaryMerge(catalogue.subject.id, agentId)).rejects.toBeInstanceOf(EditorialConflictError);
  const receipt = randomUUID();
  const verified = await verifyAccountAgent(pool, {
    account: owner.accountId,
    catalogue: catalogue.subject.id,
    receipt,
  });
  expect(verified.survivor).toBe(catalogue.subject.id);
  expect(verified.redirected).toBe(agentId);
  await expect(readSubject(pool, agentId, async () => true)).rejects.toBeInstanceOf(SubjectRedirectError);
  const catalogueRead = await readSubject(pool, catalogue.subject.id, async () => true);
  expect(catalogueRead?.account).toEqual({ id: owner.accountId });
  expect(catalogueRead?.subject.labels).toEqual({ en: 'Catalogue name' });

  const ensuredAfterVerification = await ensureAccountAgent(pool, {
    account: owner.accountId,
    kind: 'person',
    name: 'A later display name',
    language: 'fr',
  });
  expect(ensuredAfterVerification.created).toBe(false);
  expect(ensuredAfterVerification.subject.id).toBe(catalogue.subject.id);
  expect(ensuredAfterVerification.subject.labels).toEqual({ en: 'Catalogue name' });
  const repeatedVerification = await verifyAccountAgent(pool, {
    account: owner.accountId,
    catalogue: catalogue.subject.id,
    receipt,
  });
  expect(repeatedVerification.survivor).toBe(catalogue.subject.id);
  const mergeRevision = await admin.query(
    'SELECT verification_receipt_id FROM semantic.revision WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1',
    [agentId],
  );
  expect(mergeRevision.rows[0]?.verification_receipt_id).toBe(receipt);

  await drain(partitionOf(route));
  const moved = await admin.query(
    `SELECT survivor::text, moved_from::text, statement_id::text
     FROM semantic.account_agent_moved_link WHERE receipt_id = $1::text`,
    [receipt],
  );
  const authorStatement = book.subject.statements['schema:author']?.[0]?.id;
  expect(moved.rows).toContainEqual({
    survivor: catalogue.subject.id,
    moved_from: agentId,
    statement_id: authorStatement,
  });

  const agentEvents = await admin.query(
    `SELECT data->>'subject' AS subject FROM core.outbox
     WHERE type = $1 AND data->>'account' = $2 ORDER BY position, event_seq`,
    [AGENT_LINKED, owner.accountId],
  );
  expect(agentEvents.rows).toEqual([{ subject: agentId }, { subject: catalogue.subject.id }]);

  const anotherCatalogue = await person(other, 'Another catalogue name');
  await expect(ordinaryMerge(anotherCatalogue.subject.id, catalogue.subject.id)).rejects.toBeInstanceOf(
    EditorialConflictError,
  );
});

test('verification keeps a catalogue id that sorts after the derived account agent', async () => {
  const secondOwner = newId(route);
  const secondAgent = accountAgentId(secondOwner);
  await ensureAccountAgent(pool, {
    account: secondOwner,
    kind: 'person',
    name: 'Second account display name',
    language: 'en',
  });
  const catalogueId = idAfter(secondAgent, route + 32);
  const catalogue = await person(other, 'High catalogue id', catalogueId);
  const verified = await verifyAccountAgent(pool, {
    account: secondOwner,
    catalogue: catalogue.subject.id,
    receipt: randomUUID(),
  });
  expect(catalogue.subject.id > secondAgent).toBe(true);
  expect(verified.survivor).toBe(catalogue.subject.id);
  expect(verified.redirected).toBe(secondAgent);
  expect((await readSubject(pool, catalogue.subject.id, async () => true))?.account).toEqual({ id: secondOwner });
});
