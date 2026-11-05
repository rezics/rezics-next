import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createKernel } from '../../src/http/kernel.ts';
import { accessCheck, type Access, type AccountActor } from '../../src/request/access.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  readStatementAs,
  statementAudience,
  withPublicStatementReader,
  withStatementReader,
  type StatementReader,
} from '../../src/semantic/statement-disclosure.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from './outcome-driver.ts';

const property = 'rezics:penNameOf';
const SESSION = 'rezics-session-token';
const key = () => ({ 'Idempotency-Key': `"${randomUUID()}"` });
const statement = (target: string, sourced = false) => ({
  property: { id: property },
  value: { type: 'value', content: target },
  references: sourced
    ? [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.org/bio' } }] }]
    : [],
  qualifiers: [],
});
function record(value: unknown): Record<string, any> {
  expect(value).toBeObject();
  return value as Record<string, any>;
}
function status(response: HttpResponse, expected = 200) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let driver: SemanticOutcomeDriver;
let access: Access;
let ring: KeyRing;
let owner: Awaited<ReturnType<SemanticOutcomeDriver['fixtures']['person']>>;
let moderatorAccount: typeof owner;
let actor: AccountActor;
let moderator: AccountActor;
let ownerReader: StatementReader;
let moderatorReader: StatementReader;
let pen: string;
let agent: string;
let publicTarget: string;
let privateCandidate: string;
let publicCandidate: string;
let incoming: string;
let creation: HttpResponse;
let creationBody: unknown;
const creationKey = key();

beforeAll(async () => {
  driver = await createSemanticDriver((config) => {
    ring = config.tokens!;
    const factory = config.access;
    if (typeof factory !== 'function') throw new Error('Native Semantic driver must supply its Access factory');
    return createKernel({ ...config, access: (options) => (access = factory(options)) });
  });
  const { fixtures } = driver;
  owner = await fixtures.person('scope_owner');
  moderatorAccount = await fixtures.person('scope_moderator');
  await fixtures.grantAccount(owner, ['subject:create', 'statement:propose']);
  await fixtures.grantAccount(moderatorAccount, ['moderation:hide', 'moderation:takedown']);
  const boundary = { pool: fixtures.pool, deadline: Date.now() + 10_000 };
  actor = await access.authenticate(owner.bearer, boundary);
  moderator = await access.authenticate(moderatorAccount.bearer, boundary);
  async function reader(as: AccountActor): Promise<StatementReader> {
    const check = await accessCheck(access, as, 'moderation:hide', { route: 0, id: GLOBAL_CONTEXT }, boundary);
    return { account: as.accountId, moderator: (client) => check(client) };
  }
  ownerReader = await reader(actor);
  moderatorReader = await reader(moderator);
  agent = (
    await ensureAccountAgent(fixtures.pool, {
      account: owner.accountId,
      kind: 'person',
      name: 'Private scope owner',
    })
  ).subject.id;
  const target = await fixtures.send(
    owner,
    'POST',
    '/v1/subjects',
    {
      type: 'schema:Person',
      labels: { en: 'Public identity' },
    },
    key(),
  );
  status(target, 201);
  publicTarget = record(target.body.subject).id;
  creationBody = {
    type: 'schema:Person',
    labels: { en: 'Public pen name' },
    statements: { [property]: [statement(agent), statement(publicTarget, true)] },
  };
  creation = await fixtures.send(owner, 'POST', '/v1/subjects', creationBody, creationKey);
  status(creation, 201);
  const subject = record(creation.body.subject);
  pen = subject.id;
  const facts = subject.statements[property] as { id: string; value: { content: string } }[];
  privateCandidate = facts.find(({ value }) => value.content === agent)!.id;
  publicCandidate = facts.find(({ value }) => value.content === publicTarget)!.id;
  incoming = (await fixtures.send(owner, 'GET', `/v1/subjects/${pen}`)).headers.get(SESSION)!;
  expect(incoming).toBeString();
}, 180_000);

afterAll(async () => {
  await driver?.close();
});

const asOwner = <T>(read: () => Promise<T>) =>
  readStatementAs(driver.fixtures.pool, access, actor, Date.now() + 10_000, read);
async function read(path: string, caller = owner) {
  const response = await driver.fixtures.send(
    caller,
    'GET',
    path,
    undefined,
    caller === owner ? { [SESSION]: incoming } : undefined,
  );
  status(response);
  const token = response.headers.get(SESSION);
  if (token !== null && caller === owner) {
    const scope = `account:${owner.accountId}`;
    const before = decodeSession(ring, scope, incoming)!;
    const after = decodeSession(ring, scope, token)!;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    for (const required of before) {
      const actual = after.find(({ partition }) => partition === required.partition)!;
      expect(actual).toBeDefined();
      expect(actual.epoch).toBeGreaterThanOrEqual(required.epoch);
      if (actual.epoch === required.epoch) expect(actual.position >= required.position).toBe(true);
    }
  }
  return response.body;
}
async function snapshot(caller = owner) {
  return {
    subject: await read(`/v1/subjects/${pen}`, caller),
    forward: await read(`/v1/subjects/${pen}/relations?property=${encodeURIComponent(property)}`, caller),
    inverse: await read(`/v1/subjects/${agent}/links?property=${encodeURIComponent(property)}`, caller),
  };
}
async function audience() {
  const client = await driver.fixtures.pool.connect();
  try {
    return await statementAudience(client);
  } finally {
    client.release();
  }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
function disclosed(value: Snapshot, privateVisible: boolean) {
  const subject = record(value.subject.subject);
  const ids = (subject.statements[property] ?? []).map((fact: { id: string }) => fact.id);
  expect(ids).toContain(publicCandidate);
  expect(ids.includes(privateCandidate)).toBe(privateVisible);
  expect(subject.labels).toEqual({ en: 'Public pen name' });
  expect(subject.relationCounts[property]).toBe(privateVisible ? 2 : 1);
  const related = record(value.subject.related);
  expect(record(related[publicTarget]).labels).toEqual({ en: 'Public identity' });
  expect(Object.hasOwn(related, agent)).toBe(privateVisible);
  const forward = (value.forward.relations as { statement: { id: string } }[]).map(({ statement }) => statement.id);
  expect(forward).toContain(publicCandidate);
  expect(forward.includes(privateCandidate)).toBe(privateVisible);
  expect(value.forward.count).toEqual({ value: privateVisible ? 2 : 1, exact: true });
  const inverse = (value.inverse.links as { statement: string }[]).map(({ statement }) => statement);
  expect(inverse.includes(privateCandidate)).toBe(privateVisible);
  expect(value.inverse.count).toEqual({ value: privateVisible ? 1 : 0, exact: true });
  if (!privateVisible) expect(JSON.stringify(value.subject)).not.toContain(agent);
}

test('forced public statement scope stays public across nested real caller hydration while standalone private hydration remains authorized', async () => {
  const revisions = await driver.inspect.revisions(pen);
  disclosed(await snapshot(), true);
  disclosed(await snapshot(moderatorAccount), true);
  disclosed(await withStatementReader(ownerReader, snapshot), true);
  disclosed(await withStatementReader(moderatorReader, snapshot), true);
  await asOwner(async () => {
    expect(await audience()).toEqual({ viewer_account: owner.accountId, viewer_moderator: false });
    await withPublicStatementReader(async () => {
      expect(await audience()).toEqual({
        viewer_account: '00000000-0000-0000-0000-000000000000',
        viewer_moderator: false,
      });
      disclosed(await snapshot(), false);
      disclosed(await asOwner(snapshot), false);
      disclosed(
        await readStatementAs(driver.fixtures.pool, access, moderator, Date.now() + 10_000, () =>
          snapshot(moderatorAccount),
        ),
        false,
      );
      disclosed(await withStatementReader(ownerReader, snapshot), false);
      disclosed(await withStatementReader(moderatorReader, () => withPublicStatementReader(snapshot)), false);
    });
    expect(await audience()).toEqual({ viewer_account: owner.accountId, viewer_moderator: false });
    disclosed(await snapshot(), true);
  });
  expect(await audience()).toEqual({ viewer_account: '00000000-0000-0000-0000-000000000000', viewer_moderator: false });
  disclosed(await snapshot(), true);
  expect(await driver.inspect.revisions(pen)).toEqual(revisions);
  const replay = await driver.fixtures.send(owner, 'POST', '/v1/subjects', creationBody, creationKey);
  status(replay, 201);
  expect(replay.body).toEqual(creation.body);
  expect(await driver.inspect.revisions(pen)).toEqual(revisions);
  const invalid = await withPublicStatementReader(() =>
    driver.fixtures.send(null, 'GET', `/v1/subjects/${pen}`, undefined, {
      authorization: 'Bearer invalid-native-token',
    }),
  );
  status(invalid, 401);
  expect(invalid.body.code).toBe('invalid_credentials');
  expect(invalid.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
}, 180_000);

test('public scope restores across nested async failures and isolates simultaneous requests with the same real bearer', async () => {
  const failure = new Error('scope exit');
  expect(withPublicStatementReader(() => 17)).toBe(17);
  await asOwner(async () => {
    expect(() =>
      withPublicStatementReader(() => {
        throw failure;
      }),
    ).toThrow(failure);
    disclosed(await snapshot(), true);
    await expect(
      withPublicStatementReader(async () => {
        await Promise.resolve();
        await expect(
          withStatementReader(moderatorReader, async () => {
            disclosed(await asOwner(snapshot), false);
            throw failure;
          }),
        ).rejects.toBe(failure);
        disclosed(await snapshot(), false);
        throw failure;
      }),
    ).rejects.toBe(failure);
    disclosed(await snapshot(), true);
  });
  const publicEntered = deferred();
  const privateRead = deferred();
  const publicRead = deferred();
  await Promise.all([
    withPublicStatementReader(async () => {
      publicEntered.resolve();
      try {
        await privateRead.promise;
        disclosed(await asOwner(snapshot), false);
        publicRead.resolve();
        throw failure;
      } finally {
        publicRead.resolve();
      }
    }).then(
      () => {
        throw new Error('Expected public scope failure');
      },
      (error) => expect(error).toBe(failure),
    ),
    (async () => {
      await publicEntered.promise;
      try {
        disclosed(await snapshot(), true);
      } finally {
        privateRead.resolve();
      }
      await publicRead.promise;
      disclosed(await snapshot(), true);
    })(),
  ]);
  disclosed(await snapshot(), true);

  // Consent and terminal retraction still consult current native state inside a public scope.
  const discloseKey = key();
  const consent = await driver.fixtures.send(
    owner,
    'POST',
    `/v1/statements/${privateCandidate}/disclose`,
    undefined,
    discloseKey,
  );
  status(consent);
  const replay = await driver.fixtures.send(
    owner,
    'POST',
    `/v1/statements/${privateCandidate}/disclose`,
    undefined,
    discloseKey,
  );
  status(replay);
  expect(replay.body).toEqual(consent.body);
  disclosed(await withPublicStatementReader(snapshot), true);
  const retract = await driver.fixtures.send(
    owner,
    'POST',
    `/v1/statements/${privateCandidate}/retract`,
    undefined,
    key(),
  );
  status(retract);
  disclosed(await withPublicStatementReader(snapshot), false);
  disclosed(await snapshot(), false);
}, 180_000);
