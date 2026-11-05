import { expect, test } from 'bun:test';
import { access } from '../src/access/index.ts';
import {
  actorOf,
  anonymousAccess,
  AuthenticationError,
  type Access,
  type AccountActor,
} from '../src/request/access.ts';

const context = { pool: {} as never, deadline: Date.now() + 2_000 };
const request = (authorization?: string) =>
  new Request('http://kernel.test/v1/subjects', authorization === undefined ? {} : { headers: { authorization } });
const account: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  scopes: ['subject:read'],
  requestedBy: null,
  authnEpoch: 3,
};
const subject = { route: 0xbeef, id: '019a1b2c-3d4e-7f00-8a00-beef00000002' };
function verifier(seen: unknown[]): Access {
  return {
    async authenticate(token, received) {
      seen.push([token, received]);
      return account;
    },
    async authorize() {
      return false;
    },
  };
}
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

test('a request without credentials is anonymous', async () => {
  expect(await actorOf(anonymousAccess, request(), context)).toEqual({ kind: 'anonymous' });
  expect(await actorOf(verifier([]), request(), context)).toEqual({ kind: 'anonymous' });
});

test('a bearer token goes to the access module and never falls back to anonymous', async () => {
  const seen: unknown[] = [];
  expect(await actorOf(verifier(seen), request('Bearer eyJhbGciOiJFUzI1NiJ9.e30.c2ln-_~+/=='), context)).toBe(account);
  expect(await actorOf(verifier(seen), request('bearer abc'), context)).toBe(account);
  expect(seen).toEqual([
    ['eyJhbGciOiJFUzI1NiJ9.e30.c2ln-_~+/==', context],
    ['abc', context],
  ]);
  const error = await refusal(actorOf(anonymousAccess, request('Bearer abc'), context));
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ name: 'AuthenticationError', status: 401, challenge: 'Bearer error="invalid_token"' });
});

test('another scheme or a malformed bearer token is refused before verification', async () => {
  const seen: unknown[] = [];
  expect(await refusal(actorOf(verifier(seen), request('Basic dXNlcjpwYXNz'), context))).toMatchObject({
    status: 401,
    challenge: 'Bearer',
  });
  for (const header of ['Bearer', 'Bearer a b', 'Bearer a=b', 'Bearer ä']) {
    expect(await refusal(actorOf(verifier(seen), request(header), context))).toMatchObject({
      status: 400,
      challenge: 'Bearer error="invalid_request"',
    });
  }
  expect(seen).toEqual([]);
});

test('until the access module is installed, reads are allowed and every other action is denied', async () => {
  const installed: Access = access();
  expect(typeof installed.authenticate).toBe('function');
  const client = {} as never;
  expect(await anonymousAccess.authorize(client, { kind: 'anonymous' }, 'subject:read', subject)).toBe(true);
  expect(await anonymousAccess.authorize(client, { kind: 'anonymous' }, 'subject:create', subject)).toBe(false);
  expect(await anonymousAccess.authorize(client, account, 'subject:create', subject)).toBe(false);
});
