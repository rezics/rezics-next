import { expect, spyOn, test } from 'bun:test';
import {
  AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16,
  createAutomatedAttempt,
  discardAutomatedReview,
  parseAutomatedAttempt,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
  type AutomatedAttempt,
} from '../src/automated-account-create';

const storageKey = 'rezics.automated-create.attempt';
const accountId = '11111111-1111-4111-8111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

function attempt(overrides: Partial<AutomatedAttempt> = {}): AutomatedAttempt {
  const operationKey = '\u0001'.repeat(128);
  const operator = {
    id: operatorId,
    kind: 'organization' as const,
    handle: `a${'-'.repeat(63)}`,
    displayName: '\u0001'.repeat(4096),
  };
  return {
    accountId,
    operationKey,
    operation: {
      kind: 'automated',
      registrationId: '',
      operationKey,
      operatorAccountId: operatorId,
      handle: `a${'x'.repeat(62)}z`,
    },
    operator,
    ...overrides,
  };
}

function installWindow(storage: ReturnType<typeof memoryStorage>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage: storage },
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}

test('closed writer and reader retain all optional marker combinations and the maximum escaped command at the exact boundary', () => {
  const storage = memoryStorage();
  const uninstall = installWindow(storage);
  try {
    for (const reference of [undefined, '\u0001'.repeat(4096)]) {
      for (const submitted of [undefined, true] as const) {
        storage.clear();
        const value = attempt({
          ...(reference === undefined ? {} : { reference }),
          ...(submitted ? { submitted } : {}),
        });
        expect(parseAutomatedAttempt(value)).not.toBeNull();
        expect(saveAutomatedAttempt(value)).toBe(true);
        const raw = storage.getItem(storageKey)!;
        expect(raw.length).toBeLessThanOrEqual(AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16);
        expect(restoreAutomatedAttempt()).toEqual(value);
      }
    }
    storage.clear();
    const maximum = attempt({ reference: '\u0001'.repeat(4096), submitted: true });
    expect(saveAutomatedAttempt(maximum)).toBe(true);
    expect(storage.getItem(storageKey)!.length).toBe(AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16);

    const withoutMarkers = attempt();
    expect(saveAutomatedAttempt(withoutMarkers)).toBe(true);
    expect(restoreAutomatedAttempt()).toMatchObject({
      operationKey: maximum.operationKey,
      reference: maximum.reference,
      submitted: true,
    });
  } finally {
    uninstall();
  }
});

test('excess raw storage is refused before JSON.parse and remains byte-for-byte untouched', () => {
  const storage = memoryStorage();
  const uninstall = installWindow(storage);
  const raw = `${' '.repeat(AUTOMATED_ATTEMPT_MAX_SERIALIZED_UTF16 + 1)}null`;
  storage.setItem(storageKey, raw);
  const randomUUID = spyOn(crypto, 'randomUUID');
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parseCalls++;
    return originalParse(...args);
  }) as typeof JSON.parse;
  try {
    expect(restoreAutomatedAttempt()).toBe('invalid');
    expect(parseCalls).toBe(0);
    expect(saveAutomatedAttempt(attempt())).toBe(false);
    expect(createAutomatedAttempt(accountId, attempt().operator, 'robot-one')).toBeNull();
    expect(randomUUID).not.toHaveBeenCalled();
    discardAutomatedReview(null);
    expect(storage.getItem(storageKey)).toBe(raw);
  } finally {
    JSON.parse = originalParse;
    randomUUID.mockRestore();
    uninstall();
  }
});

test('malformed, unknown, over-bound and unreadable descriptors stay invalid and cannot be overwritten', () => {
  const storage = memoryStorage();
  const uninstall = installWindow(storage);
  try {
    const valid = attempt();
    const invalidValues = [
      '{',
      JSON.stringify({ ...valid, extra: true }),
      JSON.stringify({ ...valid, operator: { ...valid.operator, displayName: 'x'.repeat(4097) } }),
      JSON.stringify({ ...valid, reference: 'x'.repeat(4097) }),
    ];
    for (const raw of invalidValues) {
      storage.setItem(storageKey, raw);
      expect(restoreAutomatedAttempt()).toBe('invalid');
      expect(saveAutomatedAttempt(valid)).toBe(false);
      expect(storage.getItem(storageKey)).toBe(raw);
    }

    const getItem = storage.getItem;
    Object.defineProperty(storage, 'getItem', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('storage read failed');
      },
    });
    expect(restoreAutomatedAttempt()).toBe('invalid');
    expect(saveAutomatedAttempt(valid)).toBe(false);
    Object.defineProperty(storage, 'getItem', { configurable: true, writable: true, value: getItem });
    storage.clear();
    Object.defineProperty(storage, 'setItem', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('storage write failed');
      },
    });
    expect(saveAutomatedAttempt(valid)).toBe(false);
  } finally {
    uninstall();
  }
});
