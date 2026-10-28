import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { appendAuthoredField, readAuthoredField, type AuthoredFieldInput } from '../../src/content/authored-fields.ts';
import {
  ANONYMOUS_PRINCIPAL_ID,
  authoritativeTimeValue,
  currentCommand,
  type CommandAuthorization,
  runCommand,
  type CommandEvent,
  type CommandTransaction,
} from '../../src/command/command.ts';
import {
  createResourceCreationManifest,
  initializeResourceGrants,
  parentCreationAuthorization,
  type ResourceCreationEntry,
} from '../../src/access/index.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';

setDefaultTimeout(120_000);

const route = 0xc120;
const subject = newId(route);
const actorId = newId(0xc230);
const action = 'subject:update';
const authoredType = 'com.rezics.content.authored-field.created.v1';
let actor: AccountActor = {
  kind: 'account',
  accountId: actorId,
  clientId: 'web',
  scopes: [action],
  authnEpoch: 1,
  requestedBy: null,
};
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let access: ReturnType<typeof admittedAccess>;
class Denied extends Error {}
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

function input(): AuthoredFieldInput {
  return {
    subject,
    candidate: newId(route),
    revision: 1,
    document: fromPlainText('A carefully written recipe.\n漢字 😀'),
    licence: 'CC-BY-4.0',
    language: 'en',
  };
}

async function command<T>(
  work: (tx: CommandTransaction) => Promise<T>,
  target = subject,
  events?: (value: T) => CommandEvent[],
) {
  const resource = { route: routeOf(target)!, id: target };
  const authorization = await accessCommandAuthorization(
    access,
    actor,
    action,
    resource,
    { pool: db.pool, deadline: Date.now() + 5000 },
    () => new Denied(),
  );
  return runCommand(
    db.pool,
    {
      partition: partitionOf(resource.route),
      deadline: Date.now() + 120_000,
      authorization,
      basis: { actorAccountId: actorId, clientId: actor.clientId, requestedBy: null },
    },
    async (tx) => {
      const value = await work(tx);
      return {
        value,
        events: events?.(value) ?? [{ type: 'com.rezics.test.imported.v1', data: {} }],
      };
    },
  );
}

async function rejectSql(sql: string, values: unknown[]) {
  const tx = await db.admin.connect();
  try {
    await tx.query('BEGIN');
    await expect(tx.query(sql, values)).rejects.toMatchObject({ code: '23514' });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(actorId), actorId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [route, subject, actorId, action],
  );
  access = admittedAccess({ actions: new Map([[action, { anonymous: false }]]) });
  actor = await authenticateAccount(access, { pool: db.pool, deadline: Date.now() + 10_000 }, actor);
});

afterAll(async () => {
  await db?.close();
});

test('an authored document is appended inside the authorized subject command and emits one created event', async () => {
  const value = input();
  const result = await command(
    (tx) => appendAuthoredField(tx, value),
    subject,
    (stored) => [
      {
        type: authoredType,
        subject,
        data: { id: stored.id, subject, candidate: value.candidate, authorId: actorId },
      },
    ],
  );
  expect(Object.keys(result.value).sort()).toEqual(['digest', 'id']);
  expect(routeOf(result.value.id)).toBe(route);
  const bytes = Buffer.from(serializeDocument(value.document as ReturnType<typeof fromPlainText>));
  expect(result.value.digest).toBe(hash(bytes));
  expect(await readAuthoredField(db.pool, route, result.value.id)).toMatchObject({
    ...result.value,
    subject,
    candidate: value.candidate,
    revision: value.revision,
    authorAccountId: actorId,
    licence: value.licence,
    language: value.language,
    availability: 'available',
    body: bytes,
  });
  const native = await db.admin.query(
    "SELECT encode(sha256(body),'hex') AS digest FROM content.authored_field WHERE route=$1 AND id=$2",
    [route, result.value.id],
  );
  expect(native.rows[0].digest).toBe(result.value.digest);
  const outbox = await db.admin.query(
    'SELECT event_seq,event_count,type,data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
    [partitionOf(route), result.position.toString()],
  );
  expect(outbox.rows).toEqual([
    {
      event_seq: 0,
      event_count: 1,
      type: authoredType,
      data: { id: result.value.id, subject, candidate: value.candidate, authorId: actorId },
    },
  ]);
  expect(await readAuthoredField(db.pool, route, newId(route))).toBeNull();
  await expect(readAuthoredField(db.pool, route + 1, result.value.id)).rejects.toThrow();
});

test('append requires the subject partition and current execute authorization', async () => {
  const value = input();
  await expect(
    runCommand(db.pool, { partition: partitionOf(route + 16), deadline: Date.now() + 10_000 }, async (tx) => {
      await expect(appendAuthoredField(tx, value)).rejects.toThrow();
      return { value: null, events: [{ type: 'com.rezics.test.imported.v1', data: {} }] };
    }),
  ).resolves.toMatchObject({ value: null });
  await expect(
    runCommand(db.pool, { partition: partitionOf(route), deadline: Date.now() + 10_000 }, async (tx) => {
      await expect(appendAuthoredField(tx, value)).rejects.toThrow(/authorization/i);
      return { value: null, events: [{ type: 'com.rezics.test.imported.v1', data: {} }] };
    }),
  ).resolves.toMatchObject({ value: null });
  await command(async (tx) => {
    await expect(appendAuthoredField(tx, { ...value, candidate: newId(route + 1) })).rejects.toThrow(/route/i);
    await expect(appendAuthoredField(tx, { ...value, candidate: newId(route + 16) })).rejects.toThrow(/route/i);
    return null;
  });
});

test('append refuses a non-account acting principal even when the subject command is authorized', async () => {
  const principal = {
    kind: 'anonymous' as const,
    id: ANONYMOUS_PRINCIPAL_ID as '00000000-0000-0000-0000-000000000000',
  };
  const value = input();
  await runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      principal,
      basis: { clientId: null, requestedBy: null },
      receipt: { kind: 'test.authored-field', key: crypto.randomUUID(), digest: Buffer.alloc(32) },
      authorization: {
        action,
        resource: { route, id: subject },
        authorize: async () => 'execute' as const,
        denied: () => new Denied(),
      },
      deadline: Date.now() + 10_000,
    },
    async (tx) => {
      await expect(appendAuthoredField(tx, value)).rejects.toThrow(/account/i);
      return { value: null, events: [{ type: 'com.rezics.test.imported.v1', data: {} }] };
    },
  );
});

test('append requires a live command and rejects invalid documents, licences, languages and media nodes', async () => {
  const value = input();
  await expect(appendAuthoredField({} as CommandTransaction, value)).rejects.toBeInstanceOf(TypeError);
  const mediaDocument = (type: 'image' | 'media') => ({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type,
          attrs: { id: 'hotlink', src: 'https://example.com/asset', ...(type === 'media' ? { kind: 'video' } : {}) },
        },
      ],
    },
  });
  const invalid: AuthoredFieldInput[] = [
    { ...value, licence: 'not-an-SPDX-identifier' },
    { ...value, licence: '' },
    { ...value, language: '' },
    { ...value, language: 'not_a_bcp47_tag' },
    { ...value, document: { version: 1 } },
    { ...value, document: fromPlainText('x'.repeat(2 * 1024 * 1024)) },
    { ...value, document: mediaDocument('image') },
    { ...value, document: mediaDocument('media') },
  ];
  await command(async (tx) => {
    for (const bad of invalid) await expect(appendAuthoredField(tx, bad)).rejects.toThrow();
    return null;
  });
});

test('stored authored rows are immutable except erasure to a bodyless tombstone', async () => {
  const value = input();
  const result = (await command((tx) => appendAuthoredField(tx, value))).value;
  const clone = `INSERT INTO content.authored_field(route,id,subject,candidate,revision,author_account_id,body,body_sha256,licence,language,availability)
    SELECT route,$3,subject,candidate,revision,author_account_id,$4,$5,licence,language,'available'
    FROM content.authored_field WHERE route=$1 AND id=$2`;
  const canonical = Buffer.from(serializeDocument(value.document as ReturnType<typeof fromPlainText>));
  const original = Buffer.from(result.digest, 'hex');
  await rejectSql(clone, [route, result.id, newId(route), Buffer.from(` ${canonical.toString()}`), original]);
  await rejectSql(clone, [route, result.id, newId(route), canonical, Buffer.alloc(32)]);
  await rejectSql(clone, [route, result.id, newId(route + 1), canonical, original]);
  await rejectSql(clone, [
    route,
    result.id,
    newId(route),
    Buffer.alloc(2097153),
    Buffer.from(hash(Buffer.alloc(2097153)), 'hex'),
  ]);
  for (const change of [
    'candidate = id',
    'revision = revision + 1',
    'author_account_id = subject',
    "licence = 'MIT'",
    "language = 'fr'",
    "body_sha256 = sha256('forged'::bytea)",
  ])
    await rejectSql(`UPDATE content.authored_field SET ${change} WHERE route=$1 AND id=$2`, [route, result.id]);
  await rejectSql('DELETE FROM content.authored_field WHERE route=$1 AND id=$2', [route, result.id]);
  await db.admin.query("UPDATE content.authored_field SET body=NULL,availability='erased' WHERE route=$1 AND id=$2", [
    route,
    result.id,
  ]);
  expect(await readAuthoredField(db.pool, route, result.id)).toMatchObject({
    ...result,
    body: null,
    availability: 'erased',
    authorAccountId: actorId,
  });
  await rejectSql("UPDATE content.authored_field SET body=$3,availability='available' WHERE route=$1 AND id=$2", [
    route,
    result.id,
    canonical,
  ]);
});

test('authored document append and read', async () => {
  const value = input();
  const report = (
    await command(async (tx) =>
      checkGrowth(db, {
        name: 'authored document append and read',
        scales: [64, 512, 4096],
        warmups: 1,
        repetitions: 1,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(target, scale, previous) {
          const bytes = Buffer.from(serializeDocument(value.document as ReturnType<typeof fromPlainText>));
          await seed(
            target,
            {
              name: 'unrelated authored fields',
              hotPartition: partitionOf(route),
              hotShare: 1,
              rows: ({ route: other }) => ({
                'content.authored_field': [
                  {
                    route: other,
                    id: newId(other),
                    subject: newId(other),
                    candidate: newId(other),
                    revision: 1,
                    author_account_id: actorId,
                    body: bytes,
                    body_sha256: Buffer.from(hash(bytes), 'hex'),
                    licence: value.licence,
                    language: value.language,
                    availability: 'available',
                  },
                ],
              }),
            },
            { from: previous, to: scale },
          );
        },
        async operation() {
          const proposal = { ...value, candidate: newId(route) };
          const result = await appendAuthoredField(tx, proposal);
          expect((await readAuthoredField(tx, route, result.id))?.digest).toBe(result.digest);
        },
      }),
    )
  ).value;
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
  }
});

let creationAccess: ReturnType<typeof admittedAccess>;
let creationActor: AccountActor;
const global = { route: 0, id: GLOBAL_CONTEXT };
const propose = 'statement:propose';
beforeAll(async () => {
  await db.admin.query(`CREATE TABLE public.authored_anchor_fixture (
    route integer NOT NULL, id uuid NOT NULL, command_id uuid NOT NULL, created_at timestamptz NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(route,id));
    CREATE FUNCTION public.freeze_authored_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'immutable creation provenance'; END $$;
    CREATE TRIGGER immutable_provenance BEFORE UPDATE ON public.authored_anchor_fixture
    FOR EACH ROW EXECUTE FUNCTION public.freeze_authored_anchor()`);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,$3,'(,)',$2)`,
    [GLOBAL_CONTEXT, actorId, propose],
  );
  creationAccess = admittedAccess({
    actions: new Map([
      [propose, { anonymous: false, 'x-resource-types': ['semantic.communal'] }],
      ['document:erase', { anonymous: false }],
    ]),
    resourceRoles: { roles: {}, types: { 'semantic.communal': { standing: [] } } },
  });
  creationActor = await authenticateAccount(
    creationAccess,
    { pool: db.pool, deadline: Date.now() + 10_000 },
    { ...actor, scopes: [propose, 'document:erase'] },
  );
});

async function creationCommand<T>(anchor: string, work: (tx: CommandTransaction) => Promise<T>, receiptOnly = false) {
  const resource = { route: routeOf(anchor)!, id: anchor };
  const provenance = new WeakMap<CommandTransaction, string>();
  const entry: ResourceCreationEntry = {
    resource,
    type: 'semantic.communal',
    creator: actorId,
    creation: {
      async validate(tx, target, time) {
        expect(time).toBe(currentCommand(tx).time);
        return (
          (
            await tx.query(
              `SELECT 1 FROM public.authored_anchor_fixture
          WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()
          AND command_id=$3 AND created_at=$4::timestamptz`,
              [target.route, target.id, provenance.get(tx), authoritativeTimeValue(time)],
            )
          ).rowCount === 1
        );
      },
    },
  };
  const authorization = parentCreationAuthorization({
    access: creationAccess,
    actor: creationActor,
    action: propose,
    parent: globalContextAnchor,
    context: {
      pool: db.pool,
      deadline: Date.now() + 10_000,
      resource,
      creation: entry.creation,
      manifest: createResourceCreationManifest([entry]),
    },
  });
  const binding: CommandAuthorization = receiptOnly
    ? {
        ...authorization,
        async authorize(tx, attempt, evidence) {
          await authorization.authorize(tx, attempt, evidence);
          return 'receipt-only';
        },
      }
    : authorization;
  return runCommand(
    db.pool,
    {
      partition: partitionOf(route),
      deadline: Date.now() + 10_000,
      authorization: binding,
      basis: { actorAccountId: actorId, clientId: creationActor.clientId, requestedBy: null },
    },
    async (tx, command) => {
      expect(currentCommand(tx).authorization).toMatchObject({ action: propose, resource: global, mode: 'execute' });
      provenance.set(tx, command.transactionId);
      await tx.query(
        `INSERT INTO public.authored_anchor_fixture(route,id,command_id,created_at) VALUES ($1,$2,$3,$4)`,
        [resource.route, anchor, command.transactionId, authoritativeTimeValue(command.time)],
      );
      await initializeResourceGrants(tx, { resource, type: entry.type, creator: actorId });
      const value = await work(tx);
      expect(currentCommand(tx).authorization?.resource).toEqual(global);
      return { value, events: [{ type: 'com.rezics.test.imported.v1', data: {} }] };
    },
  );
}

test("an authored field is admitted under a Global Context authorization when the command's live creation declares its anchor, and stores the anchor", async () => {
  const anchor = newId(route);
  const value = { ...input(), anchor };
  const stored = (await creationCommand(anchor, (tx) => appendAuthoredField(tx, value))).value;
  expect(await readAuthoredField(db.pool, route, stored.id)).toMatchObject({
    ...stored,
    anchor,
    availability: 'available',
  });
  await rejectSql(
    `UPDATE content.authored_field SET anchor=$3,body=NULL,availability='erased' WHERE route=$1 AND id=$2`,
    [route, stored.id, newId(route)],
  );
  await rejectSql(
    `INSERT INTO content.authored_field
    SELECT (jsonb_populate_record(NULL::content.authored_field, to_jsonb(f) || jsonb_build_object('id',$3::uuid,'anchor',$4::uuid))).*
    FROM content.authored_field f WHERE route=$1 AND id=$2`,
    [route, stored.id, newId(route), newId(route + 1)],
  );
  const { eraseAuthoredField } = await import('../../src/content/authored-fields.ts');
  await eraseAuthoredField({ pool: db.pool, access: creationAccess }, creationActor, stored.id, {
    deadline: Date.now() + 10_000,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(await readAuthoredField(db.pool, route, stored.id)).toMatchObject({
    anchor,
    availability: 'erased',
    body: null,
  });
});

test('an authored field anchor that the command does not declare, or that is off the subject route, is refused and writes nothing', async () => {
  const before = (await db.admin.query('SELECT count(*) FROM content.authored_field')).rows;
  async function refused(tx: CommandTransaction, anchor: string) {
    const queries = spyOn(tx, 'query');
    try {
      await expect(appendAuthoredField(tx, { ...input(), anchor })).rejects.toBeInstanceOf(TypeError);
      expect(queries).not.toHaveBeenCalled();
    } finally {
      queries.mockRestore();
    }
  }
  // Subject authorization alone cannot admit an explicitly supplied anchor.
  await command((tx) => refused(tx, newId(route)));
  const declared = newId(route);
  await creationCommand(declared, (tx) => refused(tx, newId(route)));
  const offRoute = newId(route + 1);
  await creationCommand(offRoute, (tx) => refused(tx, offRoute));
  let executed = false;
  await expect(
    creationCommand(
      newId(route),
      async () => {
        executed = true;
      },
      true,
    ),
  ).rejects.toThrow();
  expect(executed).toBe(false);
  expect((await db.admin.query('SELECT count(*) FROM content.authored_field')).rows).toEqual(before);
});
