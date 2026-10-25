import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg, { type QueryConfig } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess, type AccessConfig } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { batchRoute } from '../../src/semantic/bulk.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import type { Access, Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const trackedActions = [
  'subject:create',
  'subject:batch_write',
  'statement:propose',
  'moderation:hide',
  'context:accept',
  'context:adopt',
] as const;
const commandBackends = new Set<number>();
const checks: { action: string; resource: Resource; backend: number; inCommand: boolean }[] = [];

pool.on('connect', (client) => {
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  const backend = (client as unknown as { processID: number }).processID;
  client.query = ((query: string | QueryConfig, ...args: unknown[]) => {
    const statement = typeof query === 'string' ? query : query.text;
    const track = () => {
      if (/^\s*BEGIN\s+ISOLATION\s+LEVEL\s+SERIALIZABLE\b/i.test(statement)) commandBackends.add(backend);
      else if (/^\s*(?:COMMIT|ROLLBACK)\b/i.test(statement)) commandBackends.delete(backend);
    };
    const callbackIndex = args.findIndex((argument) => typeof argument === 'function');
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => void;
      args[callbackIndex] = (...callbackArgs: unknown[]) => {
        if (!callbackArgs[0]) track();
        callback(...callbackArgs);
      };
      return original(query, ...args);
    }
    return (original(query, ...args) as Promise<unknown>).then((result) => {
      track();
      return result;
    });
  }) as typeof client.query;
});

const accounts = {
  writer: newId(0x1111),
  elsewhere: newId(0x2222),
  decisionWriter: newId(0x2a22),
  contextOwner: newId(0x3333),
  contextElsewhere: newId(0x4444),
  replayWriter: newId(0x5555),
};
type AccountName = keyof typeof accounts;
const actions = ['access:grant', 'context:create', 'context:read', ...trackedActions];
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const routeKey = new Uint8Array(32).fill(41);
const signing = await generateKeyPair('ES256', { extractable: true });
let jwk: Record<string, unknown>;
const auth = {
  issuer: 'https://auth.example.test',
  audience: 'https://api.rezics.test',
  jwksUrl: 'https://auth.example.test/jwks',
  fetch: async () => Response.json({ keys: [jwk] }),
};
const bearerTokens = {} as Record<AccountName, string>;

function wrapAccess(config: AccessConfig): Access {
  const real = createAccess({ ...config, auth });
  return {
    authenticate(token, context) {
      return real.authenticate(token, context);
    },
    prepare(actor, action, resource, context) {
      return real.prepare!(actor, action, resource, context);
    },
    replayAuthorization(action) {
      return real.replayAuthorization?.(action);
    },
    async authorize(client, actor, action, resource, evidence, time) {
      if ((trackedActions as readonly string[]).includes(action)) {
        const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const backend = Number(result.rows[0]?.pid);
        checks.push({
          action,
          resource: { route: resource.route, id: resource.id },
          backend,
          inCommand: commandBackends.has(backend),
        });
      }
      return real.authorize(client, actor, action, resource, evidence, time);
    },
  };
}

const kernel = createKernel({
  pool,
  access: wrapAccess,
  tokens,
  routeKey,
  writeRate: createWriteRateLimiter({ secret: 'semantic-anchored-authorization-test-secret' }),
});

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  jwk = { ...(await exportJWK(signing.publicKey)), kid: 'anchored-authorization', alg: 'ES256' };
  for (const [name, accountId] of Object.entries(accounts) as [AccountName, string][]) {
    bearerTokens[name] = await new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'anchored-authorization', typ: 'at+jwt' })
      .setIssuer(auth.issuer)
      .setAudience(auth.audience)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(signing.privateKey);
    await admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(accountId), accountId],
    );
  }
}, 60_000);

afterAll(async () => {
  await pool.end();
  await admin.end();
});

const key = () => randomUUID();
const header = (idempotencyKey: string) => JSON.stringify(idempotencyKey);

async function call(method: string, path: string, options: { token?: AccountName; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${bearerTokens[options.token]}`;
  if (options.key !== undefined) headers['idempotency-key'] = header(options.key);
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function grant(resource: Resource, account: string, action: string) {
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$3) ON CONFLICT DO NOTHING`,
    [resource.route, resource.id, account, action],
  );
}

async function seedContext(): Promise<Resource> {
  const id = newId(0x0550);
  const route = routeOf(id)!;
  await admin.query("INSERT INTO semantic.context(route,context_id,kind,labels) VALUES ($1,$2,'community',$3)", [
    route,
    id,
    { en: 'Unrelated authority' },
  ]);
  return { route, id };
}

async function grantAt(resource: Resource, account: string, actionList: readonly string[]) {
  for (const action of actionList) await grant(resource, account, action);
}

async function receiptCount(account: string, idempotencyKey: string): Promise<number> {
  const result = await admin.query(
    'SELECT count(*)::int AS count FROM core.receipt WHERE principal_id=$1 AND idempotency_key=$2',
    [account, idempotencyKey],
  );
  return result.rows[0].count;
}

function anchoredChecks(action: string, resource: Resource) {
  return checks.filter(
    (check) => check.action === action && check.resource.route === resource.route && check.resource.id === resource.id,
  );
}

function subjectBody(label: string) {
  return { type: 'schema:Book', labels: { en: label } };
}

async function createSubject(token: AccountName, label: string, excludedPartition = 0) {
  for (;;) {
    const idempotencyKey = key();
    const target = subjectTarget(routeKey, accounts[token], idempotencyKey);
    if (partitionOf(target.route) === 0 || partitionOf(target.route) === excludedPartition) continue;
    const answer = await call('POST', '/v1/subjects', {
      token,
      key: idempotencyKey,
      body: subjectBody(label),
    });
    return { ...answer, idempotencyKey };
  }
}

function factsCommand(commandKey: string, externalId: string) {
  return {
    op: 'create' as const,
    key: commandKey,
    source: {
      source: 'openlibrary',
      external_id: externalId,
      record_revision: '1',
      digest: 'a'.repeat(64),
      converter_revision: 'openlibrary@1',
      field_group: 'facts' as const,
    },
    subject: subjectBody(`Batch ${externalId}`),
  };
}

test('writes authorized on the Global Context check it outside the target command transaction', async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  const elsewhere = await seedContext();
  const globalActions = ['subject:create', 'subject:batch_write', 'statement:propose', 'moderation:hide'];
  await grantAt(global, accounts.writer, globalActions);
  await grantAt(elsewhere, accounts.elsewhere, globalActions);

  const created = await createSubject('writer', 'Global creation');
  expect(created.response.status).toBe(201);
  const subject = created.body.subject.id as string;

  let batch: ReturnType<typeof factsCommand>;
  let batchKey: string;
  for (;;) {
    batchKey = key();
    batch = factsCommand(batchKey, `OL${key()}W`);
    const route = batchRoute(routeKey, batch);
    if (route !== null && partitionOf(route) !== 0) break;
  }
  const batchAnswer = await call('POST', '/v1/subjects:batchWrite', {
    token: 'writer',
    body: { commands: [batch] },
  });
  expect(batchAnswer.response.status).toBe(200);
  expect(batchAnswer.body.results[0]).toMatchObject({ status: 201, key: batchKey });

  const proposalKey = key();
  const proposal = await call('POST', `/v1/subjects/${subject}/candidates`, {
    token: 'writer',
    key: proposalKey,
    body: {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.test/book' },
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
    },
  });
  expect(proposal.response.status, JSON.stringify(proposal.body)).toBe(201);

  const deniedCreateKey = key();
  const deniedCreate = await call('POST', '/v1/subjects', {
    token: 'elsewhere',
    key: deniedCreateKey,
    body: subjectBody('Denied global creation'),
  });
  expect([deniedCreate.response.status, deniedCreate.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.elsewhere, deniedCreateKey)).toBe(0);

  const deniedBatchKey = key();
  const deniedBatch = factsCommand(deniedBatchKey, `OL${key()}W`);
  const deniedBatchAnswer = await call('POST', '/v1/subjects:batchWrite', {
    token: 'elsewhere',
    body: { commands: [deniedBatch] },
  });
  expect([deniedBatchAnswer.response.status, deniedBatchAnswer.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.elsewhere, deniedBatchKey)).toBe(0);

  const deniedProposalKey = key();
  const deniedProposal = await call('POST', `/v1/subjects/${subject}/candidates`, {
    token: 'elsewhere',
    key: deniedProposalKey,
    body: {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.test/elsewhere' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.test/elsewhere-source' },
              },
            ],
          },
        ],
      },
    },
  });
  expect([deniedProposal.response.status, deniedProposal.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.elsewhere, deniedProposalKey)).toBe(0);

  const deniedModerationKey = key();
  const deniedModeration = await call('POST', `/v1/subjects/${subject}:hide`, {
    token: 'elsewhere',
    key: deniedModerationKey,
    body: { reason: 'Not authorized on the Global Context' },
  });
  expect([deniedModeration.response.status, deniedModeration.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.elsewhere, deniedModerationKey)).toBe(0);

  const moderationKey = key();
  const moderation = await call('POST', `/v1/subjects/${subject}:hide`, {
    token: 'writer',
    key: moderationKey,
    body: { reason: 'Hide for the anchored authorization test' },
  });
  expect(moderation.response.status).toBe(200);

  for (const action of trackedActions.slice(0, 4)) {
    const observed = anchoredChecks(action, global);
    expect(observed.length, `${action} should check the Global Context`).toBeGreaterThan(0);
    expect(
      observed.every((check) => !check.inCommand),
      `${action} must be checked outside the target transaction`,
    ).toBe(true);
  }
});

test('Context decisions check the Context outside the target command transaction', async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  await grant(global, accounts.decisionWriter, 'subject:create');
  await grant(global, accounts.decisionWriter, 'statement:propose');

  const context = await seedContext();
  const otherContext = await seedContext();
  await grantAt(context, accounts.contextOwner, ['context:accept', 'context:adopt']);
  await grantAt(otherContext, accounts.contextElsewhere, ['context:accept', 'context:adopt']);

  const created = await createSubject('decisionWriter', 'Decision subject', partitionOf(context.route));
  expect(created.response.status).toBe(201);
  const subject = created.body.subject.id as string;
  const proposalKey = key();
  const proposal = await call('POST', `/v1/subjects/${subject}/candidates`, {
    token: 'writer',
    key: proposalKey,
    body: {
      statement: {
        property: { id: 'schema:url' },
        value: { type: 'value', content: 'https://example.test/decision' },
        references: [
          {
            parts: [
              {
                property: { id: 'schema:url' },
                value: { type: 'value', content: 'https://example.test/decision-source' },
              },
            ],
          },
        ],
      },
    },
  });
  expect(proposal.response.status, JSON.stringify(proposal.body)).toBe(201);
  const candidate = proposal.body.candidate as string;

  const acceptKey = key();
  const accepted = await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, {
    token: 'contextOwner',
    key: acceptKey,
    body: { context: context.id, expected_head: null },
  });
  expect(accepted.response.status).toBe(200);

  const adoptionKey = key();
  const adopted = await call('POST', `/v1/subjects/${subject}:adopt`, {
    token: 'contextOwner',
    key: adoptionKey,
    body: {
      context: context.id,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: null,
    },
  });
  expect(adopted.response.status).toBe(200);

  const deniedAcceptKey = key();
  const deniedAccept = await call('POST', `/v1/subjects/${subject}/candidates/${candidate}:accept`, {
    token: 'contextElsewhere',
    key: deniedAcceptKey,
    body: { context: context.id, expected_head: 1 },
  });
  expect([deniedAccept.response.status, deniedAccept.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.contextElsewhere, deniedAcceptKey)).toBe(0);

  const deniedAdoptionKey = key();
  const deniedAdoption = await call('POST', `/v1/subjects/${subject}:adopt`, {
    token: 'contextElsewhere',
    key: deniedAdoptionKey,
    body: {
      context: context.id,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate, rank: 'normal' }],
      expected_head: 1,
    },
  });
  expect([deniedAdoption.response.status, deniedAdoption.body.code]).toEqual([403, 'forbidden']);
  expect(await receiptCount(accounts.contextElsewhere, deniedAdoptionKey)).toBe(0);

  for (const action of ['context:accept', 'context:adopt']) {
    const observed = anchoredChecks(action, context);
    expect(observed.length, `${action} should check its Context`).toBeGreaterThan(0);
    expect(
      observed.every((check) => !check.inCommand),
      `${action} must be checked outside the target transaction`,
    ).toBe(true);
  }
});

test('a replay rechecks the anchored authority and a revoked grant denies it without disclosing the receipt', async () => {
  const global = { route: 0, id: GLOBAL_CONTEXT };
  await grant(global, accounts.replayWriter, 'subject:create');

  const idempotencyKey = key();
  const created = await call('POST', '/v1/subjects', {
    token: 'replayWriter',
    key: idempotencyKey,
    body: subjectBody('Replay authority'),
  });
  expect(created.response.status).toBe(201);
  const subject = created.body.subject.id as string;

  await admin.query(
    `DELETE FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='subject:create'`,
    [global.route, global.id, accounts.replayWriter],
  );
  const beforeReplayChecks = checks.length;
  const replay = await call('POST', '/v1/subjects', {
    token: 'replayWriter',
    key: idempotencyKey,
    body: subjectBody('Replay authority'),
  });
  expect([replay.response.status, replay.body.code]).toEqual([403, 'forbidden']);
  expect(replay.body).not.toHaveProperty('receipt');
  expect(JSON.stringify(replay.body)).not.toContain(subject);
  expect(replay.response.headers.get('rezics-session-token')).toBeNull();

  const replayChecks = checks.slice(beforeReplayChecks).filter((check) => check.action === 'subject:create');
  expect(replayChecks.length).toBeGreaterThan(0);
  expect(replayChecks.every((check) => check.resource.route === global.route && check.resource.id === global.id)).toBe(
    true,
  );
  expect(replayChecks.every((check) => !check.inCommand)).toBe(true);
});
