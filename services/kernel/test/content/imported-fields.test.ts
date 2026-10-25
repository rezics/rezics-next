import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { appendImportedField, readImportedField } from '../../src/content/imported-fields.ts';
import type { ImportedFieldInput } from '../../src/content/imported-contract.ts';
import { runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { accessCommandAuthorization, type AccountActor } from '../../src/request/access.ts';
import { createAccess } from '../../src/access/permission.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed } from '../support/growth.ts';

setDefaultTimeout(120_000);

const route = 0xc120;
const subject = newId(route);
const actorId = newId(0xc230);
const action = 'subject:update';
const actor: AccountActor = {
  kind: 'account',
  accountId: actorId,
  clientId: 'web',
  scopes: [action],
  authnEpoch: 1,
  requestedBy: null,
};
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let access: ReturnType<typeof createAccess>;
class Denied extends Error {}
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
function input(): ImportedFieldInput {
  return {
    subject,
    source: {
      source: 'bangumi',
      external_id: '42',
      record_revision: 'unversioned',
      digest: 'sha256:source-digest',
      converter_revision: 'converter-v1',
      field_group: 'summary',
      references: [{ url: 'https://bgm.tv/subject/42', title: 'Source summary' }],
    },
    rights: {
      license: 'CC-BY-SA-3.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Bangumi contributors',
    },
    language: 'zh-Hant',
    document: fromPlainText('漢字 😀\n full summary '),
  };
}
async function command<T>(work: (tx: CommandTransaction) => Promise<T>, target = subject) {
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
      authorization,
      basis: { actorAccountId: actorId, clientId: actor.clientId, requestedBy: null },
    },
    async (tx) => ({ value: await work(tx), events: [{ type: 'com.rezics.test.imported.v1', data: {} }] }),
  );
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  // Native currentCommand and the production Access formula own authorization.
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
  const account = await readAccount(db.admin, routeOf(actorId)!, actorId);
  access = createAccess({ actions: new Map([[action, { anonymous: false }]]), accountEvidence: () => account });
});
afterAll(async () => {
  await db?.close();
});

test('append uses the real authorized command and exact canonical document bytes with immutable per-field evidence', async () => {
  const value = input();
  const result = await command((tx) => appendImportedField(tx, value));
  expect(Object.keys(result.value).sort()).toEqual(['digest', 'id']);
  expect(routeOf(result.value.id)).toBe(route);
  const bytes = Buffer.from(serializeDocument(value.document as ReturnType<typeof fromPlainText>));
  expect(result.value.digest).toBe(hash(bytes));
  const stored = await readImportedField(db.pool, route, result.value.id);
  expect(stored).toMatchObject({
    ...result.value,
    subject,
    source: value.source,
    rights: value.rights,
    language: value.language,
    availability: 'available',
    body: bytes,
  });
  const native = await db.admin.query(
    "SELECT encode(sha256(body),'hex') AS digest FROM content.imported_field WHERE route=$1 AND id=$2",
    [route, result.value.id],
  );
  expect(native.rows[0].digest).toBe(result.value.digest);
  expect(await readImportedField(db.pool, route, newId(route))).toBeNull();
  await expect(readImportedField(db.pool, route + 1, result.value.id)).rejects.toThrow();
});

test('denied authorization and a rolled-back semantic command leave zero imported documents', async () => {
  const before = await db.admin.query('SELECT count(*) FROM content.imported_field WHERE route=$1', [route]);
  await expect(
    command(async (tx) => {
      await appendImportedField(tx, input());
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
    route,
    subject,
    actorId,
  ]);
  try {
    await expect(command((tx) => appendImportedField(tx, input()))).rejects.toBeInstanceOf(Denied);
  } finally {
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'(,)',$3)`,
      [route, subject, actorId, action],
    );
  }
  expect((await db.admin.query('SELECT count(*) FROM content.imported_field WHERE route=$1', [route])).rows).toEqual(
    before.rows,
  );
});

test('requires a live transaction, a matching authorized subject and the subject command partition', async () => {
  let touched = false;
  const fake = new Proxy(
    {},
    {
      get() {
        touched = true;
        throw new Error('I/O');
      },
    },
  ) as CommandTransaction;
  await expect(appendImportedField(fake, input())).rejects.toBeInstanceOf(TypeError);
  expect(touched).toBe(false);
  let retained: CommandTransaction | undefined;
  await command(async (tx) => {
    retained = tx;
    await expect(appendImportedField(tx, { ...input(), subject: newId(route + 1) })).rejects.toThrow();
    await expect(appendImportedField(tx, { ...input(), subject: newId(route + 16) })).rejects.toThrow();
    return null;
  });
  await expect(appendImportedField(retained!, input())).rejects.toBeInstanceOf(TypeError);
  await expect(
    runCommand(db.pool, { partition: partitionOf(route) }, async (tx) => ({
      value: await appendImportedField(tx, input()),
      events: [],
    })),
  ).rejects.toBeInstanceOf(TypeError);
});

test('preserves SPDX, attribution and source revision histories without applying factual database rights to summaries', async () => {
  const first = input();
  const second: ImportedFieldInput = {
    ...first,
    source: { ...first.source, record_revision: 'revision-2', converter_revision: 'converter-v2' },
    rights: {
      license: 'LicenseRef-author-permission',
      obligations: ['odrl:attribute'],
      attribution: 'A separately licensed source',
    },
  };
  const a = (await command((tx) => appendImportedField(tx, first))).value;
  const b = (
    await command((tx) => appendImportedField(tx, { ...second, source: { ...second.source, source: 'example' } }))
  ).value;
  expect(a.id).not.toBe(b.id);
  expect((await readImportedField(db.pool, route, a.id))?.rights).toEqual(first.rights);
  expect((await readImportedField(db.pool, route, b.id))?.rights).toEqual(second.rights);
  await expect(
    command((tx) => appendImportedField(tx, { ...first, rights: { ...first.rights, license: 'ODbL-1.0' } })),
  ).rejects.toThrow();
});

test('rejects malformed licences, evidence, language, groups, references and body bounds', async () => {
  const value = input();
  const invalid: ImportedFieldInput[] = [
    { ...value, rights: { ...value.rights, license: 'not-an-SPDX-identifier' } },
    { ...value, rights: { ...value.rights, obligations: [] } },
    { ...value, rights: { ...value.rights, attribution: '' } },
    { ...value, language: '' },
    { ...value, document: { version: 1 } },
    { ...value, document: fromPlainText('x'.repeat(2 * 1024 * 1024)) },
    { ...value, source: { ...value.source, record_revision: '' } },
    { ...value, source: { ...value.source, field_group: 'facts' } },
    {
      ...value,
      source: { ...value.source, references: Array.from({ length: 129 }, () => value.source.references[0]!) },
    },
    { ...value, source: { ...value.source, references: [{ url: 'javascript:alert(1)' }] } },
  ];
  await command(async (tx) => {
    for (const bad of invalid) await expect(appendImportedField(tx, bad)).rejects.toThrow();
    const bounded = await appendImportedField(tx, {
      ...value,
      source: { ...value.source, references: Array.from({ length: 128 }, () => value.source.references[0]!) },
    });
    expect(routeOf(bounded.id)).toBe(route);
  });
});

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
test('native checks reject forged bytes and digests and preserve original hashes on irreversible erasure', async () => {
  const value = input();
  const result = (await command((tx) => appendImportedField(tx, value))).value;
  const clone = `INSERT INTO content.imported_field(route,id,subject,body,body_sha256,source,rights,language,availability)
    SELECT route,$3,subject,$4,$5,source,rights,language,'available' FROM content.imported_field WHERE route=$1 AND id=$2`;
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
    "rights = jsonb_set(rights,'{attribution}','\"forged\"')",
    "language = 'en'",
    "body_sha256 = sha256('forged'::bytea)",
  ])
    await rejectSql(`UPDATE content.imported_field SET ${change} WHERE route=$1 AND id=$2`, [route, result.id]);
  await rejectSql('DELETE FROM content.imported_field WHERE route=$1 AND id=$2', [route, result.id]);
  await db.admin.query("UPDATE content.imported_field SET body=NULL,availability='erased' WHERE route=$1 AND id=$2", [
    route,
    result.id,
  ]);
  expect(await readImportedField(db.pool, route, result.id)).toMatchObject({
    ...result,
    body: null,
    availability: 'erased',
    rights: value.rights,
    source: value.source,
  });
  await rejectSql("UPDATE content.imported_field SET body=$3,availability='available' WHERE route=$1 AND id=$2", [
    route,
    result.id,
    canonical,
  ]);
});

test('canonical Unicode and numeric extension payloads match the real document serializer', async () => {
  const document = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'extensionBlock',
          attrs: {
            id: 'numeric',
            definition: 'example',
            version: '1',
            fallback: '漢字 😀',
            payload: { z: 1e-7, a: -0, number: 1e21 },
          },
        },
      ],
    },
  };
  const result = (await command((tx) => appendImportedField(tx, { ...input(), document }))).value;
  const bytes = Buffer.from(serializeDocument(document as ReturnType<typeof fromPlainText>));
  expect((await readImportedField(db.pool, route, result.id))?.body).toEqual(bytes);
  expect(result.digest).toBe(hash(bytes));
});

test('intentional changed-document and input-byte growth is linear', async () => {
  await checkGrowth(db, {
    name: 'imported changed documents',
    scales: [1, 8, 64],
    repetitions: 1,
    warmups: 0,
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    async grow() {},
    async operation(_target, scale) {
      await command(async (tx) => {
        for (let change = 0; change < scale; change++) {
          const result = await appendImportedField(tx, input());
          expect((await readImportedField(tx, route, result.id))?.digest).toBe(result.digest);
        }
      });
    },
  });
});

test('checkGrowth captures actual append and exact read at fixed bytes with same-partition unrelated history', async () => {
  const value = input();
  const report = await checkGrowth(db, {
    name: 'imported field append/read',
    scales: [32, 256, 2048],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(target, scale, previous) {
      const bytes = Buffer.from(serializeDocument(value.document as ReturnType<typeof fromPlainText>));
      await seed(
        target,
        {
          name: 'unrelated imported fields',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows: ({ route: other }) => {
            const organization = newId(other);
            return {
              'content.imported_field': [
                {
                  route: other,
                  id: newId(other),
                  subject: newId(other),
                  body: bytes,
                  body_sha256: Buffer.from(hash(bytes), 'hex'),
                  source: value.source,
                  rights: value.rights,
                  language: value.language,
                  availability: 'available',
                },
              ],
              'access.account': [
                {
                  route: other,
                  account_id: organization,
                  kind: 'organization',
                  state: 'active',
                  transaction_id: organization,
                },
              ],
              // These unrelated candidate organizations have no actor memberships (K=0).
              // Preparation must use the bounded actor inverse, not enumerate resource candidates.
              'access.resource_grant': [
                {
                  route,
                  resource_id: subject,
                  subject_id: organization,
                  subject_role: 'member',
                  action,
                  valid: '(,)',
                  transaction_id: organization,
                },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async operation() {
      const result = (await command((tx) => appendImportedField(tx, value))).value;
      expect((await readImportedField(db.pool, route, result.id))?.digest).toBe(result.digest);
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.relations?.['content.imported_field']?.rows).toBe(1);
  }
});
