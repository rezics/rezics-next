import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import {
  ACCOUNT_ROLE_BITS,
  ACCOUNT_ROLES,
  ALL_ACCOUNT_ROLES,
  HISTORY_ARTIFACTS,
  EVENT_CLASSIFICATIONS,
  historyArtifact,
  encodeRoles,
  decodeRoles,
  validateRoleMask,
  classifyEvent,
  assertEventClassifications,
  type AccountRole,
  type HistoryArtifactType,
} from '../../src/history/contracts.ts';
import {
  encodeLocator,
  decodeLocator,
  validateLocator,
  validateScope,
  type HistoryLocator,
} from '../../src/history/locator.ts';

const id = '00000000-0000-8000-8000-002a00000001';
const types = ['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1'] as const;
const receipt = {
  artifactType: 'command-receipt/v1',
  partitionNo: 4095,
  principalKind: 'account',
  principalId: id,
  commandKindId: 0xffffffff,
  keyVersion: 65535,
  keyToken: 'ab'.repeat(32),
} as const;
const outbox = {
  artifactType: 'outbox-event/v1',
  partitionNo: 0,
  position: 9223372036854775807n,
  eventSeq: 999,
} as const;
const work = { artifactType: 'durable-work/v1', workId: id } as const;
const ref = { accountRoute: 42, accountId: id, roles: ACCOUNT_ROLE_BITS.author | ACCOUNT_ROLE_BITS.actor };

// Independent inventory: values are persisted, so reordering the implementation cannot silently change them.
const inventory = {
  principal: 1,
  actor: 2,
  'acting-human': 4,
  delegate: 8,
  operator: 16,
  subject: 32,
  'durable-initiator': 64,
  reporter: 128,
  author: 256,
  member: 512,
  buyer: 1024,
  creator: 2048,
  reviewer: 4096,
  owner: 8192,
  uploader: 16384,
  appellant: 32768,
  voter: 65536,
  'related-party': 131072,
};

test('registry closes over exactly three artifact types and minimizer version one', () => {
  expect(Object.keys(HISTORY_ARTIFACTS)).toEqual(types);
  for (const type of types) {
    const entry = historyArtifact(type, 1);
    expect(entry.minimizerVersion).toBe(1);
    expect(entry.skeletonFields.length).toBeGreaterThan(0);
    expect(entry.roles).toEqual(ACCOUNT_ROLES);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.skeletonFields)).toBe(true);
    for (const version of [0, 2, NaN, Infinity, -1]) expect(() => historyArtifact(type, version)).toThrow();
    expect(() => historyArtifact(type.replace('/v1', '/v2'))).toThrow();
  }
  for (const type of ['', 'toString', '__proto__', 'command-receipt', 'unknown/v1'])
    expect(() => historyArtifact(type)).toThrow();
  expect(HISTORY_ARTIFACTS['command-receipt/v1'].skeletonFields).toEqual([
    'partition_no',
    'principal_kind',
    'principal_id',
    'command_kind_id',
    'key_version',
    'key_token',
    'request_digest',
    'epoch',
    'position',
    'transaction_id',
    'created_at',
    'payload_state',
    'response',
  ]);
  expect(HISTORY_ARTIFACTS['outbox-event/v1'].skeletonFields).toEqual([
    'partition_no',
    'epoch',
    'position',
    'event_seq',
    'event_count',
    'id',
    'type',
    'recorded_at',
    'payload_state',
  ]);
  expect(HISTORY_ARTIFACTS['durable-work/v1'].skeletonFields).toEqual([
    'work_id',
    'source_coordinates',
    'terminal_code',
    'barrier_proof',
  ]);
});

test('role union covers the complete account inventory with stable independent bits', () => {
  expect(ACCOUNT_ROLE_BITS).toEqual(inventory);
  expect(new Set(Object.values(ACCOUNT_ROLE_BITS)).size).toBe(Object.keys(inventory).length);
  expect(encodeRoles(ACCOUNT_ROLES)).toBe(ALL_ACCOUNT_ROLES);
  expect(decodeRoles(ALL_ACCOUNT_ROLES)).toEqual(ACCOUNT_ROLES);
  expect(encodeRoles([])).toBe(0);
  expect(decodeRoles(0)).toEqual([]);
  for (const role of ACCOUNT_ROLES) expect(decodeRoles(encodeRoles([role]))).toEqual([role]);
  expect(encodeRoles(['actor', 'author', 'actor'])).toBe(258);
  for (const mask of [262144, 262145, 2 ** 32, 2 ** 32 + 1, -1, 1.5, NaN, Infinity, '1', null]) {
    expect(() => validateRoleMask(mask)).toThrow();
  }
  expect(() => validateRoleMask(ACCOUNT_ROLE_BITS.author, ACCOUNT_ROLE_BITS.actor)).toThrow();
  for (const role of ['unknown', '__proto__', 'toString']) expect(() => encodeRoles([role as AccountRole])).toThrow();
});

test('binary locator round trips every artifact with exact identities, boundaries and byte views', () => {
  const locators: HistoryLocator[] = [
    receipt,
    outbox,
    work,
    {
      ...receipt,
      partitionNo: 0,
      principalKind: 'anonymous',
      principalId: '00000000-0000-0000-0000-000000000000',
      commandKindId: 1,
      keyVersion: 1,
    },
    { ...outbox, partitionNo: 4095, position: 1n, eventSeq: 0 },
    { ...work, workId: 'ab'.repeat(127) },
  ];
  for (const locator of locators) {
    const bytes = encodeLocator(locator);
    expect(bytes.byteLength).toBeLessThanOrEqual(256);
    expect(decodeLocator(locator.artifactType, bytes)).toEqual(locator);
    const padded = Buffer.concat([Buffer.from([255]), bytes, Buffer.from([255])]);
    expect(decodeLocator(locator.artifactType, padded.subarray(1, -1))).toEqual(locator);
    expect(encodeLocator(decodeLocator(locator.artifactType, bytes))).toEqual(bytes);
    for (const otherType of types.filter((type) => type !== locator.artifactType)) {
      expect(() => decodeLocator(otherType, bytes)).toThrow();
      expect(() => validateLocator(otherType, locator)).toThrow();
    }
  }
  expect(encodeLocator(locators.at(-1)!)).toHaveLength(256);
  expect(Buffer.from(encodeLocator(outbox)).toString('hex')).toBe('010200007fffffffffffffff03e7');
  expect(encodeLocator({ ...receipt, keyToken: 'cd'.repeat(32) })).not.toEqual(encodeLocator(receipt));
  expect(encodeLocator({ ...receipt, keyVersion: 1 })).not.toEqual(encodeLocator(receipt));
  expect(encodeLocator({ ...receipt, commandKindId: 1 })).not.toEqual(encodeLocator(receipt));
});

test('codec rejects oversized, corrupt, truncated, unknown and mismatched key payloads', () => {
  for (const locator of [receipt, outbox, work]) {
    const bytes = encodeLocator(locator);
    for (const bad of [new Uint8Array(), bytes.subarray(0, 1), bytes.subarray(0, -1), new Uint8Array(257)]) {
      expect(() => decodeLocator(locator.artifactType, bad)).toThrow();
    }
    for (const header of [0, 255]) {
      const bad = bytes.slice();
      bad[0] = header;
      expect(() => decodeLocator(locator.artifactType, bad)).toThrow();
      bad[0] = 1;
      bad[1] = header;
      expect(() => decodeLocator(locator.artifactType, bad)).toThrow();
    }
    for (const field of ['handle', 'text', 'authorization', 'idempotencyKey', 'response', 'data']) {
      expect(() => validateLocator(locator.artifactType, { ...locator, [field]: 'private' })).toThrow();
    }
  }
  const badReceipt = [
    { partitionNo: -1 },
    { partitionNo: 4096 },
    { principalKind: 'service' },
    { principalKind: 'anonymous' },
    { principalId: 'not-a-uuid' },
    { principalId: '00000000-0000-0000-0000-000000000000' },
    { commandKindId: 0 },
    { commandKindId: 2 ** 32 },
    { keyVersion: 0 },
    { keyVersion: 65536 },
    { keyToken: 'raw caller key' },
    { keyToken: 'a'.repeat(65) },
    { keyToken: 'AB'.repeat(32) },
  ];
  for (const patch of badReceipt)
    expect(() => validateLocator(receipt.artifactType, { ...receipt, ...patch })).toThrow();
  for (const patch of [
    { position: 0n },
    { position: 9223372036854775808n },
    { position: 1 },
    { eventSeq: -1 },
    { eventSeq: 1000 },
    { partitionNo: 0.5 },
  ]) {
    expect(() => validateLocator(outbox.artifactType, { ...outbox, ...patch })).toThrow();
  }
  for (const workId of [
    '',
    'alice',
    'Bearer secret',
    '0'.repeat(255),
    '0'.repeat(256),
    'ABCDEF'.repeat(8),
    'a'.repeat(33),
    `${id}\n`,
  ]) {
    expect(() => validateLocator(work.artifactType, { ...work, workId })).toThrow();
  }
  const badKind = encodeLocator(receipt);
  badKind[4] = 2;
  expect(() => decodeLocator(receipt.artifactType, badKind)).toThrow();
  const highByte = encodeLocator(work);
  highByte[2] = 0xb0;
  expect(() => decodeLocator(work.artifactType, highByte)).toThrow();
  expect(() => decodeLocator('unknown/v1' as HistoryArtifactType, encodeLocator(work))).toThrow();
});

test('scope accepts at most 64 distinct routed accounts with artifact-valid roles and no extra payload', () => {
  const accounts = Array.from({ length: 64 }, (_, i) => ({
    ...ref,
    accountId: `00000000-0000-8000-8000-002a${i.toString(16).padStart(8, '0')}`,
  }));
  for (const artifactType of types) {
    expect(validateScope(artifactType, { artifactType, accounts }).accounts).toHaveLength(64);
    expect(validateScope(artifactType, { artifactType, accounts: [] }).accounts).toHaveLength(0);
    for (const role of ACCOUNT_ROLES) {
      expect(
        validateScope(artifactType, { artifactType, accounts: [{ ...ref, roles: ACCOUNT_ROLE_BITS[role] }] }).accounts,
      ).toHaveLength(1);
    }
    const invalidScopes = [
      { artifactType, accounts: [...accounts, { ...ref, accountId: '00000000-0000-8000-8000-002a000000ff' }] },
      { artifactType, accounts: [ref, ref] },
      { artifactType, accounts: null },
      { artifactType, accounts: [null] },
      { artifactType, accounts: [], handle: 'private' },
      { artifactType: 'unknown/v1', accounts: [] },
      { artifactType: types.find((type) => type !== artifactType), accounts: [] },
      ...[
        { roles: 0 },
        { roles: 262144 },
        { accountRoute: 41 },
        { accountId: 'a handle' },
        { accountRoute: 65536 },
        { authorization: 'secret' },
      ].map((patch) => ({ artifactType, accounts: [{ ...ref, ...patch }] })),
    ];
    for (const scope of invalidScopes) expect(() => validateScope(artifactType, scope)).toThrow();
  }
});

test('every exact catalogue type has an explicit payload classification, including indirect account links', () => {
  const catalogue = Object.keys(EVENT_TYPES);
  expect(Object.keys(EVENT_CLASSIFICATIONS).sort()).toEqual(catalogue.sort());
  assertEventClassifications(catalogue);
  for (const type of catalogue) {
    const entry = classifyEvent(type);
    if (entry.kind === 'non-personal') expect(entry.roles).toEqual([]);
    else expect(encodeRoles(entry.roles)).toBeGreaterThan(0);
  }
  for (const type of ['com.rezics.future.created.v1', '__proto__', 'toString']) {
    expect(() => assertEventClassifications([...catalogue, type])).toThrow('Unclassified');
  }
  expect(classifyEvent('com.rezics.commerce.order.created.v1')).toEqual({
    kind: 'account-bearing',
    roles: ['buyer', 'creator'],
  });
  expect(classifyEvent('com.rezics.content.report-reporter.erased.v1').roles).toContain('reporter');
  expect(classifyEvent('com.rezics.access.operator.opening-authorized.v1').roles).toContain('acting-human');
  expect(classifyEvent('com.rezics.rating.vote.changed.v1').roles).toContain('voter');
  expect(classifyEvent('com.rezics.subject.created.v1').kind).toBe('non-personal');
});

test('registry and codecs have no database dependency anywhere in their runtime import graph', async () => {
  const visited = new Set<string>();
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  async function visit(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of scanner.scanImports(await Bun.file(file).text())) {
      if (dependency.path === 'node:crypto') continue;
      expect(dependency.path.startsWith('.')).toBe(true);
      expect(dependency.path.endsWith('.ts')).toBe(true);
      await visit(resolve(file, '..', dependency.path));
    }
  }
  await visit(resolve(import.meta.dir, '../../src/history/contracts.ts'));
  await visit(resolve(import.meta.dir, '../../src/history/locator.ts'));
  expect([...visited].map((file) => file.split('/src/')[1]).sort()).toEqual([
    'history/contracts.ts',
    'history/locator.ts',
    'route/route.ts',
  ]);
});
