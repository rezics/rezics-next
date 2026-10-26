import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  ANONYMOUS_PRINCIPAL_ID,
  normalizeCommandKey,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandPrincipal,
} from '../src/command/command.ts';
import {
  anonymousCommandTarget,
  anonymousRequestDigest,
  idempotencyKeyOf,
  requestDigest,
} from '../src/http/request.ts';
import type { AccountActor } from '../src/request/access.ts';
import { anchorRoute, derivedId, partitionOf, routeOf } from '../src/route/route.ts';

const anonymous = principalCommandIdentity({ kind: 'anonymous' });
const account: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-beef00000001',
  clientId: 'web',
  requestedBy: null,
  scopes: [],
  authnEpoch: 1,
};
const key = '8e03978e-40d5-43e8-bc93-6894a57f9324';
const routeKey = new Uint8Array(32).fill(11);
const operation = 'report.create';
const semantic = { target: { route: 24, id: account.accountId }, reason: 'spam', description: 'Repeated posts' };

test('anonymous keys are canonical UUIDv4 with ASCII hex case normalized', () => {
  for (const variant of ['8', '9', 'a', 'b']) {
    const valid = `${key.slice(0, 19)}${variant}${key.slice(20)}`;
    for (const spelling of [valid, valid.toUpperCase(), valid.replace('e', 'E')]) {
      expect(normalizeCommandKey(anonymous.principal, spelling)).toBe(valid);
    }
  }
  for (const invalid of [
    undefined,
    null,
    123,
    '',
    'text-key',
    ANONYMOUS_PRINCIPAL_ID,
    key.replace('-43e8-', '-13e8-'),
    key.replace('-43e8-', '-73e8-'),
    key.replace('-bc93-', '-7c93-'),
    key.replace('-bc93-', '-cc93-'),
    key.replace('8e', '8g'),
    key.replace('8e', '８e'),
    key.replaceAll('-', ''),
    `{${key}}`,
    `urn:uuid:${key}`,
    ` ${key}`,
    `${key}\n`,
  ]) {
    expect(() => normalizeCommandKey(anonymous.principal, invalid as string)).toThrow(TypeError);
  }
});

test('account keys keep their text and case, and malformed principals are rejected', () => {
  const principal = principalCommandIdentity(account).principal;
  for (const text of ['A', 'Text Key', key.toUpperCase(), 'k'.repeat(255)]) {
    expect(normalizeCommandKey(principal, text)).toBe(text);
  }
  for (const invalid of [undefined, null, 1, '', 'k'.repeat(256)]) {
    expect(() => normalizeCommandKey(principal, invalid as string)).toThrow(TypeError);
  }
  for (const invalid of [
    undefined,
    null,
    {},
    { kind: 'unknown', id: account.accountId },
    { kind: 'anonymous', id: account.accountId },
    { kind: 'anonymous' },
    { kind: 'account', id: ANONYMOUS_PRINCIPAL_ID },
    { kind: 'account' },
  ]) {
    expect(() => normalizeCommandKey(invalid as CommandPrincipal, key)).toThrow(TypeError);
  }
});

test('anonymous target uses the exact normalized tuple and existing route and ID derivations', () => {
  const name = JSON.stringify(['anonymous', ANONYMOUS_PRINCIPAL_ID, operation, key]);
  const route = anchorRoute(routeKey, name);
  const expected = { route, id: derivedId(ANONYMOUS_PRINCIPAL_ID, name, route) };
  expect(anonymousCommandTarget(routeKey, operation, key)).toEqual(expected);
  expect(anonymousCommandTarget(routeKey, operation, key.toUpperCase())).toEqual(expected);
  expect(routeOf(expected.id)).toBe(expected.route);
  expect(anonymousCommandTarget(routeKey, 'report.update', key).id).not.toBe(expected.id);
  expect(anonymousCommandTarget(routeKey, operation, key.replace('8e03', '9e03')).id).not.toBe(expected.id);
  expect(anonymousCommandTarget(new Uint8Array(32).fill(12), operation, key)).not.toEqual(expected);
  expect(() => anonymousCommandTarget(routeKey, operation, 'text-key')).toThrow(TypeError);
});

test('anonymous effect digest excludes fresh abuse proof and covers operation and semantic changes', () => {
  const digest = anonymousRequestDigest(operation, { semantic });
  // Pin the canonical bytes independently of the wrapper and requestDigest.
  const canonicalBody =
    '{"description":"Repeated posts","reason":"spam","target":{"id":"019a1b2c-3d4e-7f00-8a00-beef00000001","route":24}}';
  const canonicalDigest = createHash('sha256')
    .update(`{"body":${canonicalBody},"client_id":null,"operation":"report.create","requested_by":null}`)
    .digest();
  expect(digest).toHaveLength(32);
  expect(digest).toEqual(canonicalDigest);
  expect(digest).toEqual(requestDigest(operation, { kind: 'anonymous' }, semantic));
  for (const abuse of [undefined, { turnstile: 'first', csrf: 'first' }, { turnstile: 'fresh', csrf: 'fresh' }]) {
    expect(anonymousRequestDigest(operation, { semantic, abuse })).toEqual(digest);
  }
  expect(
    anonymousRequestDigest(operation, {
      semantic: {
        description: semantic.description,
        reason: semantic.reason,
        target: { id: account.accountId, route: 24 },
      },
    }),
  ).toEqual(digest);
  for (const changed of [
    { ...semantic, reason: 'abuse' },
    { ...semantic, description: 'Different posts' },
    { ...semantic, target: { ...semantic.target, route: 25 } },
    { ...semantic, target: { ...semantic.target, id: key } },
  ]) {
    expect(anonymousRequestDigest(operation, { semantic: changed })).not.toEqual(digest);
  }
  expect(anonymousRequestDigest('report.update', { semantic })).not.toEqual(digest);
});

test('account request digest bytes and attribution remain unchanged', () => {
  const digest = requestDigest('subject.create', account, { labels: { en: 'A', ja: 'B' }, aliases: {} });
  expect(digest).toEqual(
    createHash('sha256')
      .update(
        '{"body":{"aliases":{},"labels":{"en":"A","ja":"B"}},"client_id":"web","operation":"subject.create","requested_by":null}',
      )
      .digest(),
  );
  expect(
    requestDigest('subject.create', { ...account, clientId: 'cli' }, { labels: { en: 'A', ja: 'B' }, aliases: {} }),
  ).not.toEqual(digest);
  expect(
    requestDigest(
      'subject.create',
      { ...account, requestedBy: 'agent' },
      { labels: { en: 'A', ja: 'B' }, aliases: {} },
    ),
  ).not.toEqual(digest);
});

test('helper output without both authorization and a receipt grants no anonymous execution before I/O', async () => {
  let touched = 0;
  const unexpected = (): never => {
    touched++;
    throw new Error('Anonymous command reached I/O or a callback');
  };
  const pool = new Proxy({} as Pool, { get: unexpected });
  const originalKey = idempotencyKeyOf(`"${key.toUpperCase()}"`);
  const target = anonymousCommandTarget(routeKey, operation, originalKey);
  const options = {
    ...anonymous,
    partition: partitionOf(target.route),
    receipt: { kind: operation, key: originalKey, digest: anonymousRequestDigest(operation, { semantic }) },
    clock: unexpected,
  };
  const authorization: CommandAuthorization = {
    action: 'report:create',
    resource: target,
    prepare: unexpected,
    authorize: unexpected,
    denied: unexpected,
  };
  const { receipt, ...withoutReceipt } = options;
  for (const input of [withoutReceipt, { ...withoutReceipt, receipt }]) {
    await expect(runCommand(pool, input, unexpected)).rejects.toThrow('Anonymous commands require authorization');
  }
  await expect(runCommand(pool, { ...withoutReceipt, authorization }, unexpected)).rejects.toThrow(
    'Anonymous commands require a client-generated UUIDv4 key',
  );
  expect(originalKey).toBe(key.toUpperCase());
  expect(touched).toBe(0);
});
