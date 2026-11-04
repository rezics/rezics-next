import { expect, mock, test } from 'bun:test';
import { withShelfAdvice, type PreferenceChange, type ReadingPreferences } from '../src/settings/preferences';

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const owner = { canRead: () => true, canWrite: () => true, version: () => 1, onVersionChange() {} };

test('missing or denied shelf advice cannot edit, while an original uncertain command stays put', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const { ownerMayChangeShelf } = await import('../src/settings/preferences');
  const commands: Readonly<PreferenceChange>[] = [];
  const readable: ReadingPreferences = {
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' }, gridSize: 'large' },
  };
  const missing = new ShelfPreferenceDraftRecovery(
    readable,
    {
      read: async () => ({ signedIn: true, preferences: readable, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    owner,
  );
  missing.edit({ layout: 'table' }, 'layout');
  await missing.submit();
  expect(commands).toHaveLength(0);
  expect(ownerMayChangeShelf(readable.advice)).toBe(false);

  const denied = withShelfAdvice(readable, false);
  const locked = new ShelfPreferenceDraftRecovery(
    denied,
    {
      read: async () => ({ signedIn: true, preferences: denied, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        return { ok: true, preferences: denied };
      },
    },
    owner,
  );
  locked.edit({ layout: 'grid' }, 'layout');
  await locked.submit(true);
  expect(commands).toHaveLength(0);
  expect(ownerMayChangeShelf(denied.advice)).toBe(false);

  const writable = withShelfAdvice(readable);
  let advice: ReadingPreferences = writable;
  const pending = new ShelfPreferenceDraftRecovery(
    writable,
    {
      read: async () => ({ signedIn: true, preferences: advice, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    owner,
  );
  pending.edit({ layout: 'table' }, 'layout');
  await pending.submit();
  expect(pending.snapshot().phase).toBe('uncertain');
  const original = commands[0];
  advice = readable;
  await pending.reload();
  expect(pending.snapshot().pending?.input).toBe(original);
  expect(pending.snapshot().phase).toBe('uncertain');
  await pending.retry();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBe(original);
});

test('changed native advice fences a captured type callback and its dispatch', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const initial = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' } },
  });
  const advice = initial.advice!;
  const restricted: ReadingPreferences = {
    ...initial,
    advice: {
      ...advice,
      shelfAdvice: {
        ...advice.shelfAdvice!,
        supported: { ...advice.shelfAdvice!.supported, layouts: ['grid'] },
      },
    },
  };
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      read: async () => ({ signedIn: true, preferences: restricted, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    owner,
  );
  const captured = draft.editTypeLayout.bind(draft);
  captured('schema:Book', 'table');
  await draft.reload();
  captured('schema:Movie', 'table');
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().draft.layouts['schema:Movie']).toBeUndefined();
  expect(draft.snapshot().draft.layouts['schema:Book']).toBe('table');
  await draft.submit();
  expect(commands).toHaveLength(0);
});

test('structured refusals retain the original intent and one absolute retry deadline', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const initial = withShelfAdvice({
      spoilerLevel: 0,
      suitability: 'blur',
      version: 1,
      shelf: { layouts: { all: 'list' } },
    });
    const current = withShelfAdvice({
      spoilerLevel: 0,
      suitability: 'blur',
      version: 4,
      shelf: { layouts: { all: 'list' } },
    });
    const commands: Readonly<PreferenceChange>[] = [];
    let reads = 0;
    let saves = 0;
    let readState: 'closed' | 'unavailable' | 'forbidden' | 'current' = 'closed';
    const draft = new ShelfPreferenceDraftRecovery(
      initial,
      {
        save: async (input) => {
          commands.push(input);
          return ++saves === 1
            ? {
                ok: false,
                reason: 'unavailable',
                failure: { status: 503, code: 'dependency_unavailable', requestId: 'write-1', retryAfter: '30' },
              }
            : { ok: false, reason: 'unavailable' };
        },
        read: async () => {
          reads++;
          if (readState === 'closed')
            return {
              signedIn: true,
              state: 'closed',
              failure: { status: 503, code: 'platform_closed', requestId: 'read-closed' },
              securityHref: null,
            };
          if (readState === 'unavailable')
            return {
              signedIn: true,
              state: 'unavailable',
              failure: { status: 503, code: 'dependency_unavailable', requestId: 'read-unavailable', retryAfter: '60' },
              securityHref: null,
            };
          if (readState === 'forbidden')
            return {
              signedIn: true,
              state: 'unavailable',
              failure: { status: 403, code: 'not_authorized', requestId: 'read-forbidden' },
              securityHref: null,
            };
          return { signedIn: true, preferences: current, securityHref: null };
        },
      },
      owner,
    );
    draft.edit({ layout: 'table' }, 'layout');
    await draft.submit();
    const original = draft.snapshot().pending?.input;
    const deadline = now + 30_000;
    expect(draft.snapshot().writeResponse.retryAt).toBe(deadline);
    draft.edit({ gridSize: 'small' }, 'gridSize');
    expect(draft.snapshot().writeResponse.retryAt).toBe(deadline);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original?.shelf)).toBe(true);
    await draft.retry();
    expect(commands).toHaveLength(1);
    expect(draft.snapshot().pending?.input).toBe(original);
    now = deadline;
    readState = 'current';
    await draft.reload();
    expect(draft.snapshot().known.version).toBe(4);
    await draft.retry();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(original);
    expect(draft.snapshot().writeResponse.retryAt).toBe(0);

    readState = 'closed';
    await draft.reload();
    expect(draft.snapshot().readResponse.reason).toBe('read:closed');
    expect(draft.snapshot().readResponse.failure?.code).toBe('platform_closed');
    expect(draft.snapshot().pending?.input).toBe(original);
    expect(draft.snapshot().advice).toBeUndefined();
    expect(draft.snapshot().current).toBe(false);

    readState = 'unavailable';
    await draft.reload();
    const readDeadline = now + 60_000;
    expect(draft.snapshot().readResponse.reason).toBe('read:unavailable');
    expect(draft.snapshot().readResponse.failure?.requestId).toBe('read-unavailable');
    expect(draft.snapshot().readResponse.retryAt).toBe(readDeadline);
    await draft.reload();
    expect(reads).toBe(3);
    now = readDeadline;
    readState = 'forbidden';
    await draft.reload();
    expect(draft.snapshot().readResponse.reason).toBe('read:forbidden');
    expect(draft.snapshot().readResponse.failure?.status).toBe(403);
    expect(draft.snapshot().pending?.input).toBe(original);
    expect(draft.snapshot().dirty.has('gridSize')).toBe(true);

    readState = 'current';
    await draft.reload();
    expect(draft.snapshot().known.version).toBe(4);
    expect(draft.snapshot().current).toBe(true);
    expect(draft.snapshot().draft.gridSize).toBe('small');
    expect(draft.snapshot().pending?.input).toBe(original);
  } finally {
    Date.now = realNow;
  }
});

test('a fresh Shelf read can run during the original command wait without changing it', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const initial = withShelfAdvice({
      spoilerLevel: 0,
      suitability: 'blur',
      version: 1,
      shelf: { layouts: { all: 'list' } },
    });
    const current = withShelfAdvice({ ...initial, version: 2, shelf: { gridSize: 'small' } });
    const denied = withShelfAdvice({ ...current, version: 3 }, false);
    const commands: Readonly<PreferenceChange>[] = [];
    let reads = 0;
    let readMode: 'unavailable' | 'current' | 'denied' = 'unavailable';
    const draft = new ShelfPreferenceDraftRecovery(
      initial,
      {
        save: async (input) => {
          commands.push(input);
          return {
            ok: false,
            reason: 'unavailable',
            failure: { status: 503, code: 'dependency_unavailable', requestId: 'write-wait', retryAfter: '30' },
          };
        },
        read: async () => {
          reads++;
          if (readMode === 'unavailable')
            return {
              signedIn: true,
              state: 'unavailable',
              failure: { status: 503, code: 'dependency_unavailable', requestId: 'read-wait', retryAfter: '10' },
              securityHref: null,
            };
          return { signedIn: true, preferences: readMode === 'denied' ? denied : current, securityHref: null };
        },
      },
      owner,
    );
    draft.edit({ layout: 'table' }, 'layout');
    await draft.submit();
    const original = draft.snapshot().pending?.input;
    const writeDeadline = now + 30_000;
    expect(draft.snapshot().writeResponse.retryAt).toBe(writeDeadline);
    expect(draft.snapshot().writeResponse.reason).toBe('write:unavailable');
    expect(draft.snapshot().writeResponse.failure?.requestId).toBe('write-wait');

    await draft.reload();

    expect(reads).toBe(1);
    const readDeadline = now + 10_000;
    expect(draft.snapshot().writeResponse.retryAt).toBe(writeDeadline);
    expect(draft.snapshot().readResponse.retryAt).toBe(readDeadline);
    expect(draft.snapshot().writeResponse.failure?.requestId).toBe('write-wait');
    expect(draft.snapshot().pending?.input).toBe(original);
    await draft.reload();
    expect(reads).toBe(1);

    now = readDeadline;
    readMode = 'current';
    await draft.reload();
    expect(reads).toBe(2);
    expect(draft.snapshot().readResponse.retryAt).toBe(0);
    expect(draft.snapshot().writeResponse.retryAt).toBe(writeDeadline);
    expect(draft.snapshot().writeResponse.failure?.requestId).toBe('write-wait');
    expect(draft.snapshot().known.version).toBe(current.version);
    expect(draft.snapshot().current).toBe(true);
    expect(draft.snapshot().pending?.input).toBe(original);

    now = writeDeadline;
    readMode = 'denied';
    await draft.reload();
    expect(reads).toBe(3);
    expect(draft.snapshot().advice?.allowedActions.update.allowed).toBe(false);
    await draft.retry();
    expect(commands).toHaveLength(1);
    expect(draft.snapshot().pending?.input).toBe(original);
  } finally {
    Date.now = realNow;
  }
});
