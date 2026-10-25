import { expect, test } from 'bun:test';
import { accessCheck, anonymousAccess, type Access, type Actor } from '../src/request/access.ts';

const context = { pool: {} as never, deadline: Date.now() + 2_000 };
const subject = { route: 0xbeef, id: '019a1b2c-3d4e-7f00-8a00-beef00000002' };
const anonymous: Actor = { kind: 'anonymous' };

test('evidence is gathered once before the resource connection and reaches every authorization', async () => {
  const calls: unknown[] = [];
  const evidence = { organization: '019a1b2c-3d4e-7f00-8a00-0a0a00000003', role: 'editor' };
  const access: Access = {
    async authenticate() {
      throw new Error('not used');
    },
    async prepare(actor, action, resource, received) {
      calls.push(['prepare', actor, action, resource, received]);
      return evidence;
    },
    async authorize(client, actor, action, resource, received) {
      calls.push(['authorize', client, actor, action, resource, received]);
      return true;
    },
  };
  const allowed = await accessCheck(access, anonymous, 'subject:update', subject, context);
  expect(calls).toEqual([['prepare', anonymous, 'subject:update', subject, context]]);
  const first = { query: async () => ({ rows: [] }) } as never;
  const second = { query: async () => ({ rows: [] }) } as never;
  expect(await allowed(first)).toBe(true);
  expect(await allowed(second)).toBe(true);
  expect(calls.slice(1)).toEqual([
    ['authorize', first, anonymous, 'subject:update', subject, evidence],
    ['authorize', second, anonymous, 'subject:update', subject, evidence],
  ]);
});

test('a refusal from prepare stops the check before any connection is used', async () => {
  const refused = new Error('organization unavailable');
  let authorized = false;
  const access: Access = {
    async authenticate() {
      throw new Error('not used');
    },
    async prepare() {
      throw refused;
    },
    async authorize() {
      authorized = true;
      return true;
    },
  };
  expect(
    await accessCheck(access, anonymous, 'subject:update', subject, context).catch((error: unknown) => error),
  ).toBe(refused);
  expect(authorized).toBe(false);
});

test('the anonymous stand-in gathers no evidence and makes no query', async () => {
  const allowRead = await accessCheck(anonymousAccess, anonymous, 'subject:read', subject, context);
  const allowCreate = await accessCheck(anonymousAccess, anonymous, 'subject:create', subject, context);
  expect(await allowRead({} as never)).toBe(true);
  expect(await allowCreate({} as never)).toBe(false);
});
