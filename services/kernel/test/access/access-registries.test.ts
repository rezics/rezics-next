import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import {
  ApprovalIdentityDeniedError,
  ApprovalIdentityUnavailableError,
  readApprovedIdentity,
} from '../../src/access/approved-identity.ts';
import { requireCommandAdmission, commandAccessContext } from '../../src/access/command-admission.ts';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { restoreOperationIdentity } from '../../src/access/durable-identity.ts';
import { authorizePlatformGate, createAccess } from '../../src/access/index.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { runCommand, type CommandAttempt, type CommandAuthorization } from '../../src/command/command.ts';
import type { Access, AccessContext, AccountActor, Actor } from '../../src/request/access.ts';
import { newId } from '../../src/route/route.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());

const keys: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const anonymous: Actor = { kind: 'anonymous' };
const account: AccountActor = {
  kind: 'account',
  accountId: newId(0x1234),
  clientId: 'registry',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};
const actions = new Map([['subject:read', { anonymous: false }]]);
const gateResource = { route: 1, id: newId(1) };

function bareAccess(): Access {
  return {
    async authenticate() {
      throw new Error('unused');
    },
    async authorize() {
      return false;
    },
  };
}

function wrap(access: Access): Access {
  return {
    authenticate: (token, context) => access.authenticate(token, context),
    ...(access.prepare ? { prepare: (...args) => access.prepare!(...args) } : {}),
    ...(access.replayAuthorization ? { replayAuthorization: (action) => access.replayAuthorization!(action) } : {}),
    authorize: (...args) => access.authorize(...args),
  };
}

async function duringCommand(check: (attempt: CommandAttempt) => Promise<void>): Promise<void> {
  const observed = new Error('registry observation');
  const authorization: CommandAuthorization = {
    action: 'account:read',
    resource: { route: 0, id: '00000000-0000-8000-8000-000000000000' },
    denied: () => new Error('denied'),
    async prepare(attempt) {
      await check(attempt);
      throw observed;
    },
    async authorize() {
      return 'execute';
    },
  };
  try {
    await runCommand(pool, { partition: 0, deadline: Date.now() + 10_000, authorization }, async () => {
      throw new Error('command body');
    });
  } catch (error) {
    if (error !== observed) throw error;
  }
}

function commandContext(attempt: CommandAttempt): AccessContext {
  return commandAccessContext({ pool, deadline: Date.now() + 10_000 }, attempt);
}

const unreachablePool = {
  connect() {
    throw new Error('platform-gate-check');
  },
} as unknown as Pool;

async function platformGate(access: Access): Promise<boolean> {
  return authorizePlatformGate(
    access,
    account,
    ['gate:any'],
    'subject:read',
    gateResource,
    { pool: unreachablePool, deadline: Date.now() + 10_000 },
    new Date().toISOString(),
  );
}

test('a command through an Access with no command admission is refused', async () => {
  const access = bareAccess();
  await duringCommand(async (attempt) => {
    const context = commandContext(attempt);
    await expect(requireCommandAdmission(access, anonymous, context)).rejects.toThrow('Command admission denied');
    await expect(requireCommandAdmission(access, account, context)).rejects.toThrow('Command admission denied');
  });
});

test('an Access wrapped without deriveAccess is refused by admission and both identity bridges', async () => {
  const root = createAccess({ actions });
  const wrapped = wrap(root);
  await duringCommand(async (attempt) => {
    await expect(requireCommandAdmission(wrapped, anonymous, commandContext(attempt))).rejects.toThrow(
      'Command admission denied',
    );
    const route = 0x6a31;
    const operationId = newId(route);
    await expect(
      restoreOperationIdentity(
        {
          access: wrapped,
          pool,
          async readOperation() {
            return null;
          },
          async readConsent() {
            return null;
          },
        },
        {
          operation: { route, id: operationId, kind: 'content.author-erasure', sourceId: operationId },
          action: 'post:erase',
          anchor: {
            resource: { route, id: newId(route) },
            async validate() {
              return true;
            },
          },
          context: { pool, deadline: Date.now() + 10_000 },
        },
        attempt.time,
      ),
    ).rejects.toThrow('Durable identity unavailable');
  });
  await expect(
    readApprovedIdentity(wrapped, keys, 'invalid', { pool, deadline: Date.now() + 10_000 }),
  ).rejects.toBeInstanceOf(ApprovalIdentityUnavailableError);
  expect(resourceRoleCatalogue(wrapped)).toBeUndefined();
  await expect(platformGate(wrapped)).resolves.toBe(false);
});

test('deriveAccess keeps admission, identity bridges, platform gate checks and resource roles', async () => {
  const root = createAccess({ actions });
  const derived = deriveAccess(root, {});
  const twiceDerived = deriveAccess(derived, {});
  expect(resourceRoleCatalogue(derived)).toBe(resourceRoleCatalogue(root));
  expect(resourceRoleCatalogue(twiceDerived)).toBe(resourceRoleCatalogue(root));
  expect(resourceRoleCatalogue(root)?.types.has('content.report')).toBe(true);

  for (const access of [root, derived, twiceDerived]) {
    await duringCommand(async (attempt) => {
      await expect(requireCommandAdmission(access, anonymous, commandContext(attempt))).resolves.toBeUndefined();
      const route = 0x6a32;
      const operationId = newId(route);
      await expect(
        restoreOperationIdentity(
          {
            access,
            pool,
            async readOperation() {
              return null;
            },
            async readConsent() {
              return null;
            },
          },
          {
            operation: { route, id: operationId, kind: 'content.author-erasure', sourceId: operationId },
            action: 'post:erase',
            anchor: {
              resource: { route, id: newId(route) },
              async validate() {
                return true;
              },
            },
            context: { pool, deadline: Date.now() + 10_000 },
          },
          attempt.time,
        ),
      ).rejects.toThrow('Missing operation evidence');
    });
    await expect(
      readApprovedIdentity(access, keys, 'invalid', { pool, deadline: Date.now() + 10_000 }),
    ).rejects.toBeInstanceOf(ApprovalIdentityDeniedError);
    await expect(platformGate(access)).rejects.toThrow('platform-gate-check');
  }
});
