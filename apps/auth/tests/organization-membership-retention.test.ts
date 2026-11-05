import { expect, test } from 'bun:test';
import {
  clearMembershipCommandIfMatches,
  readMembershipCommand,
  saveMembershipCommand,
  type MembershipCommand,
} from '../src/organization-membership';

const storageKey = 'rezics.organization-membership.command';
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function command(unresolved: boolean): MembershipCommand {
  const escaped = '\u0000'.repeat(4096);
  return {
    accountId: uuid(1),
    operationKey: 'a'.repeat(32),
    operation: {
      kind: 'membership',
      organizationId: uuid(2),
      memberAccountId: uuid(3),
      role: 'member',
      reservationId: escaped,
    },
    reference: escaped,
    unresolved,
  };
}

test('retained membership commands round-trip within the JSON UTF-16 ceiling and rejected text stays untouched', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalParse = Object.getOwnPropertyDescriptor(JSON, 'parse');
  const values = new Map<string, string>();
  let writes = 0;
  let removals = 0;
  let parses = 0;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++;
      values.set(key, value);
    },
    removeItem: (key: string) => {
      removals++;
      values.delete(key);
    },
  } as unknown as Storage;
  const installWindow = (sessionStorage: Storage) =>
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage } });
  const maximum = command(false);
  const unresolved = command(true);
  const mismatch = { ...unresolved, operationKey: 'b'.repeat(32) };

  installWindow(storage);
  Object.defineProperty(JSON, 'parse', {
    configurable: true,
    writable: true,
    value: (raw: string) => {
      parses++;
      return originalParse!.value(raw);
    },
  });
  try {
    expect(saveMembershipCommand(maximum)).toBe(true);
    const maximumRaw = values.get(storageKey)!;
    expect(maximumRaw.length).toBe(49470);
    expect(readMembershipCommand()).toEqual(maximum);

    const { reservationId: _reservationId, ...withoutReservation } = maximum.operation;
    const { reference: _reference, ...withoutReference } = maximum;
    for (const variant of [
      maximum,
      { ...maximum, operation: withoutReservation },
      { ...withoutReference, operation: maximum.operation },
      { ...withoutReference, operation: withoutReservation },
    ]) {
      expect(saveMembershipCommand(variant)).toBe(true);
      expect(JSON.stringify(readMembershipCommand())).toBe(JSON.stringify(variant));
    }

    expect(saveMembershipCommand(unresolved)).toBe(true);
    const exactRaw = values.get(storageKey)!;
    expect(readMembershipCommand()).toEqual(unresolved);
    expect(clearMembershipCommandIfMatches(mismatch)).toBe(false);
    expect(values.get(storageKey)).toBe(exactRaw);

    const invalid = [
      `${maximumRaw} `,
      JSON.stringify({
        ...unresolved,
        operation: { ...unresolved.operation, reservationId: 'reservation' },
        reference: 'reference',
        extra: true,
      }),
      '{',
    ];
    const beforeWrites = writes;
    const beforeRemovals = removals;
    for (const raw of invalid) {
      values.set(storageKey, raw);
      const beforeParses = parses;
      expect(readMembershipCommand()).toBe('invalid');
      expect(parses).toBe(beforeParses + (raw.length > 49470 ? 0 : 1));
      expect(clearMembershipCommandIfMatches(mismatch)).toBe(false);
      expect(values.get(storageKey)).toBe(raw);
    }
    expect(writes).toBe(beforeWrites);
    expect(removals).toBe(beforeRemovals);

    values.set(storageKey, exactRaw);
    installWindow({
      ...storage,
      setItem: () => {
        throw new Error('storage quota');
      },
    } as Storage);
    expect(saveMembershipCommand(unresolved)).toBe(false);
    expect(values.get(storageKey)).toBe(exactRaw);

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get sessionStorage(): Storage { throw new Error('storage unavailable'); } },
    });
    expect(readMembershipCommand()).toBe('invalid');
    expect(clearMembershipCommandIfMatches(mismatch)).toBe(false);
    expect(values.get(storageKey)).toBe(exactRaw);
  } finally {
    if (originalParse) Object.defineProperty(JSON, 'parse', originalParse);
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
