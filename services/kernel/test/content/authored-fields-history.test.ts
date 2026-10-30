import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import {
  principalCommandIdentity,
  runCommand,
  type CommandResult,
  type CommandTransaction,
} from '../../src/command/command.ts';
import { appendAuthoredField, eraseAuthoredField, readAuthoredField } from '../../src/content/authored-fields.ts';
import { readAuthoredFieldHistorySource } from '../../src/content/authored-fields-history.ts';
import { ContentNotFoundError } from '../../src/content/commands.ts';
import { ACCOUNT_ROLE_BITS, type HistoryArtifactType } from '../../src/history/contracts.ts';
import { decodeLocator } from '../../src/history/locator.ts';
import { declareCommandHistory, registerCommandHistoryKind } from '../../src/history/record.ts';
import {
  beginRecordHistorySerialization,
  commandRecordSources,
  declareCommandRecordSources,
  recordHistorySourceKey,
  type RecordHistorySourceReference,
} from '../../src/history/record-source.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

setDefaultTimeout(120_000);

const route = 0xc120;
const subject = newId(route);
const actions = ['subject:update', 'document:erase'];
const outerKind = 'content.authored_field.history_test';
registerCommandHistoryKind(outerKind, 0xff000100);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let access: ReturnType<typeof admittedAccess>;
let author: AccountActor;
let other: AccountActor;
const context = () => ({ idempotencyKey: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 120_000 });

async function grant(resourceId: string, accountId: string, action: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$5)`,
    [routeOf(resourceId), resourceId, accountId, action, randomUUID()],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  access = admittedAccess({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  async function account(): Promise<AccountActor> {
    const accountId = newId(0xc230);
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
       VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(accountId), accountId],
    );
    return authenticateAccount(
      access,
      { pool: db.pool, deadline: Date.now() + 10_000 },
      {
        accountId,
        clientId: 'web',
        scopes: actions,
        requestedBy: null,
      },
    );
  }
  author = await account();
  other = await account();
  await grant(subject, author.accountId, 'subject:update');
});

afterAll(async () => {
  await db?.close();
});

async function outer<T>(
  work: (tx: CommandTransaction) => Promise<CommandResult<T>>,
  target = subject,
  withReceipt = false,
) {
  const authorization = await accessCommandAuthorization(
    access,
    author,
    'subject:update',
    { route: routeOf(target)!, id: target },
    { pool: db.pool, deadline: Date.now() + 10_000 },
    () => new ContentNotFoundError(),
  );
  return runCommand(
    db.pool,
    {
      ...principalCommandIdentity(author),
      partition: partitionOf(routeOf(target)!),
      deadline: Date.now() + 120_000,
      authorization,
      ...(withReceipt
        ? {
            receipt: {
              kind: outerKind,
              key: randomUUID(),
              digest: createHash('sha256').update(target).digest(),
            },
          }
        : {}),
    },
    work,
  );
}

function result<T>(value: T): CommandResult<T> {
  return { value, events: [{ type: 'com.rezics.test.imported.v1', data: {} }] };
}

function append(tx: CommandTransaction, revision = 7) {
  return appendAuthoredField(tx, {
    subject,
    candidate: newId(route),
    revision,
    document: fromPlainText('Native original text'),
    licence: 'CC-BY-4.0',
    language: 'en',
  });
}

async function field() {
  const stored = (await outer(async (tx) => result(await append(tx)))).value;
  const native = await readAuthoredField(db.pool, route, stored.id);
  if (!native) throw new Error('Missing appended native field');
  const source: Extract<RecordHistorySourceReference, { kind: 'contribution' }> = {
    kind: 'contribution',
    subjectId: native.subject,
    candidateId: native.candidate,
    revision: native.revision,
    documentId: native.id,
  };
  return { stored, source };
}

async function copies(source: RecordHistorySourceReference) {
  return (
    await db.admin.query<{
      artifact_type: HistoryArtifactType;
      locator: Buffer;
      original_transaction: string;
      original_position: string;
    }>(
      `SELECT artifact_type,locator,original_transaction,original_position::text
     FROM core.record_history_locator WHERE source_key=$1 ORDER BY artifact_type`,
      [recordHistorySourceKey(source)],
    )
  ).rows;
}

test('actual standalone authored-field command enrolls exact original native source before serialization without a repeated outer declaration or source completeness permission claim', async () => {
  const { stored, source } = await field();
  expect(Object.keys(stored).sort()).toEqual(['digest', 'id']);
  expect(await copies(source)).toEqual([]);
  const request = context();
  const erased = await eraseAuthoredField({ pool: db.pool, access }, author, stored.id, request);
  expect(erased).toMatchObject({ replayed: false, value: { id: stored.id, subject, authorId: author.accountId } });
  if (!erased) throw new Error('Standalone erase did not commit');
  expect(Object.keys(erased.value).sort()).toEqual(['authorId', 'id', 'subject']);
  const enrolled = await copies(source);
  expect(enrolled.map((row) => row.artifact_type)).toEqual(['command-receipt/v1', 'outbox-event/v1']);
  for (const row of enrolled) {
    expect(row.original_transaction).toBe(erased.transactionId);
    expect(row.original_position).toBe(erased.position.toString());
    const locator = decodeLocator(row.artifact_type, row.locator);
    if (locator.artifactType === 'command-receipt/v1') {
      expect(locator).toMatchObject({
        partitionNo: partitionOf(route),
        principalKind: 'account',
        principalId: author.accountId,
        commandKindId: 2000,
      });
      const receipt = (
        await db.admin.query<{ idempotency_key: string }>(
          'SELECT idempotency_key FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2',
          [partitionOf(route), erased.transactionId],
        )
      ).rows[0]!;
      const [, version, token] = receipt.idempotency_key.split('.');
      expect(locator.keyVersion).toBe(Number(version));
      expect(locator.keyToken).toBe(Buffer.from(token!, 'base64url').toString('hex'));
    } else if (locator.artifactType === 'outbox-event/v1') {
      expect(locator).toEqual({
        artifactType: 'outbox-event/v1',
        partitionNo: partitionOf(route),
        position: erased.position,
        eventSeq: 0,
      });
    }
    const accounts = (
      await db.admin.query<{ account_id: string; roles: number }>(
        'SELECT account_id,roles FROM core.history_locator WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3',
        [partitionOf(route), row.artifact_type, row.locator],
      )
    ).rows;
    expect(accounts).toContainEqual({
      account_id: author.accountId,
      roles:
        ACCOUNT_ROLE_BITS.author |
        ACCOUNT_ROLE_BITS.actor |
        ACCOUNT_ROLE_BITS.principal |
        ACCOUNT_ROLE_BITS['acting-human'],
    });
  }
  expect(await readAuthoredField(db.pool, route, stored.id)).toMatchObject({
    availability: 'erased',
    body: null,
    digest: stored.digest,
  });
  expect((await outer(async (tx) => result(await readAuthoredFieldHistorySource(tx, stored.id)))).value).toEqual(
    source,
  );
  expect(await eraseAuthoredField({ pool: db.pool, access }, author, stored.id, request)).toMatchObject({
    replayed: true,
  });
  expect(await eraseAuthoredField({ pool: db.pool, access }, author, stored.id, context())).toBeNull();
  expect(await copies(source)).toEqual(enrolled);
  expect(
    (
      await db.admin.query("SELECT id FROM core.outbox WHERE partition_no=$1 AND type=$2 AND data->>'id'=$3", [
        partitionOf(route),
        'com.rezics.content.authored-field.erased.v1',
        stored.id,
      ])
    ).rows,
  ).toHaveLength(1);
});

test('metadata absence grants no source evidence and the helper requires the actual home command', async () => {
  const missing = newId(route);
  expect((await outer(async (tx) => result(await readAuthoredFieldHistorySource(tx, missing)))).value).toBeNull();
  await expect(readAuthoredFieldHistorySource(db.pool, missing)).rejects.toBeInstanceOf(TypeError);
  await expect(outer(async (tx) => result(await readAuthoredFieldHistorySource(tx, 'invalid')))).rejects.toBeInstanceOf(
    RangeError,
  );
  const foreign = newId(route + 16);
  await expect(outer(async (tx) => result(await readAuthoredFieldHistorySource(tx, foreign)))).rejects.toBeInstanceOf(
    RangeError,
  );
});

test('multiple nested appends leave the single declaration to their real outer command', async () => {
  const made = await outer(
    async (tx) => {
      const first = await append(tx, 3);
      const second = await append(tx, 9);
      expect(Object.keys(first).sort()).toEqual(['digest', 'id']);
      expect(Object.keys(second).sort()).toEqual(['digest', 'id']);
      expect(commandRecordSources(tx)).toEqual([]);
      const sources = await Promise.all(
        [first, second].map((document) => readAuthoredFieldHistorySource(tx, document.id)),
      );
      const a = sources[0],
        b = sources[1];
      if (!a || !b) throw new Error('Missing original metadata');
      expect(a.revision).toBe(3);
      expect(b.revision).toBe(9);
      declareCommandRecordSources(tx, [a, b]);
      await declareCommandHistory(tx, outerKind, {
        response: { artifactType: 'command-receipt/v1', accounts: [] },
        events: [{ artifactType: 'outbox-event/v1', accounts: [] }],
      });
      return result({ first, second, sources: [a, b] });
    },
    subject,
    true,
  );
  for (const source of made.value.sources) {
    const enrolled = await copies(source);
    expect(enrolled).toHaveLength(2);
    expect(enrolled.every((row) => row.original_transaction === made.transactionId)).toBe(true);
  }
});

test('missing native history enrollment and repeated or late outer source declarations fail closed', async () => {
  const { source } = await field();
  await expect(
    outer(async (tx) => {
      declareCommandRecordSources(tx, [source]);
      return result(null);
    }),
  ).rejects.toThrow('Record sources require native command history serialization');
  await expect(
    outer(async (tx) => {
      declareCommandRecordSources(tx, [source]);
      declareCommandRecordSources(tx, [source]);
      return result(null);
    }),
  ).rejects.toThrow('Invalid or repeated command record source declaration');
  await expect(
    outer(async (tx) => {
      beginRecordHistorySerialization(tx);
      declareCommandRecordSources(tx, [source]);
      return result(null);
    }),
  ).rejects.toThrow('Invalid or repeated command record source declaration');
  expect(await copies(source)).toEqual([]);
});

test('source metadata cannot bypass current erase permission, exact authorship or missing native rows', async () => {
  const { stored, source } = await field();
  await expect(eraseAuthoredField({ pool: db.pool, access }, other, stored.id, context())).rejects.toBeInstanceOf(
    ContentNotFoundError,
  );
  await grant(stored.id, other.accountId, 'document:erase');
  await expect(eraseAuthoredField({ pool: db.pool, access }, other, stored.id, context())).rejects.toBeInstanceOf(
    ContentNotFoundError,
  );
  const missing = newId(route);
  await grant(missing, author.accountId, 'document:erase');
  await expect(eraseAuthoredField({ pool: db.pool, access }, author, missing, context())).rejects.toBeInstanceOf(
    ContentNotFoundError,
  );
  expect(await copies(source)).toEqual([]);
  expect(await readAuthoredField(db.pool, route, stored.id)).toMatchObject({
    availability: 'available',
    body: expect.any(Buffer),
  });
});
