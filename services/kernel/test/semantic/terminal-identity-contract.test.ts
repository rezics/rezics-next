import '../support/fixture-event-types.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { runCommand, authoritativeTimeValue, type AuthoritativeTime } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  terminalReader,
  readOptions,
  deadline,
  resource,
  homeOf,
  type IdentityFixture,
} from './identity-fixture.ts';

let db: GrowthDatabase;
let f: IdentityFixture;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(url);
}, 30_000);
beforeEach(async () => {
  f = await identityFixture(db.pool, db.admin);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});

function lightweight(statements: readonly string[]) {
  const sql = statements.join('\n');
  expect(sql).not.toMatch(
    /semantic\.(?:fact|revision|outbound_link|inbound_link|adoption|candidate|definition_release|partition_subjects)\b/i,
  );
  expect(sql).not.toMatch(/(?:checkpoint|waitFor|summary|read-subject\.sql)/i);
  expect(sql).not.toMatch(/WITH\s+RECURSIVE|enable_seqscan/i);
}

// Frozen reference and metadata helpers are deliberately neither imported nor implemented here.
test('terminal identity is a lightweight current authorized read with explicit maintenance readiness', async () => {
  const source = await f.create(0x6e10);
  const root = await f.create(0x6e00);
  await f.baseline(source);
  const read = await terminalReader();
  const live = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(live.value).toMatchObject({ state: 'ready', id: source });
  lightweight(live.capture.statements);
  expect(Object.keys(live.value ?? {}).sort()).toEqual(['components', 'id', 'state']);

  await f.merge(source, root);
  // Redirect insertion predates alias registration: neither a fresh checkpoint nor an idle worker proves readiness.
  const pending = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(pending.value).toEqual({ state: 'not_ready' });
  lightweight(pending.capture.statements);
  await f.finishMove(source, root);
  const redirected = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(redirected.value).toMatchObject({ state: 'ready', id: root });
  lightweight(redirected.capture.statements);

  await f.hide(root);
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  await f.hide(root, 'restore');
  await f.hide(source);
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  expect(await read(db.pool, newId(0x6e10), readOptions(f))).toBeNull();
  expect(await read(db.pool, 'bad-id', readOptions(f))).toBeNull();
  // Even an explicit native grant cannot disclose a hidden original.
  await f.real.grant(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  await f.hide(source, 'restore');
  expect(await read(db.pool, source, readOptions(f))).toMatchObject({ state: 'ready', id: root });
});

test('terminal anchors use released same-client RR Access and native preparation time', async () => {
  const source = await f.create(0x6e30);
  const root = await f.create(0x6e00);
  await f.merge(source, root);
  await f.finishMove(source, root);
  await f.baseline(source);
  const read = await terminalReader();
  const checks: { id: string; client: unknown; time: AuthoritativeTime | undefined }[] = [];
  const access = deriveAccess(f.access, {
    async authorize(client, actor, action, anchor, evidence, time) {
      if (action === 'subject:read') {
        const isolation = await client.query('SHOW transaction_isolation');
        expect(isolation.rows[0].transaction_isolation).toBe('repeatable read');
        const mode = await client.query('SHOW transaction_read_only');
        expect(mode.rows[0].transaction_read_only).toBe('on');
        checks.push({ id: anchor.id, client, time });
      }
      return f.access.authorize(client, actor, action, anchor, evidence, time);
    },
    async prepare(actor, action, anchor, context) {
      // A pool of size one can prepare the next anchor only after releasing the previous RR checkout.
      const value = await f.access.prepare!(actor, action, anchor, context);
      return value;
    },
  });
  const single = db.openPool({ max: 1 });
  try {
    const singleReader = await access.authenticate(f.real.bearer('reader'), { pool: single, deadline: deadline() });
    const authorization = await f.authorization('subject:merge');
    let nativeT: AuthoritativeTime | undefined;
    await runCommand(
      db.pool,
      {
        partition: homeOf(source),
        deadline: deadline(),
        basis: { actorAccountId: f.editor.accountId, clientId: f.editor.clientId, requestedBy: f.editor.requestedBy },
        authorization: {
          ...authorization,
          async prepare(attempt) {
            nativeT = attempt.time;
            expect(Number.isFinite(Date.parse(authoritativeTimeValue(attempt.time)))).toBe(true);
            const observed = await capture(db, () =>
              read(single, source, {
                ...readOptions(f),
                access,
                actor: singleReader,
                nativeT: attempt.time,
              }),
            );
            expect(observed.value).toMatchObject({ state: 'ready', id: root });
            lightweight(observed.capture.statements);
            return authorization.prepare!(attempt);
          },
        },
      },
      async () => ({ value: null, events: [{ type: 'com.rezics.access.time-probe.v1', data: {} }] }),
    );
    expect(checks.map((check) => check.id)).toEqual([source, root]);
    expect(checks.every((check) => check.time === nativeT)).toBe(true);
  } finally {
    await single.end();
  }

  // An installed native authenticated-only catalogue proves original and terminal grants independently.
  const privateAccess = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  const privateReader = await privateAccess.authenticate(f.real.bearer('reader'), {
    pool: db.pool,
    deadline: deadline(),
  });
  const options = { ...readOptions(f), access: privateAccess, actor: privateReader };
  await f.real.grant(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toBeNull();
  await f.real.grant(resource(root), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toMatchObject({ state: 'ready', id: root });
  await f.real.revoke(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toBeNull();
  await expect(read(db.pool, root, { ...readOptions(f), deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
});
