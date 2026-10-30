import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  admittedCommandAccount,
  commandAccessContext,
  installCommandAdmission,
  requireCommandAdmission,
} from '../../src/access/command-admission.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { installDurableIdentityBridge, restoreOperationIdentity } from '../../src/access/durable-identity.ts';
import {
  ApprovalIdentityDeniedError,
  installApprovalIdentityBridge,
  readApprovedIdentity,
} from '../../src/access/approved-identity.ts';
import { createAccess } from '../../src/access/index.ts';
import { principalCommandIdentity, runCommand, type CommandAuthorization } from '../../src/command/command.ts';
import type { Access } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createContentSystem, type ContentCredential } from '../content/support/system.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');

let system: Awaited<ReturnType<typeof createContentSystem>>;

beforeAll(async () => {
  system = await createContentSystem({ databaseUrl });
});

afterAll(async () => {
  await system?.close();
});

async function runAdmission(access: Access, credential: ContentCredential, beforeAdmission?: () => Promise<void>) {
  let observation: ReturnType<typeof admittedCommandAccount>;
  const deadline = Date.now() + 10_000;
  const actor = await system.access.authenticate(credential.bearer, { pool: system.database.pool, deadline });
  await beforeAdmission?.();
  const complete = new Error('Admission observed');
  const authorization: CommandAuthorization = {
    action: 'account:read',
    resource: { route: routeOf(actor.accountId)!, id: actor.accountId },
    denied: () => new Error('Admission denied'),
    async prepare(attempt) {
      const context = commandAccessContext({ pool: system.database.pool, deadline }, attempt);
      await requireCommandAdmission(access, actor, context);
      observation = admittedCommandAccount(context, actor);
      return Object.freeze({});
    },
    async authorize() {
      throw complete;
    },
  };
  try {
    await runCommand(
      system.database.pool,
      {
        ...principalCommandIdentity(actor),
        partition: partitionOf(routeOf(actor.accountId)!),
        deadline,
        authorization,
      },
      async () => {
        throw new Error('Unexpected command body');
      },
    );
  } catch (error) {
    if (error !== complete) throw error;
  }
  return observation!;
}

test.serial('derived accesses use the root command admission and preserve its observation', async () => {
  const derived = deriveAccess(system.access, {});
  const twiceDerived = deriveAccess(derived, {});
  for (const access of [derived, twiceDerived]) {
    expect(await runAdmission(access, system.actors.author)).toMatchObject({
      minimumAuthnEpoch: '1',
      operatorAccountId: null,
    });
  }

  const denied = system.actors.other.actor;
  try {
    await expect(
      runAdmission(twiceDerived, system.actors.other, async () => {
        await suspendAccount(system.database.pool, denied.accountId);
      }),
    ).rejects.toThrow('Authentication failed');
  } finally {
    await reinstateAccount(system.database.pool, denied.accountId);
  }
});

test.serial('identity bridges resolve through every derived access level', async () => {
  const derived = deriveAccess(system.access, {});
  const twiceDerived = deriveAccess(derived, {});
  const route = 0x6a31;
  const operationId = newId(route);
  const resourceId = newId(route);

  for (const access of [derived, twiceDerived]) {
    await expect(
      runCommand(system.database.pool, { partition: partitionOf(route) }, async (_tx, { time }) => {
        await restoreOperationIdentity(
          {
            pool: system.database.pool,
            access,
            async readOperation() {
              return null;
            },
            async readConsent() {
              return null;
            },
          },
          {
            operation: {
              route,
              id: operationId,
              kind: 'content.author-erasure',
              sourceId: operationId,
            },
            action: 'post:erase',
            anchor: {
              resource: { route, id: resourceId },
              async validate() {
                return true;
              },
            },
            context: { pool: system.database.pool, deadline: Date.now() + 10_000 },
          },
          time,
        );
        throw new Error('Unexpected restored identity');
      }),
    ).rejects.toThrow('Missing operation evidence');

    await expect(
      readApprovedIdentity(access, system.tokenKeys, 'invalid', {
        pool: system.database.pool,
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toBeInstanceOf(ApprovalIdentityDeniedError);
  }
});

test('registries reject installation on a derived Access', () => {
  const base = createAccess({ actions: new Map() });
  const derived = deriveAccess(base, {});
  expect(() => installCommandAdmission(derived, async () => null)).toThrow(/derived Access/);
  expect(() =>
    installDurableIdentityBridge(derived, {
      scope: {},
      async restore(_proof, _context, _time) {
        throw new Error('not used');
      },
      discard() {},
    }),
  ).toThrow(/derived Access/);
  expect(() =>
    installApprovalIdentityBridge(derived, {
      scope: {},
      expiry() {
        return undefined;
      },
      async restore(_proof, _context) {
        throw new Error('not used');
      },
    }),
  ).toThrow(/derived Access/);
});

test.serial('the composed kernel lets an author start their own erasure operation', async () => {
  const authorId = system.actors.author.actor.accountId;
  const route = 0x6a32;
  const boardId = newId(route);
  const threadId = newId(route);
  const postId = newId(route);
  await system.database.pool.query(
    `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Derived access board','published',1,$2)`,
    [route, boardId, authorId],
  );
  await system.database.pool.query(
    `INSERT INTO content.thread
      (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Derived access thread','published',1,$2)`,
    [route, threadId, authorId, boardId],
  );
  await system.database.pool.query(
    `WITH p AS (
       INSERT INTO content.post
        (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3)
       RETURNING *
     )
     INSERT INTO content.revision
      (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
       board_id,availability,recorded_transaction_id)
     SELECT route,thread_id,post_id,head_revision_id,'fixture',sha256('fixture'::bytea),'fixture',
       'CC0-1.0','{}',$6,'available',$3
     FROM p`,
    [route, threadId, postId, authorId, newId(route), boardId],
  );
  await system.database.pool.query(
    `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,'post:erase','(,)',$2)`,
    [route, postId, authorId],
  );

  const response = await system.kernel.handle(
    new Request(`https://content.test/v1/threads/${threadId}:erase`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ authorId }),
    }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    name: expect.stringMatching(/^operations\//),
    done: false,
    metadata: {
      type: 'content.author_erasure',
      threadId,
      authorId,
    },
  });
});
