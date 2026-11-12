import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { AccountActor } from '../../src/request/access.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { InvalidHostedCursorError } from '../../src/content/hosted-chapters-model.ts';
import {
  hostedHistoryBinding,
  readHostedHistoryCursor,
  writeHostedHistoryCursor,
} from '../../src/content/hosted-chapters-history-cursor.ts';

const catalogueId = '00000000-0000-7000-8000-000000000001';
const revisionId = '00000000-0000-7000-8000-000000000002';
const actor: AccountActor = {
  kind: 'account',
  accountId: '00000000-0000-7000-8000-000000000003',
  clientId: 'author-client',
  requestedBy: null,
  authnEpoch: 7,
  scopes: ['post:read', 'post:revise'],
};
const binding = (overrides: Partial<AccountActor> = {}, id = catalogueId, limit = 2) =>
  hostedHistoryBinding(id, { actor: { ...actor, ...overrides }, deadline: Date.now() + 10_000 }, limit);

function fixture() {
  let now = Date.parse('2026-11-13T10:00:00.000Z');
  const tokens: KeyRing = { current: 1, keys: new Map([[1, randomBytes(32)]]) };
  return { deps: { tokens, clock: () => new Date(now) }, advance: (ms: number) => (now += ms) };
}

test('history cursors preserve microseconds, encrypt boundaries and cannot renew the original lifetime', () => {
  const { deps, advance } = fixture();
  const state = {
    after: { createdAt: '2026-11-13T09:59:59.123456Z', revisionId },
    epoch: 9,
    issuedAt: deps.clock().getTime(),
  };
  const token = writeHostedHistoryCursor(deps, binding(), state);
  const envelope = Buffer.from(token.split('.')[0]!, 'base64url').subarray(2).toString('utf8');
  expect(envelope).not.toContain(revisionId);
  expect(envelope).not.toContain(state.after.createdAt);
  expect(readHostedHistoryCursor(deps, binding(), catalogueId, 9, token)).toEqual(state);
  advance(14 * 60_000);
  const continued = writeHostedHistoryCursor(
    deps,
    binding(),
    readHostedHistoryCursor(deps, binding(), catalogueId, 9, token)!,
  );
  advance(60_001);
  expect(() => readHostedHistoryCursor(deps, binding(), catalogueId, 9, continued)).toThrow(InvalidHostedCursorError);
});

test('continuations reject changed query, identity, delegation, scopes, epoch, key and damaged input', () => {
  const { deps } = fixture();
  const token = writeHostedHistoryCursor(deps, binding(), {
    after: { createdAt: '2026-11-13T09:59:59.000001Z', revisionId },
    epoch: 9,
    issuedAt: deps.clock().getTime(),
  });
  const changedBindings = [
    binding({}, revisionId),
    binding({}, catalogueId, 3),
    binding({ accountId: revisionId }),
    binding({ clientId: 'other-client' }),
    binding({ requestedBy: revisionId }),
    binding({ authnEpoch: 8 }),
    binding({ scopes: ['post:read'] }),
  ];
  for (const changed of changedBindings)
    expect(() => readHostedHistoryCursor(deps, changed, catalogueId, 9, token)).toThrow(InvalidHostedCursorError);
  expect(() => readHostedHistoryCursor(deps, binding(), catalogueId, 10, token)).toThrow(InvalidHostedCursorError);
  for (const damaged of ['', 'malformed', `${token}x`])
    expect(() => readHostedHistoryCursor(deps, binding(), catalogueId, 9, damaged)).toThrow(InvalidHostedCursorError);
  expect(
    readHostedHistoryCursor(deps, binding({ scopes: [...actor.scopes].reverse() }), catalogueId, 9, token),
  ).not.toBeNull();
  deps.tokens.keys = new Map([[1, randomBytes(32)]]);
  expect(() => readHostedHistoryCursor(deps, binding(), catalogueId, 9, token)).toThrow(InvalidHostedCursorError);
});
