import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { accessCommandAuthorization, type AccountActor, type Actor } from '../../src/request/access.ts';
import { runCommand, principalCommandIdentity } from '../../src/command/command.ts';
import { appendAuthoredField, eraseAuthoredField, readAuthoredField } from '../../src/content/authored-fields.ts';
import { ContentNotFoundError } from '../../src/content/commands.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { writeProposal } from '../../src/semantic/candidates.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

setDefaultTimeout(120_000);

const subjectRoute = 0xc120;
const authorId = newId(0xc230);
const otherId = newId(0xc231);
const actorIds = [authorId, otherId] as const;
const actionNames = ['subject:create', 'subject:update', 'document:erase'] as const;
const authoredCreated = 'com.rezics.content.authored-field.created.v1';
const authoredErased = 'com.rezics.content.authored-field.erased.v1';
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let access: ReturnType<typeof admittedAccess>;
let author!: AccountActor;
let other!: AccountActor;

function request(idempotencyKey = randomUUID()) {
  return { idempotencyKey, requestId: randomUUID(), deadline: Date.now() + 120_000 };
}

async function insertAccount(id: string): Promise<AccountActor> {
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(id), id],
  );
  return authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 10_000 },
    {
      accountId: id,
      clientId: 'web',
      scopes: actionNames,
      authnEpoch: 1,
      requestedBy: null,
    },
  );
}

async function grant(resourceId: string, action: string, accountId = authorId): Promise<void> {
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$5)`,
    [routeOf(resourceId), resourceId, accountId, action, randomUUID()],
  );
}

async function appendThroughSemanticSubjectCommand(): Promise<{ id: string; subject: string; authorId: string }> {
  const subject = newId(subjectRoute);
  await grant(subject, 'subject:create');
  const createAuthorization = await accessCommandAuthorization(
    access,
    author,
    'subject:create',
    { route: subjectRoute, id: subject },
    { pool: db.pool, deadline: Date.now() + 10_000 },
    () => new ContentNotFoundError(),
  );
  await createSubject(db.pool, {
    actor: author,
    target: { route: subjectRoute, id: subject },
    idempotencyKey: randomUUID(),
    digest: createHash('sha256').update(subject).digest(),
    item: { type: 'schema:Recipe', labels: { en: 'Private recipe' } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: createAuthorization,
    deadline: Date.now() + 120_000,
  });
  await grant(subject, 'subject:update');

  const context = request();
  const resource = { route: subjectRoute, id: subject };
  const authorization = await accessCommandAuthorization(
    access,
    author,
    'subject:update',
    resource,
    { pool: db.pool, deadline: context.deadline },
    () => new ContentNotFoundError(),
  );
  const identity = principalCommandIdentity(author);
  let appended: { id: string; digest: string } | undefined;
  await runCommand(
    db.pool,
    {
      ...identity,
      partition: partitionOf(subjectRoute),
      deadline: context.deadline,
      authorization,
      receipt: {
        kind: 'subject.propose',
        key: context.idempotencyKey,
        digest: createHash('sha256').update(`${subject}\nrecipe`).digest(),
      },
    },
    async (tx, { transactionId }) => {
      const proposal = await writeProposal(tx, transactionId, {
        subject,
        statement: {
          property: { id: 'schema:abstract' },
          value: { type: 'value', content: { language: 'en', document: fromPlainText('Private recipe text') } },
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/recipe' } },
              ],
            },
          ],
        },
        release: { digest: bundledDigest, release: bundledRelease },
        allowContent: true,
        install: async ({ candidate, revision }) => {
          appended = await appendAuthoredField(tx, {
            subject,
            candidate,
            revision,
            document: fromPlainText('Private recipe text'),
            licence: 'CC-BY-4.0',
            language: 'en',
          });
          return { language: 'en', document: appended.id, digest: appended.digest };
        },
      });
      if (!appended) throw new Error('The semantic proposal did not append its authored document');
      return {
        value: proposal.value,
        events: [
          ...proposal.events,
          {
            type: authoredCreated,
            subject,
            data: { id: appended.id, subject, candidate: proposal.value.candidate, authorId: author.accountId },
          },
        ],
      };
    },
  );
  if (!appended) throw new Error('No authored field was appended');
  return { id: appended.id, subject, authorId: author.accountId };
}

async function erase(id: string, actor: Actor, key = randomUUID()) {
  return eraseAuthoredField({ pool: db.pool, access }, actor, id, request(key));
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await bootstrapRelease(db.pool, bundledRelease);
  access = admittedAccess({ actions: new Map(actionNames.map((action) => [action, { anonymous: false }])) });
  const accounts = await Promise.all(actorIds.map(insertAccount));
  author = accounts[0]!;
  other = accounts[1]!;
});

afterAll(async () => {
  await db?.close();
});

test('the authored field author erases it once and a repeat is idempotent', async () => {
  const field = await appendThroughSemanticSubjectCommand();
  const before = await readAuthoredField(db.pool, subjectRoute, field.id);
  expect(before).toMatchObject({ availability: 'available', body: expect.any(Buffer), authorAccountId: authorId });

  const key = randomUUID();
  const first = await erase(field.id, author, key);
  expect(first).toMatchObject({ replayed: false, value: { id: field.id, subject: field.subject, authorId } });
  expect(await readAuthoredField(db.pool, subjectRoute, field.id)).toMatchObject({
    id: field.id,
    subject: field.subject,
    authorAccountId: authorId,
    availability: 'erased',
    body: null,
    digest: before!.digest,
  });

  const replay = await erase(field.id, author, key);
  expect(replay).toMatchObject({ replayed: true, value: first!.value });
  expect(await erase(field.id, author)).toBeNull();
  const events = await db.admin.query(
    `SELECT subject,data FROM core.outbox
     WHERE partition_no=$1 AND type=$2 AND data->>'id'=$3`,
    [partitionOf(subjectRoute), authoredErased, field.id],
  );
  expect(events.rows).toEqual([{ subject: field.subject, data: { id: field.id, subject: field.subject, authorId } }]);
});

test('another account, an anonymous caller and a suspended author cannot change the row', async () => {
  const field = await appendThroughSemanticSubjectCommand();
  const before = await db.admin.query(
    "SELECT availability,body,encode(body_sha256,'hex') AS digest FROM content.authored_field WHERE route=$1 AND id=$2",
    [subjectRoute, field.id],
  );

  await expect(erase(field.id, other)).rejects.toBeInstanceOf(ContentNotFoundError);
  await expect(erase(field.id, { kind: 'anonymous' })).rejects.toBeInstanceOf(ContentNotFoundError);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(authorId),
    authorId,
  ]);
  try {
    await expect(erase(field.id, author)).rejects.toBeInstanceOf(ContentNotFoundError);
  } finally {
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(authorId),
      authorId,
    ]);
  }
  const after = await db.admin.query(
    "SELECT availability,body,encode(body_sha256,'hex') AS digest FROM content.authored_field WHERE route=$1 AND id=$2",
    [subjectRoute, field.id],
  );
  expect(after.rows).toEqual(before.rows);
});

test('authored document erasure', async () => {
  const growthIds: { route: number; id: string }[] = [];
  const document = Buffer.from('growth probe');
  const digest = createHash('sha256').update(document).digest();
  const baseline = 4096;
  const population: Population = {
    name: 'authored documents in one partition',
    hotPartition: partitionOf(subjectRoute),
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const id = newId(route);
      if (ordinal >= baseline) growthIds.push({ route, id });
      return {
        'content.authored_field': [
          {
            route,
            id,
            subject: newId(route),
            candidate: newId(route),
            revision: 1,
            author_account_id: authorId,
            body: document,
            body_sha256: digest,
            licence: 'CC-BY-4.0',
            language: 'en',
            availability: 'available',
          },
        ],
        'access.resource_initialization': [
          {
            route,
            resource_id: id,
            resource_type: 'content.authored_field',
            creator_id: authorId,
            initialized_at: new Date(),
          },
        ],
        'access.resource_role_grant': [
          {
            route,
            resource_id: id,
            subject_kind: 'identity',
            subject_id: authorId,
            subject_role: '',
            grant_role: 'content.authored_field.owner',
            valid: '(,)',
            transaction_id: randomUUID(),
          },
        ],
      };
    },
  };
  // Fresh tombstones at every run; committed document and owner-role histories already use indexed plans.
  await seed(db, population, { from: 0, to: baseline });
  const report = await checkGrowth(db, {
    name: 'authored document erasure',
    rule: 'series',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(target, scale, previous) {
      await seed(target, population, { from: baseline + previous, to: baseline + scale });
    },
    async warmup(_target, scale) {
      const probe = growthIds[scale - 1]!;
      await erase(probe.id, author);
    },
    async operation(_target, scale) {
      const probe = growthIds[scale - 2]!;
      await erase(probe.id, author);
    },
  });
  expect(growthIds).toHaveLength(4096);
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  expect(report.rule).toBe('series');
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    for (const cost of sample.repetitions)
      for (const relation of ['content.authored_field', 'access.resource_role_grant'])
        expect(cost.relations[relation]?.sequentialScans).toBe(0);
  }
});
