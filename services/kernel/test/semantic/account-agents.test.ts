import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createPool } from '../../src/database/pool.ts';
import { runCommand, type CommandAuthorization, type CommandTransaction } from '../../src/command/command.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountAgents, ensureAccountAgent, setAgentName } from '../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { listSubjectLinks, linkProjection } from '../../src/semantic/links.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const owner: AccountActor = {
  kind: 'account',
  accountId: newId(0x2345),
  clientId: 'account-agent-test',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const realAccess = await createRealAccess(admin, { owner: owner.accountId }, ['subject:create']);
const access = realAccess.access({ actions: new Map([['subject:create', { anonymous: false }]]) });
const projection = linkProjection(pool);
const keyRing: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(23)]]) };
let agentId = '';

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function accountCommand<T>(body: (tx: CommandTransaction) => Promise<T>) {
  const route = routeOf(owner.accountId)!;
  const resource = { route: 0, id: GLOBAL_CONTEXT };
  const check = await accessCheck(access, owner, 'subject:create', resource, {
    pool: admin,
    deadline: deadlineFor(5_000),
  });
  const denied = () => new Error('Account agent test authorization denied');
  const authorization: CommandAuthorization = {
    action: 'subject:create',
    resource,
    denied,
    async authorize(tx, attempt) {
      if (!(await check(tx, attempt.time))) throw denied();
      return 'execute';
    },
  };
  return runCommand(
    pool,
    {
      partition: partitionOf(route),
      principal: { kind: 'account', id: owner.accountId },
      basis: { clientId: owner.clientId, requestedBy: owner.requestedBy },
      authorization,
    },
    async (tx) => ({
      value: await body(tx),
      events: [
        {
          type: 'com.rezics.access.account-updated.v1',
          subject: owner.accountId,
          data: { accountId: owner.accountId },
        },
      ],
    }),
  );
}

test('an account has exactly one agent subject, created once', async () => {
  const first = await accountCommand((tx) =>
    ensureAccountAgent(tx, { account: owner.accountId, kind: 'person', name: 'Account Agent', language: 'en' }),
  );
  const second = await accountCommand((tx) =>
    ensureAccountAgent(tx, { account: owner.accountId, kind: 'person', name: 'Ignored Name', language: 'en' }),
  );
  agentId = first.value.subject.id;
  expect(second.value.subject.id).toBe(agentId);
  expect(first.value.subject).toMatchObject({ type: 'schema:Person', labels: { en: 'Account Agent' } });
  const mappings = await admin.query(
    'SELECT subject_id::text AS subject FROM semantic.account_agent WHERE account_id = $1::uuid',
    [owner.accountId],
  );
  const subjects = await admin.query('SELECT subject_id FROM semantic.subject WHERE subject_id = $1::uuid', [agentId]);
  expect(mappings.rows).toEqual([{ subject: agentId }]);
  expect(subjects.rowCount).toBe(1);
});

test("facts reference an account's agent like any other subject", async () => {
  const route = 0x2346;
  const target = { route, id: newId(route) };
  const book = await createSubject(pool, {
    actor: owner,
    target,
    idempotencyKey: `account-agent-book-${crypto.randomUUID()}`,
    digest: new Uint8Array(32).fill(24),
    item: {
      type: 'schema:Book',
      labels: { en: 'Agent author book' },
      statements: {
        'schema:author': [
          {
            property: { id: 'schema:author' },
            value: { type: 'value', content: agentId },
            qualifiers: [],
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: 'https://example.test/account-agent-book' },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  const partition = partitionOf(route);
  for (;;) {
    const result = await projection.run(partition);
    if (result.status !== 'read' || result.envelopes === 0) break;
  }
  const page = await listSubjectLinks(pool, keyRing, {
    subject: agentId,
    property: 'schema:author',
    limit: 10,
    authorize: async () => true,
    seen: [book.component],
    caughtUp: true,
  });
  expect(page.links.map((link) => link.subject)).toContain(book.subject.id);
});

test("an agent's display name is its own statement, controlled by its account", async () => {
  const changed = await accountCommand((tx) =>
    setAgentName(tx, { account: owner.accountId, name: 'Updated Agent Name', language: 'en' }),
  );
  expect(changed.value.subject).toMatchObject({ id: agentId, labels: { en: 'Updated Agent Name' } });
  const revision = await admin.query(
    `SELECT source FROM semantic.revision
     WHERE subject_id = $1::uuid ORDER BY revision DESC LIMIT 1`,
    [agentId],
  );
  expect(revision.rows[0]?.source).toEqual({ kind: 'agent', subject: agentId });
});

test('account agents are looked up in batches', async () => {
  for (const size of [1, 64, 256]) {
    const ids = [owner.accountId, ...Array.from({ length: size - 1 }, (_, index) => newId((index + 1) * 16))];
    const client = await admin.connect();
    let statements = 0;
    const originalQuery = client.query.bind(client);
    const observed = {
      query: ((...args: Parameters<PoolClient['query']>) => {
        statements += 1;
        return originalQuery(...args);
      }) as PoolClient['query'],
    } as Pick<PoolClient, 'query'>;
    try {
      const found = await accountAgents(observed, ids);
      const expectedPartitions = new Set(ids.map((id) => partitionOf(routeOf(id)!)));
      expect(found.size).toBe(size);
      expect(found.get(owner.accountId)).toBe(agentId);
      expect(statements).toBe(expectedPartitions.size);
    } finally {
      client.release();
    }
  }
});
