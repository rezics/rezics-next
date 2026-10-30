import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCheck, type AccountActor, type Resource } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountAgentId, AccountAgentVerificationError } from '../../src/semantic/agents.ts';
import { ensureAccountAgent, verifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { SUBJECT_REVISED } from '../../src/semantic/events.ts';
import { createSubject, readSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
const route = 0x3460;
const accounts = { owner: newId(route), organization: newId(route), software: newId(route) };
// Software agents may use a release that admits applications; the bundled catalogue does not yet include them.
const agentRelease = {
  ...bundledRelease,
  types: {
    ...bundledRelease.types,
    'schema:SoftwareApplication': {
      iri: 'http://schema.org/SoftwareApplication',
      labels: { en: 'Software application' },
      mappings: [],
      bases: ['schema:Thing'],
      properties: [],
      facets: [],
    },
  },
};
const release = { digest: releaseDigest(agentRelease), release: agentRelease };
const realAccess = await createRealAccess(admin, accounts, ['subject:create', 'subject:read']);
const access = realAccess.access({
  actions: new Map([
    ['subject:create', { anonymous: false }],
    ['subject:read', { anonymous: false }],
  ]),
});
let owner: AccountActor;

async function authorization(action: string, resource: Resource): Promise<CommandAuthorization> {
  const check = await accessCheck(access, owner, action, resource, { pool: admin, deadline: deadlineFor(5_000) });
  const denied = () => new Error(`Real Access denied ${action}`);
  return {
    action,
    resource,
    denied,
    async authorize(tx, attempt) {
      if (!(await check(tx, attempt.time))) throw denied();
      return 'execute' as const;
    },
  };
}

async function catalogue(type: string) {
  const key = randomUUID();
  const result = await createSubject(pool, {
    actor: owner,
    target: { route: route + 32, id: newId(route + 32) },
    item: { type, labels: { en: 'Catalogue label' } },
    idempotencyKey: key,
    digest: createHash('sha256').update(key).digest(),
    release,
    authorization: await authorization('subject:create', { route: 0, id: GLOBAL_CONTEXT }),
  });
  return result.subject.id;
}

beforeAll(async () => {
  await bootstrapRelease(pool, agentRelease);
  await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
  owner = await access.authenticate(realAccess.bearer('owner'), { pool: admin, deadline: deadlineFor(5_000) });
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test("an erased account's agent keeps no label, current or past, and a later ensure restores it", async () => {
  const account = accounts.owner;
  const agent = accountAgentId(account);
  const options = { account, kind: 'person' as const };
  const firstName = `First private name ${randomUUID()}`;
  const secondName = `Second private name ${randomUUID()}`;
  await ensureAccountAgent(pool, { ...options, name: firstName, language: 'en' });
  await ensureAccountAgent(pool, { ...options, name: secondName, language: 'ja' });
  expect(
    (await admin.query("SELECT body FROM semantic.fact WHERE subject_id = $1 AND kind = 'label'", [agent])).rows,
  ).toEqual([{ body: secondName }]);
  await realAccess.grant({ route, id: agent }, 'owner', 'subject:read');
  const read = async () => {
    const check = await accessCheck(
      access,
      owner,
      'subject:read',
      { route, id: agent },
      {
        pool: admin,
        deadline: deadlineFor(5_000),
      },
    );
    return readSubject(pool, agent, check, undefined, new Uint8Array(32).fill(1));
  };
  const erased = await ensureAccountAgent(pool, { ...options, name: null });
  expect(erased.subject.labels).toEqual({});
  expect((await read())?.subject.labels).toEqual({});
  const tables = await admin.query("SELECT tablename FROM pg_tables WHERE schemaname = 'semantic'");
  for (const { tablename } of tables.rows) {
    const matches = await admin.query(
      `SELECT count(*)::integer AS count FROM semantic."${tablename}" AS row
       WHERE strpos(to_jsonb(row)::text, $1) > 0 OR strpos(to_jsonb(row)::text, $2) > 0`,
      [firstName, secondName],
    );
    expect(matches.rows, tablename).toEqual([{ count: 0 }]);
  }
  const events = await admin.query(
    'SELECT type, data FROM core.outbox WHERE subject = $1 ORDER BY position, event_seq',
    [agent],
  );
  expect(events.rows.at(-1)).toEqual({
    type: SUBJECT_REVISED,
    data: { id: agent, revision: erased.subject.revision, kind: 'identity' },
  });
  expect(JSON.stringify(events.rows)).not.toContain(firstName);
  expect(JSON.stringify(events.rows)).not.toContain(secondName);
  await ensureAccountAgent(pool, { ...options, name: null });
  expect((await read())?.subject.revision).toBe(erased.subject.revision);
  await ensureAccountAgent(pool, { ...options, name: 'Restored label' });
  expect((await read())?.subject.labels).toEqual({ und: 'Restored label' });
  // Replacements must not consume the ordinary per-slot history or fact caps.
  for (let ordinal = 0; ordinal < 34; ordinal++)
    await ensureAccountAgent(pool, { ...options, name: `Restored ${ordinal}` });
  const current = await admin.query(
    `SELECT subject.current_facts, count(fact.*)::integer AS facts
     FROM semantic.subject subject LEFT JOIN semantic.fact fact USING (route, subject_id)
     WHERE subject.subject_id = $1 GROUP BY subject.current_facts`,
    [agent],
  );
  expect(current.rows).toEqual([{ current_facts: 1, facts: 1 }]);

  const survivor = await catalogue('schema:Person');
  await verifyAccountAgent(pool, { account, catalogue: survivor, receipt: randomUUID() });
  const verified = await readSubject(pool, survivor, async () => true, undefined, new Uint8Array(32).fill(1));
  const unchanged = await ensureAccountAgent(pool, { ...options, name: null });
  expect(unchanged.subject.labels).toEqual({ en: 'Catalogue label' });
  expect(unchanged.subject.revision).toBe(verified!.subject.revision);

  const unnamed = await ensureAccountAgent(pool, { account: newId(route), kind: 'person', name: null });
  expect(unnamed.created).toBe(true);
  expect(unnamed.subject.labels).toEqual({});
});

test('verification refuses a kind mismatch and software agents', async () => {
  const person = await catalogue('schema:Person');
  const organization = await catalogue('schema:Organization');
  for (const [account, kind, target] of [
    [newId(route), 'person', organization],
    [accounts.organization, 'organization', person],
    [accounts.software, 'software', person],
  ] as const) {
    const agent = accountAgentId(account);
    await ensureAccountAgent(pool, { account, kind, name: 'Unverified label' });
    const snapshot = async () => {
      const result = await admin.query(
        `SELECT to_jsonb(subject) AS subject,
                (SELECT jsonb_agg(revision ORDER BY revision.revision) FROM semantic.revision revision
                 WHERE revision.subject_id = subject.subject_id) AS revisions,
                (SELECT jsonb_agg(link) FROM semantic.account_agent_subject link
                 WHERE link.subject_id = subject.subject_id) AS links,
                (SELECT jsonb_agg(redirect) FROM semantic.redirect redirect
                 WHERE redirect.subject_id = subject.subject_id) AS redirects,
                (SELECT jsonb_agg(event ORDER BY position, event_seq) FROM core.outbox event
                 WHERE event.subject = subject.subject_id::text) AS events
         FROM semantic.subject subject WHERE subject.subject_id = ANY($1::uuid[]) ORDER BY subject.subject_id`,
        [[agent, target]],
      );
      return result.rows;
    };
    const before = await snapshot();
    await expect(
      verifyAccountAgent(pool, { account, catalogue: target, receipt: randomUUID() }),
    ).rejects.toBeInstanceOf(AccountAgentVerificationError);
    expect(await snapshot()).toEqual(before);
    expect(
      (await readSubject(pool, agent, async () => true, undefined, new Uint8Array(32).fill(1)))?.subject.labels,
    ).toEqual({ und: 'Unverified label' });
    expect(routeOf(agent)).toBe(route);
  }
});
