import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { roleCommand } from '../src/modules/realm-admin/contract.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const command = (targetScope?: unknown) => ({
  actingSubject: id(), expectedGeneration: '0', reason: 'Manage placements in this Concept',
  change: { kind: 'role', roleId: randomUUID(), name: 'Concept placement managers',
    permissions: ['publication.adopt'], ...(targetScope === undefined ? {} : { targetScope }) },
});

test('Realm roles accept an exact Concept jurisdiction alongside existing Realm actions', () => {
  expect(Value.Check(roleCommand, command())).toBe(true);
  expect(Value.Check(roleCommand, command({ kind: 'concept', id: id() }))).toBe(true);
});

test('Realm role jurisdiction refuses wildcard, malformed and other target kinds', () => {
  for (const targetScope of [
    { kind: 'concept', id: '*' }, { kind: 'concept', id: 'news' },
    { kind: 'realm', id: id() }, { kind: 'concept', id: id(), broader: true }, null,
  ]) expect(Value.Check(roleCommand, command(targetScope))).toBe(false);
});
