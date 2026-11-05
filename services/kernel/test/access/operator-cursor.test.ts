import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createOperatorCommands, OperatorDeniedError } from '../../src/access/operator.ts';
import { createAccess } from '../../src/access/permission.ts';
import { installAccessClock } from '../../src/access/access-clock.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { encodeListCursor, decodeListCursor } from '../../src/tokens/list-cursor.ts';
import { decodeCursor } from '../../src/tokens/cursor.ts';
import { openGrowthDatabase, capture, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const route = 0x6510;
const operatorAccountId = newId(route);
const accountViewer = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'operator-list-test',
  scopes: ['account:manage'],
  requestedBy: null,
  authnEpoch: 1,
};
const ring = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
const actions = new Map([['account:manage', { anonymous: false }]]);
const access = createAccess({ actions, accountEvidence: () => null });
const binding = {
  route: 'access.operator.responsibility.list',
  viewer: null,
  query: { operatorAccountId, purpose: 'operator', sort: 'reservationId:asc', limit: 20 },
};
const id = (n: number) => `00000000-0000-8000-8000-6510${n.toString(16).padStart(8, '0')}`;
let db: GrowthDatabase;
const config = () => ({ pool: db.pool, actions, access, managementAction: 'account:manage', cursorKeys: ring });
const commands = () => createOperatorCommands(config());
const expected = Array.from({ length: 45 }, (_, i) => ({ reservationId: id(i + 1), subjectAccountId: newId(route) }));
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  for (const row of expected) {
    // Pending reservations have no subject relation (or even subject account) yet.
    await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$5)`, [
      route,
      operatorAccountId,
      row.reservationId,
      row.subjectAccountId,
      newId(route),
    ]);
  }
});
afterAll(async () => db?.close());

test('operator list envelope uses operators and opaque next cursor with default and bounded limits', async () => {
  const page = await commands().responsibilityPage({ operatorAccountId });
  expect(Object.keys(page).sort()).toEqual(['next', 'operators']);
  expect(page.operators).toEqual(expected.slice(0, 20));
  expect(page.next).toBeString();
  expect(page.next).not.toBe(expected[19]!.reservationId);
  expect(await decodeListCursor(ring, binding, page.next!, new Date())).toMatchObject({
    ok: true,
    epoch: 1,
    after: [id(20)],
  });
  const second = await commands().responsibilityPage({ operatorAccountId, cursor: page.next! });
  expect(second.operators).toEqual(expected.slice(20, 40));
  expect(await commands().responsibilityPage({ operatorAccountId, cursor: second.next! })).toEqual({
    operators: expected.slice(40),
    next: null,
  });
  expect((await commands().responsibilityPage({ operatorAccountId, limit: 100 })).operators).toEqual(expected);
  for (const limit of [0, 101, 1.5, NaN, Infinity]) {
    await expect(commands().responsibilityPage({ operatorAccountId, limit })).rejects.toBeInstanceOf(
      OperatorDeniedError,
    );
  }
  expect(await commands().responsibilityPage({ operatorAccountId: newId(route) })).toEqual({
    operators: [],
    next: null,
  });
});

test('opaque cursor binds operator and operation and rejects tampering before disclosing rows', async () => {
  const first = await commands().responsibilityPage({ operatorAccountId, limit: 1 });
  const token = first.next!;
  const forged = (
    after: (string | number)[],
    options: {
      now?: number;
      epoch?: number;
      operation?: string;
      parameters?: typeof binding.query;
      viewer?: string;
    } = {},
  ) =>
    encodeListCursor(
      ring,
      {
        route: options.operation ?? binding.route,
        viewer: options.viewer ?? null,
        query: options.parameters ?? { ...binding.query, limit: 1 },
      },
      { epoch: options.epoch ?? 1, after },
      new Date(options.now ?? Date.now()),
    );
  const expiredToken = await forged([id(1)], { now: Date.now() - 16 * 60_000, viewer: accountViewer.accountId });
  const tokens = await Promise.all([
    '',
    id(1),
    'garbage',
    `${token.slice(0, -2)}xx`,
    expiredToken,
    forged([id(1)], { operation: 'access.operator.opening' }),
    forged([id(1)], { parameters: { ...binding.query, limit: 1, sort: 'reservationId:desc' } }),
    forged([id(1)], { parameters: { ...binding.query, limit: 1, purpose: 'membership' } }),
    forged([id(1)], { epoch: 2 }),
    forged([]),
    forged([id(1), id(2)]),
    forged([12]),
    forged(['bad-id']),
    encodeListCursor(
      { current: 2, keys: new Map([[2, randomBytes(32)]]) },
      { ...binding, query: { ...binding.query, limit: 1 } },
      { epoch: 1, after: [id(1)] },
      new Date(),
    ),
    encodeListCursor(
      { current: 1, keys: new Map([[1, randomBytes(32)]]) },
      { ...binding, query: { ...binding.query, limit: 1 } },
      { epoch: 1, after: [id(1)] },
      new Date(),
    ),
  ]);
  for (const cursor of tokens) {
    const attempt = await capture(db, async () => {
      await expect(
        commands().responsibilityPage(
          { operatorAccountId, limit: 1, cursor },
          cursor === expiredToken ? accountViewer : undefined,
        ),
      ).rejects.toBeInstanceOf(OperatorDeniedError);
    });
    expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
  }
  await expect(
    commands().responsibilityPage({ operatorAccountId: newId(route), limit: 1, cursor: token }),
  ).rejects.toBeInstanceOf(OperatorDeniedError);
  const unconfigured = createOperatorCommands({ pool: db.pool, access, actions, managementAction: 'account:manage' });
  await expect(unconfigured.responsibilityPage({ operatorAccountId })).rejects.toBeInstanceOf(OperatorDeniedError);
  const invalidKey = createOperatorCommands({ ...config(), cursorKeys: { current: 1, keys: new Map() } });
  await expect(invalidKey.responsibilityPage({ operatorAccountId: newId(route) })).rejects.toBeInstanceOf(
    OperatorDeniedError,
  );
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partitionOf(route)]);
  try {
    const attempt = await capture(db, async () => {
      await expect(
        commands().responsibilityPage({ operatorAccountId, limit: 1, cursor: token }),
      ).rejects.toBeInstanceOf(OperatorDeniedError);
    });
    expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
  } finally {
    await db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partitionOf(route)]);
  }
});

test('operator list cursor binds the acting viewer and page size before reading responsibilities', async () => {
  const viewer = {
    kind: 'account' as const,
    accountId: newId(route),
    clientId: 'operator-list-test',
    scopes: ['account:manage'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const page = await commands().responsibilityPage({ operatorAccountId, limit: 1 }, viewer);
  const viewerBinding = { ...binding, viewer: viewer.accountId, query: { ...binding.query, limit: 1 } };
  expect(await decodeListCursor(ring, viewerBinding, page.next!, new Date())).toMatchObject({
    ok: true,
    epoch: 1,
    after: [id(1)],
  });
  const bytes = Buffer.from(page.next!, 'base64url');
  expect(bytes.includes(Buffer.from(id(1)))).toBe(false);
  expect(bytes.includes(Buffer.from(operatorAccountId))).toBe(false);
  expect(
    (await commands().responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }, viewer)).operators,
  ).toEqual(expected.slice(1, 2));
  for (const other of [{ ...viewer, accountId: newId(route) }, { kind: 'anonymous' as const }]) {
    const attempt = await capture(db, async () => {
      await expect(
        commands().responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }, other),
      ).rejects.toBeInstanceOf(OperatorDeniedError);
    });
    expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
  }
  const attempt = await capture(db, async () => {
    await expect(
      commands().responsibilityPage({ operatorAccountId, limit: 2, cursor: page.next! }, viewer),
    ).rejects.toBeInstanceOf(OperatorDeniedError);
  });
  expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
});

test('responsibility list issuance and expiry use the configured kernel clock', async () => {
  let now = new Date('2020-01-01T00:00:00Z');
  const operators = createOperatorCommands({ ...config(), clock: () => now });
  const page = await operators.responsibilityPage({ operatorAccountId }, accountViewer);
  expect(await decodeListCursor(ring, { ...binding, viewer: accountViewer.accountId }, page.next!, now)).toMatchObject({
    ok: true,
    after: [id(20)],
  });
  expect(
    (await operators.responsibilityPage({ operatorAccountId, cursor: page.next! }, accountViewer)).operators,
  ).toEqual(expected.slice(20, 40));
  now = new Date(now.getTime() + 15 * 60_000 + 1);
  const attempt = await capture(db, async () => {
    await expect(
      operators.responsibilityPage({ operatorAccountId, cursor: page.next! }, accountViewer),
    ).rejects.toBeInstanceOf(OperatorDeniedError);
  });
  expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
});

test('an anonymous responsibility cursor is stable and carries no issue time', async () => {
  let now = new Date('2020-01-01T00:00:00Z');
  const operators = createOperatorCommands({ ...config(), clock: () => now });
  const first = await operators.responsibilityPage({ operatorAccountId });
  expect(first.next).toBeString();
  now = new Date(now.getTime() + 16 * 60_000);
  const repeated = await operators.responsibilityPage({ operatorAccountId });
  expect(repeated.next).toBe(first.next);
  expect((await operators.responsibilityPage({ operatorAccountId, cursor: first.next! })).operators).toEqual(
    expected.slice(20, 40),
  );
});

test('internal fanout keeps sealed work cursors separate from opaque list cursors', async () => {
  const operators = commands();
  const page = await operators.responsibilityWorkPage({ operatorAccountId, limit: 1 });
  expect(
    decodeCursor(
      ring,
      {
        operation: binding.route,
        parameters: {
          operatorAccountId,
          purpose: 'operator',
          sort: 'reservationId:asc',
        },
      },
      page.next!,
    ),
  ).toMatchObject({ ok: true, epoch: 1, after: [id(1)] });
  expect(
    (await operators.responsibilityWorkPage({ operatorAccountId, limit: 1, cursor: page.next! })).operators,
  ).toEqual(expected.slice(1, 2));
  await expect(
    operators.responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }),
  ).rejects.toBeInstanceOf(OperatorDeniedError);
  const list = await operators.responsibilityPage({ operatorAccountId, limit: 1 });
  await expect(
    operators.responsibilityWorkPage({ operatorAccountId, limit: 1, cursor: list.next! }),
  ).rejects.toBeInstanceOf(OperatorDeniedError);
});

test('anonymous list cursors cannot resume as an account viewer', async () => {
  const page = await commands().responsibilityPage({ operatorAccountId, limit: 1 });
  const viewer = {
    kind: 'account' as const,
    accountId: newId(route),
    clientId: 'operator-list-test',
    scopes: ['account:manage'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const attempt = await capture(db, async () => {
    await expect(
      commands().responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }, viewer),
    ).rejects.toBeInstanceOf(OperatorDeniedError);
  });
  expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
});

test('responsibility list inherits the Access kernel clock and honors the exact expiry boundary', async () => {
  let now = new Date('2020-01-01T00:00:00Z');
  let clockReads = 0;
  const access = createAccess({ actions, accountEvidence: () => null });
  installAccessClock(access, () => {
    clockReads++;
    return now;
  });
  const operators = createOperatorCommands({ ...config(), access });
  const page = await operators.responsibilityPage({ operatorAccountId, limit: 1 }, accountViewer);
  expect(clockReads).toBe(1);
  expect(
    await decodeListCursor(
      ring,
      { ...binding, viewer: accountViewer.accountId, query: { ...binding.query, limit: 1 } },
      page.next!,
      now,
    ),
  ).toMatchObject({ ok: true, epoch: 1, after: [id(1)] });
  now = new Date(now.getTime() + 15 * 60_000);
  expect(
    (await operators.responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }, accountViewer)).operators,
  ).toEqual(expected.slice(1, 2));
  expect(clockReads).toBe(2);
  now = new Date(now.getTime() + 1);
  const attempt = await capture(db, async () => {
    await expect(
      operators.responsibilityPage({ operatorAccountId, limit: 1, cursor: page.next! }, accountViewer),
    ).rejects.toBeInstanceOf(OperatorDeniedError);
  });
  expect(clockReads).toBe(3);
  expect(attempt.capture.statements.some((sql) => sql.includes('access.lifecycle_coordination'))).toBe(false);
});

test('stable keyset pages are bounded and include pending responsibilities conservatively', async () => {
  const first = await commands().responsibilityPage({ operatorAccountId, limit: 20 });
  await db.admin.query(
    'DELETE FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3',
    [route, operatorAccountId, id(1)],
  );
  await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'operator',$5)`, [
    route,
    operatorAccountId,
    id(0),
    newId(route),
    newId(route),
  ]);
  await db.admin.query(`INSERT INTO access.lifecycle_coordination VALUES ($1,$2,$3,$4,'membership',$5)`, [
    route,
    operatorAccountId,
    id(46),
    newId(route),
    newId(route),
  ]);
  const result = await capture(db, () => commands().responsibilityPage({ operatorAccountId, cursor: first.next! }));
  expect(result.value.operators).toEqual(expected.slice(20, 40));
  expect(result.capture.statements.filter((sql) => sql.includes('access.lifecycle_coordination'))).toHaveLength(1);
  expect(result.capture.statements.some((sql) => /OFFSET|count\s*\(/i.test(sql))).toBe(false);
});
