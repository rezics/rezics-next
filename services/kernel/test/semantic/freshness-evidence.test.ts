import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { DEFAULT_REQUEST_DEADLINE_MS, type CommandAuthorization } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { accessCheck, actorOf, type AccountActor } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  listSubjectLinks,
  listSubjectRelations,
  linkProjection,
  type SubjectLinksPage,
  type SubjectRelationsPage,
} from '../../src/semantic/links.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { moveMergePage } from '../../src/semantic/merge-moves.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { readStatementAs, withPublicStatementReader } from '../../src/semantic/statement-disclosure.ts';
import { encodeSession } from '../../src/tokens/session.ts';
import readCheckpoint from '../../src/semantic/read-link-checkpoint.sql';
import readPending from '../../src/semantic/merge-read-projection-pending.sql';
import readPermissionTime from '../../src/access/permission-time.sql';
import { observeSql, type SqlObserver } from '../content/support/sql-observer.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(87)]]) };
const accounts = {
  owner: newId(randomInt(65536)),
  reader: newId(randomInt(65536)),
  moderator: newId(randomInt(65536)),
};
const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide'];
const real = await createRealAccess(admin, accounts, actions);
const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
const kernel = createKernel({
  pool,
  access: real.access,
  tokens,
  routeKey: new Uint8Array(32).fill(88),
  writeRate: real.writeRate,
});
const projection = linkProjection(pool);
const property = 'rezics:penNameOf';
let owner: AccountActor;
let agent: string;
const digest = (id: string) => createHash('sha256').update(id).digest();
const partition = () => randomInt(1000, 4000);

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:create');
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', 'subject:merge');
  await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
  owner = await actor('owner');
  agent = (await ensureAccountAgent(pool, { account: owner.accountId, kind: 'person', name: 'Evidence owner' })).subject
    .id;
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function actor(persona: keyof typeof accounts) {
  return (await actorOf(
    access,
    new Request('https://kernel.test', { headers: { authorization: `Bearer ${real.bearer(persona)}` } }),
    { pool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  )) as AccountActor;
}
async function create(part: number, label: string, target?: string, privateStatement = false) {
  const route = part * 16;
  const id = newId(route);
  const authorize = await accessCheck(
    access,
    owner,
    'subject:create',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
  );
  const result = await createSubject(pool, {
    actor: owner,
    target: { route, id },
    idempotencyKey: randomUUID(),
    digest: digest(id),
    release: { digest: bundledDigest, release: bundledRelease },
    authorize,
    item: {
      type: 'schema:Person',
      labels: { en: label },
      ...(target
        ? {
            statements: {
              [property]: [
                {
                  property: { id: property },
                  value: { type: 'value', content: target },
                  qualifiers: [],
                  references: privateStatement
                    ? []
                    : [
                        {
                          parts: [
                            {
                              property: { id: 'schema:url' },
                              value: { type: 'value', content: 'https://example.test/evidence' },
                            },
                          ],
                        },
                      ],
                },
              ],
            },
          }
        : {}),
    },
  });
  for (const persona of ['owner', 'reader', 'moderator'] as const)
    await real.grant({ route, id }, persona, 'subject:read');
  return { id, route, component: result.component };
}
async function catchUp(part: number) {
  for (let i = 0; i < 200; i++) {
    const result = await projection.run(part);
    if (result.status === 'busy') {
      await Bun.sleep(5);
      continue;
    }
    if (!result.envelopes) return;
  }
  throw new Error('Native link projection did not catch up');
}
async function call(
  path: string,
  persona: keyof typeof accounts,
  component: { partition: number; epoch: number; position: bigint },
) {
  const response = await kernel.handle(
    new Request(`https://kernel.test/v1/subjects/${path}`, {
      headers: {
        authorization: `Bearer ${real.bearer(persona)}`,
        [SESSION_HEADER]: encodeSession(tokens, `account:${accounts[persona]}`, [component]),
      },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function expireIssuedProof(observer: SqlObserver, waitStarted: string) {
  const issued = observer.records.filter(({ statement }) => statement === readPermissionTime.sql).at(-1);
  // HTTP list routes already wait before preparing evidence. Native list callers and
  // subject reads issue real evidence before this barrier, whose lifetime must expire.
  const expires = Date.parse(issued?.executedAt ?? waitStarted) + 1100;
  while (Date.now() < expires) await Bun.sleep(Math.min(20, expires - Date.now()));
}
async function held<T>(observer: SqlObserver, statement: string, run: () => Promise<T>, during: () => Promise<void>) {
  const barrier = observer.hold({ statement }, 'after');
  const result = run();
  try {
    const boundary = await Promise.race([
      barrier.entered,
      result.then(() => {
        throw new Error('Read completed before native barrier');
      }),
    ]);
    await expireIssuedProof(observer, boundary.executedAt);
    await during();
  } finally {
    barrier.release();
  }
  return result;
}

for (const persona of ['owner', 'reader', 'moderator'] as const) {
  test(`subject and relation HTTP reads refresh ${persona} audience after native projection waits outlive proof`, async () => {
    const part = partition();
    const holder = await create(part, 'Private evidence holder', agent, true);
    await real.grant({ route: routeOf(agent)!, id: agent }, persona, 'subject:read');
    for (const suffix of ['', `/relations?property=${encodeURIComponent(property)}`]) {
      // Real pending outbox work and a missing checkpoint, never a replacement projection result.
      await admin.query("DELETE FROM core.consumer_checkpoint WHERE partition_no=$1 AND consumer='semantic_links'", [
        part,
      ]);
      const observer = observeSql(pool);
      try {
        const result = await held(
          observer,
          readCheckpoint.sql,
          () => call(`${holder.id}${suffix}`, persona, holder.component),
          () => catchUp(part),
        );
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        const rows = suffix ? result.body.relations : (result.body.subject.statements[property] ?? []);
        expect(rows).toHaveLength(persona === 'reader' ? 0 : 1);
        const reads = observer.records;
        const wait = reads.findIndex(({ statement }) => statement === readCheckpoint.sql);
        expect(reads.slice(wait + 1).some(({ statement }) => statement === readPermissionTime.sql)).toBe(true);
      } finally {
        await observer.close();
      }
    }
  }, 60_000);
}

for (const kind of ['links', 'relations'] as const) {
  test(`native ${kind} prepares primary and moderator evidence after its internal freshness wait`, async () => {
    const part = partition();
    const target = await create(part, 'Native evidence target');
    const holder = await create(part, 'Native evidence holder', target.id);
    const subject = kind === 'links' ? target : holder;
    const as = await actor('moderator');
    const observer = observeSql(pool);
    try {
      const result = await held(
        observer,
        readCheckpoint.sql,
        () =>
          withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, async () => {
            const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
            const prepareAuthorization = () =>
              accessCheck(
                access,
                as,
                'subject:read',
                { route: subject.route, id: subject.id, eligibility: subjectReadEligibility(subject) },
                { pool, deadline },
              );
            const check = await prepareAuthorization();
            return readStatementAs<SubjectLinksPage | SubjectRelationsPage>(pool, access, as, deadline, () => {
              const options = {
                subject: subject.id,
                property,
                limit: 20,
                release: bundledRelease,
                authorize: check,
                prepareAuthorization,
                seen: [holder.component],
                includeLabels: false,
              };
              return kind === 'links'
                ? listSubjectLinks(pool, tokens, options)
                : listSubjectRelations(pool, tokens, options);
            });
          }),
        () => catchUp(part),
      );
      if ('links' in result) expect(result.links).toHaveLength(1);
      else expect(result.relations).toHaveLength(1);
      expect(result.freshness.caught_up).toBe(true);
      const wait = observer.records.findIndex(({ statement }) => statement === readCheckpoint.sql);
      expect(
        observer.records.slice(0, wait).filter(({ statement }) => statement === readPermissionTime.sql),
      ).toHaveLength(2);
      expect(
        observer.records.slice(wait + 1).filter(({ statement }) => statement === readPermissionTime.sql),
      ).toHaveLength(2);
    } finally {
      await observer.close();
    }
  }, 60_000);
}

test('pending inbound merge member retry prepares fresh primary and audience evidence for the second snapshot', async () => {
  const part = partition();
  const target = await create(part, 'Pending member target');
  const first = await create(part, 'Pending member first', target.id);
  const second = await create(part, 'Pending member second', target.id);
  await catchUp(part);
  const [survivor, merged] = [first.id, second.id].sort() as [string, string];
  const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  const mergeCheck = await accessCheck(
    access,
    owner,
    'subject:merge',
    { route: 0, id: GLOBAL_CONTEXT },
    { pool, deadline },
  );
  const authorization: CommandAuthorization = {
    action: 'subject:merge',
    resource: { route: 0, id: GLOBAL_CONTEXT },
    denied: () => new Error('Merge denied'),
    authorize: async (client, attempt) => {
      if (!(await mergeCheck(client, attempt.time))) throw new Error('Merge denied');
      return 'execute';
    },
  };
  await mergeSubjects(pool, {
    subjects: [first.id, second.id],
    survivor,
    actor: owner,
    idempotencyKey: randomUUID(),
    digest: digest(merged),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization,
    deadline,
  });
  const observer = observeSql(pool);
  try {
    const result = await held(
      observer,
      readPending.sql,
      () => call(`${target.id}/links?property=${encodeURIComponent(property)}`, 'moderator', target.component),
      async () => {
        await moveMergePage(pool, merged, survivor);
        await catchUp(part);
      },
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.links.length).toBeGreaterThan(0);
    expect(result.body.links.every((link: { subject: string }) => link.subject === survivor)).toBe(true);
    expect(result.body.links[0].subject).toBe(survivor);
    expect(result.body.freshness.caught_up).toBe(true);
    expect(observer.records.filter(({ statement }) => statement === readPending.sql).length).toBeGreaterThan(1);
  } finally {
    await observer.close();
  }
}, 60_000);

test('forced public audience survives a long native wait with the same authenticated moderator', async () => {
  const part = partition();
  const holder = await create(part, 'Public evidence holder', agent, true);
  const observer = observeSql(pool);
  try {
    const result = await held(
      observer,
      readCheckpoint.sql,
      () => withPublicStatementReader(() => call(holder.id, 'moderator', holder.component)),
      () => catchUp(part),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.subject.statements[property] ?? []).toHaveLength(0);
    expect(JSON.stringify(result.body)).not.toContain(agent);
  } finally {
    await observer.close();
  }
}, 60_000);

for (const kind of ['links', 'relations'] as const) {
  for (const change of ['hide', 'revoke', 'redirect'] as const) {
    test(`${kind} final HTTP authorization observes ${change} during a native wait beyond evidence lifetime`, async () => {
      const part = partition();
      const target = await create(part, 'Changed evidence target');
      const holder = await create(part, 'Changed evidence holder', target.id);
      const subject = kind === 'links' ? target : holder;
      const mate = change === 'redirect' ? await create(part, 'Redirect mate') : null;
      const denial = randomUUID();
      const observer = observeSql(pool);
      let redirect: string | undefined;
      try {
        const result = await held(
          observer,
          readCheckpoint.sql,
          () => call(`${subject.id}/${kind}?property=${encodeURIComponent(property)}`, 'reader', holder.component),
          async () => {
            if (change === 'revoke') {
              await real.revoke(subject, 'reader', 'subject:read');
              await admin.query(
                `INSERT INTO access.resource_denial
                (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
                VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
                [subject.route, subject.id, accounts.reader, denial],
              );
            } else if (change === 'hide') {
              const response = await kernel.handle(
                new Request(`https://kernel.test/v1/subjects/${subject.id}:hide`, {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${real.bearer('moderator')}`,
                    'content-type': 'application/json',
                    'idempotency-key': `"${randomUUID()}"`,
                  },
                  body: JSON.stringify({ reason: 'Fresh evidence visibility race' }),
                }),
              );
              expect(response.status).toBe(200);
            } else {
              if (!mate) throw new Error('Redirect mate is missing');
              const check = await accessCheck(
                access,
                owner,
                'subject:merge',
                { route: 0, id: GLOBAL_CONTEXT },
                { pool, deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS },
              );
              await mergeSubjects(pool, {
                subjects: [subject.id, mate.id],
                survivor: mate.id,
                actor: owner,
                idempotencyKey: randomUUID(),
                digest: digest(subject.id),
                release: { digest: bundledDigest, release: bundledRelease },
                deadline: Date.now() + DEFAULT_REQUEST_DEADLINE_MS,
                authorization: {
                  action: 'subject:merge',
                  resource: { route: 0, id: GLOBAL_CONTEXT },
                  denied: () => new Error('Merge denied'),
                  authorize: async (client, attempt) => {
                    if (!(await check(client, attempt.time))) throw new Error('Merge denied');
                    return 'execute';
                  },
                },
              });
              redirect = mate.id;
              await moveMergePage(pool, subject.id, mate.id);
            }
            await catchUp(part);
          },
        );
        expect(result.status, JSON.stringify(result.body)).toBe(change === 'redirect' ? 308 : 404);
        if (redirect) expect(result.body.redirect).toEqual({ from: subject.id, to: redirect });
        else expect(result.body).not.toHaveProperty('redirect');
      } finally {
        await admin.query('DELETE FROM access.resource_denial WHERE transaction_id=$1', [denial]);
        await observer.close();
      }
    }, 60_000);
  }
}

test('a native relations retry cannot reuse a formerly allowed moderator audience after its grant is revoked', async () => {
  const part = partition();
  const holder = await create(part, 'Revoked moderator private holder', agent, true);
  const as = await actor('moderator');
  const observer = observeSql(pool);
  try {
    const result = await held(
      observer,
      readCheckpoint.sql,
      () =>
        withRequestDeadline(Date.now() + DEFAULT_REQUEST_DEADLINE_MS, async () => {
          const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
          const prepareAuthorization = () =>
            accessCheck(
              access,
              as,
              'subject:read',
              { ...holder, eligibility: subjectReadEligibility(holder) },
              { pool, deadline },
            );
          const check = await prepareAuthorization();
          return readStatementAs(pool, access, as, deadline, () =>
            listSubjectRelations(pool, tokens, {
              subject: holder.id,
              property,
              limit: 20,
              release: bundledRelease,
              authorize: check,
              prepareAuthorization,
              seen: [holder.component],
            }),
          );
        }),
      async () => {
        await real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
        await catchUp(part);
      },
    );
    expect(result.relations).toHaveLength(0);
    expect(result.count).toEqual({ value: 0, exact: true });
  } finally {
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'moderator', 'moderation:hide');
    await observer.close();
  }
}, 60_000);
