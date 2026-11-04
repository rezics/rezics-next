import { afterAll, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { prepareSubjectThreadEntry, projectSubjectThreadCreateAdvice } from '../../src/content/subject-entry.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

test('selected Board advice preserves sign-in, current denial and unavailable', () => {
  const account = {
    kind: 'account',
    accountId: newId(0x789a),
    clientId: 'subject-entry-test',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  } as const;
  const anonymous = { kind: 'anonymous' } as const;
  expect(projectSubjectThreadCreateAdvice(anonymous, 'allowed', true)).toBe('sign-in');
  expect(projectSubjectThreadCreateAdvice(account, 'allowed', false)).toBe('denied');
  expect(projectSubjectThreadCreateAdvice(account, 'unavailable', true)).toBe('unavailable');
  expect(projectSubjectThreadCreateAdvice(account, 'allowed', true)).toBe('allowed');
});

test('final selected Board observation withholds entry after its read authority changes', async () => {
  const subjectId = newId(0x4567);
  const boardId = newId(0x4321);
  await db.admin.query(
    `INSERT INTO content.board (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Selected Board', 'published', 1, $2)`,
    [routeOf(boardId), boardId, subjectId],
  );
  const access = createAccess({
    actions: new Map([
      ['board:read', { anonymous: true }],
      ['realm:read', { anonymous: true }],
      ['thread:create', { anonymous: true }],
      ['post:create', { anonymous: true }],
      ['reaction:set', { anonymous: true }],
    ]),
  });
  const dependencies = {
    pool: db.pool,
    access,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
  };
  const context = {
    subject: {
      id: subjectId,
      label: null,
      source: { partition: routeOf(subjectId)! >>> 4, epoch: 1, position: '1' },
    },
    place: { kind: 'global' as const, id: GLOBAL_CONTEXT },
    kind: 'discussion' as const,
  };
  const readContext = { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 };
  const selected = await prepareSubjectThreadEntry(dependencies, context, boardId, readContext);
  expect(selected.initial).toMatchObject({ state: 'current', actions: { createThread: 'sign-in' } });

  await db.admin.query(
    "UPDATE content.board SET visibility = 'taken_down', security_revision = security_revision + 1 WHERE route = $1 AND board_id = $2",
    [routeOf(boardId), boardId],
  );
  const final = await selected.finish();
  expect(final.entry).toMatchObject({ state: 'concealed' });
  expect(final.entry).not.toHaveProperty('board');
  expect(final.anchors.length).toBeGreaterThan(0);
});
