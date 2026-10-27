import { expect, test } from 'bun:test';
import {
  preparationHeaderCommitment,
  type PreparationHeaderCommitment,
} from '../../src/library/preparation-bindings.ts';
import { newId } from '../../src/route/route.ts';

function header(): PreparationHeaderCommitment {
  const accountId = '00000000-0000-7000-8000-6a1000000001';
  const sourceId = '00000000-0000-7000-8000-7b2000000002';
  const identity = {
    sourceId,
    partition: 1970,
    epoch: 2,
    revision: 4,
    transactionId: '00000000-0000-7000-8000-000000000003',
    redirect: null,
  };
  return {
    version: 1,
    route: 0x6a10,
    accountId,
    preparationId: '00000000-0000-7000-8000-6a1000000004',
    binding: {
      accountId,
      subjectId: sourceId,
      requestKey: 'request-key',
      sourceId,
      sourcePartition: 1970,
      sourceEpoch: 2,
      sourcePosition: '9007199254740993',
      ownerEpoch: '9007199254740995',
    },
    origin: { sourceId, partition: 1970, epoch: 2, position: '9007199254740993', survivorId: null },
    sourceIdentity: identity,
    originIdentity: { ...identity },
    principalNamespace: {
      principal: { kind: 'account', id: accountId },
      basis: { clientId: 'website', requestedBy: null },
    },
    reservationId: '00000000-0000-7000-8000-6a1000000005',
    inputByteLength: '9007199254740993',
    inputDigest: 'a'.repeat(64),
    creationTransactionId: '00000000-0000-7000-8000-000000000006',
    creationReceipt: {
      partition: 1697,
      principalKind: 'account',
      principalId: accountId,
      commandKind: 'library.type-preparation.create',
      key: 'metadata-key',
      digest: 'b'.repeat(64),
    },
    createdAt: '2026-10-27T00:00:00.000001Z',
  };
}

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)]),
  );
}

function commit(value: unknown): string {
  return preparationHeaderCommitment(value as PreparationHeaderCommitment);
}

test('header commitment matches an independently serialized canonical JSON vector', () => {
  const payload = header();
  expect(commit(payload)).toBe('707eb22432a16789dbfd8acb411436cdfc2b29415616ad810d558a2f72eb8edf');
  expect(commit(reverseKeys(payload))).toBe(commit(payload));
  expect(commit(structuredClone(payload))).toBe(commit(payload));
});

test('header commitment preserves principal attribution and native scalar precision', () => {
  const payload = header();
  const { binding, origin, principalNamespace, creationReceipt } = payload;
  for (const changed of [
    { ...payload, principalNamespace: { ...principalNamespace, basis: { clientId: 'mobile', requestedBy: null } } },
    {
      ...payload,
      principalNamespace: { ...principalNamespace, basis: { clientId: 'website', requestedBy: 'delegate' } },
    },
    { ...payload, binding: { ...binding, ownerEpoch: '9007199254740994' } },
    { ...payload, binding: { ...binding, requestKey: 'another-request' } },
    {
      ...payload,
      binding: { ...binding, sourcePosition: '9007199254740992' },
      origin: { ...origin, position: '9007199254740992' },
    },
    { ...payload, reservationId: null },
    { ...payload, reservationId: newId(payload.route) },
    { ...payload, preparationId: newId(payload.route) },
    { ...payload, inputByteLength: '9007199254740992' },
    { ...payload, inputDigest: 'c'.repeat(64) },
    { ...payload, creationTransactionId: newId(0) },
    { ...payload, creationReceipt: { ...creationReceipt, digest: 'c'.repeat(64) } },
    { ...payload, creationReceipt: { ...creationReceipt, key: 'another-key' } },
    { ...payload, createdAt: '2026-10-27T00:00:00.000002Z' },
  ])
    expect(commit(changed)).not.toBe(commit(payload));
  expect(commit({ ...payload, inputByteLength: '0', binding: { ...binding, ownerEpoch: '0' } })).toMatch(
    /^[a-f0-9]{64}$/,
  );
});

test('header commitment independently binds a remote origin and its separately observed survivor', () => {
  const base = header();
  const survivor = newId(0x8c30);
  const payload: PreparationHeaderCommitment = {
    ...base,
    binding: { ...base.binding, sourceId: survivor, sourcePartition: 2243, sourceEpoch: 7, sourcePosition: '37' },
    origin: { ...base.origin, survivorId: survivor },
    sourceIdentity: { ...base.sourceIdentity, sourceId: survivor, partition: 2243, epoch: 7, revision: 11 },
    originIdentity: { ...base.originIdentity, redirect: survivor },
  };
  expect(commit(payload)).toMatch(/^[a-f0-9]{64}$/);
  for (const changed of [
    { ...payload, originIdentity: { ...payload.originIdentity, revision: 5 } },
    { ...payload, sourceIdentity: { ...payload.sourceIdentity, revision: 12 } },
    { ...payload, origin: { ...payload.origin, position: '9007199254740994' } },
    { ...payload, binding: { ...payload.binding, sourcePosition: '38' } },
  ])
    expect(commit(changed)).not.toBe(commit(payload));
  for (const changed of [
    { ...payload, origin: { ...payload.origin, survivorId: newId(0x8c30) } },
    { ...payload, originIdentity: { ...payload.originIdentity, redirect: null } },
    { ...payload, sourceIdentity: { ...payload.sourceIdentity, redirect: newId(0x9d40) } },
    { ...payload, sourceIdentity: payload.originIdentity, originIdentity: payload.sourceIdentity },
  ])
    expect(() => commit(changed)).toThrow();
});

test('header commitment rejects mismatched owner receipt namespaces and source identities', () => {
  const payload = header();
  for (const changed of [
    { ...payload, version: 2 },
    { ...payload, accountId: payload.accountId + '\n' },
    { ...payload, preparationId: payload.preparationId + '\n' },
    { ...payload, creationTransactionId: payload.creationTransactionId + '\n' },
    { ...payload, binding: { ...payload.binding, sourceId: payload.binding.sourceId + '\n' } },
    { ...payload, route: payload.route + 1 },
    { ...payload, preparationId: newId(0x7b20) },
    { ...payload, reservationId: newId(0x7b20) },
    { ...payload, binding: { ...payload.binding, accountId: newId(payload.route) } },
    { ...payload, origin: { ...payload.origin, sourceId: newId(0x7b20) } },
    { ...payload, binding: { ...payload.binding, sourcePartition: 1971 } },
    { ...payload, sourceIdentity: { ...payload.sourceIdentity, epoch: 3 } },
    { ...payload, originIdentity: { ...payload.originIdentity, transactionId: newId(0) } },
    { ...payload, originIdentity: { ...payload.originIdentity, revision: 5 } },
    { ...payload, origin: { ...payload.origin, position: '0' } },
    {
      ...payload,
      principalNamespace: { ...payload.principalNamespace, principal: { kind: 'anonymous', id: payload.accountId } },
    },
    {
      ...payload,
      principalNamespace: { ...payload.principalNamespace, principal: { kind: 'account', id: newId(payload.route) } },
    },
    { ...payload, principalNamespace: { ...payload.principalNamespace, basis: null } },
    ...[
      { partition: 1698 },
      { principalKind: 'anonymous' },
      { principalId: newId(payload.route) },
      { commandKind: 'library.entry.put' },
      { key: '' },
      { key: 'x'.repeat(256) },
      { key: '😀'.repeat(128) },
    ].map((fields) => ({ ...payload, creationReceipt: { ...payload.creationReceipt, ...fields } })),
  ])
    expect(() => commit(changed)).toThrow();
});

test('header commitment rejects noncanonical scalars and impossible UTC microsecond dates', () => {
  const payload = header();
  for (const value of ['01', '-1', '+1', '1.0', '1e3', ' 1', '1\n', '', 1, 1n, null, undefined]) {
    expect(() => commit({ ...payload, inputByteLength: value })).toThrow();
    expect(() => commit({ ...payload, binding: { ...payload.binding, ownerEpoch: value } })).toThrow();
    expect(() => commit({ ...payload, binding: { ...payload.binding, sourcePosition: value } })).toThrow();
  }
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2', null]) {
    expect(() => commit({ ...payload, sourceIdentity: { ...payload.sourceIdentity, revision: value } })).toThrow();
    expect(() => commit({ ...payload, originIdentity: { ...payload.originIdentity, epoch: value } })).toThrow();
  }
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n', new Uint8Array(32), null]) {
    expect(() => commit({ ...payload, inputDigest: value })).toThrow();
    expect(() => commit({ ...payload, creationReceipt: { ...payload.creationReceipt, digest: value } })).toThrow();
  }
  for (const value of [
    '2026-10-27T00:00:00.000Z',
    '2026-10-27T00:00:00.000001+00:00',
    '2026-02-29T00:00:00.000001Z',
    '2026-04-31T00:00:00.000001Z',
    '2026-10-27T24:00:00.000001Z',
    '2026-10-27T00:00:60.000001Z',
    '0000-01-01T00:00:00.000001Z',
    payload.createdAt + '\n',
    new Date(payload.createdAt),
  ])
    expect(() => commit({ ...payload, createdAt: value })).toThrow();
  expect(commit({ ...payload, createdAt: '2024-02-29T23:59:59.999999Z' })).toMatch(/^[a-f0-9]{64}$/);
  expect(() => commit({ ...payload, binding: { ...payload.binding, requestKey: '\ud800' } })).toThrow();
});

test('header commitment rejects payload text and unknown or missing properties at every level', () => {
  const payload = header();
  const objects = [
    payload,
    payload.binding,
    payload.origin,
    payload.sourceIdentity,
    payload.originIdentity,
    payload.principalNamespace,
    payload.principalNamespace.principal,
    payload.principalNamespace.basis,
    payload.creationReceipt,
  ];
  for (const object of objects) {
    for (const key of ['fullType', 'metadataCommitment', 'progress', 'enqueuePending']) {
      Object.defineProperty(object, key, { value: 'schema:Secret', enumerable: true, configurable: true });
      expect(() => commit(payload)).toThrow();
      Reflect.deleteProperty(object, key);
    }
    for (const key of Object.keys(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      Reflect.deleteProperty(object, key);
      expect(() => commit(payload)).toThrow();
      Object.defineProperty(object, key, { get: () => descriptor.value, enumerable: true, configurable: true });
      expect(() => commit(payload)).toThrow();
      Object.defineProperty(object, key, { ...descriptor, enumerable: false });
      expect(() => commit(payload)).toThrow();
      Object.defineProperty(object, key, descriptor);
    }
    const symbol = Symbol('hidden');
    Object.defineProperty(object, symbol, { value: 'secret', configurable: true });
    expect(() => commit(payload)).toThrow();
    Reflect.deleteProperty(object, symbol);
  }
  expect(commit(payload)).toMatch(/^[a-f0-9]{64}$/);
});
