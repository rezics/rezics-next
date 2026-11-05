import { expect, mock, test } from 'bun:test';
import { withShelfAdvice, type PreferenceChange, type ReadingPreferences } from '../src/settings/preferences';

const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

function controlledDeadlines() {
  const setTimeoutBefore = globalThis.setTimeout;
  const clearTimeoutBefore = globalThis.clearTimeout;
  const scheduled: { callback: () => void; delay: number; canceled: boolean }[] = [];
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    if (typeof callback !== 'function') throw new Error('Unexpected string timer');
    const timer = { callback: callback as () => void, delay: Number(delay ?? 0), canceled: false };
    scheduled.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle) (handle as unknown as (typeof scheduled)[number]).canceled = true;
  }) as typeof clearTimeout;
  return {
    scheduled,
    fireNext() {
      const timer = scheduled.find((item) => !item.canceled);
      if (!timer) return false;
      timer.canceled = true;
      timer.callback();
      return true;
    },
    restore() {
      globalThis.setTimeout = setTimeoutBefore;
      globalThis.clearTimeout = clearTimeoutBefore;
    },
  };
}

async function flushMicrotasks() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

test('a type command keeps its payload and key through unknown readback; clean sibling changes survive recovery', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const { SettingsNavigationDrafts } = await import('../src/settings/reading-navigation');
  const book = 'schema:Book',
    movie = 'schema:Movie';
  let version = 1;
  let current = true;
  let saves = 0;
  const commands: Readonly<PreferenceChange>[] = [];
  const initial: ReadingPreferences = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version,
    shelf: { layouts: { all: 'list', [book]: 'grid', [movie]: 'table' }, gridSize: 'large' },
  });
  const receipt: ReadingPreferences = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version: 2,
    shelf: { ...initial.shelf, layouts: { all: 'list', [movie]: 'table' } },
  });
  let readback = initial;
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return ++saves === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
      },
      read: async () => ({ signedIn: true, preferences: readback, securityHref: null }),
    },
    {
      canRead: () => current,
      canWrite: () => current,
      version: () => version,
      onVersionChange: (next) => {
        version = next;
      },
    },
  );
  draft.edit({ layout: 'list' }, 'layout');
  expect(draft.needsNavigationDecision()).toBe(false);
  draft.editTypeLayout(book, undefined);
  await draft.submit();
  expect(draft.snapshot().phase).toBe('uncertain');
  draft.editTypeLayout(book, 'grid');
  expect(draft.needsNavigationDecision()).toBe(true); // The exact original removal stays protected.
  const navigation = new SettingsNavigationDrafts();
  const removeShelf = navigation.register({ kind: 'shelf', needsDecision: draft.needsNavigationDecision });
  expect([...navigation.kinds()]).toEqual(['shelf']);
  const leaving = navigation.block('/settings', '/library');
  expect(navigation.block('/settings', '/settings')).toBe(false); // Section hashes keep the retained panel mounted.
  const removeReading = navigation.register({ kind: 'reading', needsDecision: () => true });
  expect([...navigation.kinds()]).toEqual(['shelf', 'reading']);
  expect(navigation.block('/settings', '/inbox')).toBe(true);
  const retained = draft.snapshot();
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(draft.snapshot()).toBe(retained);
  const abandoned = navigation.block('/settings', '/library');
  navigation.leave();
  expect(await abandoned).toBe(false);
  expect(draft.snapshot()).toBe(retained);
  removeReading();
  removeShelf();
  await draft.reload();
  draft.editTypeLayout(book, 'grid');
  draft.editTypeLayout(movie, 'list');
  await draft.retry();
  expect(draft.snapshot().phase).toBe('review'); // The receipt confirms the write; a stale GET needs read recovery.
  expect(commands[1]).toBe(commands[0]);
  expect(commands[0]?.shelf).toEqual({ layouts: { [book]: null } });
  expect(draft.snapshot().pending).toBeNull();
  expect(draft.snapshot().confirmedWrite?.input).toBe(commands[0]);
  expect(draft.snapshot().writeReceipt?.version).toBe(2);
  expect(draft.snapshot().readResponse.reason).toBe('stale_version');
  expect(draft.canRetryOriginal()).toBe(false);
  await draft.retry();
  expect(commands).toHaveLength(2);
  readback = withShelfAdvice({
    spoilerLevel: 1,
    suitability: 'show',
    version: 3,
    shelf: { ...receipt.shelf, layouts: { ...receipt.shelf?.layouts, [book]: 'table' }, gridSize: 'small' },
  });
  await draft.reload();
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().comparison?.input).toBe(commands[0]);
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(Object.isFrozen(commands[0]?.shelf)).toBe(true);
  expect(draft.snapshot().pending).toBeNull();
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.snapshot().draft.layouts[movie]).toBe('list');
  expect(draft.snapshot().draft.layouts[book]).toBe('grid'); // A later local edit stays available for review.
  expect(version).toBe(3);
  expect(draft.canSubmit()).toBe(false);
  draft.useCurrent();
  expect(draft.snapshot().comparison).toBeNull();
  draft.editTypeLayout(movie, 'list');
  await draft.submit();
  expect(commands[2]?.shelf).toEqual({ layouts: { [movie]: 'list' } });
  expect(commands[2]?.idempotencyKey).not.toBe(commands[0]?.idempotencyKey);
  current = false;
  await draft.submit();
  expect(commands).toHaveLength(3);
});

test('a confirmed write keeps its receipt while a failed current read retries without replaying it', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const initial = withShelfAdvice({
      spoilerLevel: 0,
      suitability: 'blur',
      version: 8,
      shelf: { layouts: { all: 'list' } },
    });
    const receipt = withShelfAdvice({ ...initial, version: 9, shelf: { layouts: { all: 'table' } } });
    const commands: Readonly<PreferenceChange>[] = [];
    let version = 8;
    let reads = 0;
    const draft = new ShelfPreferenceDraftRecovery(
      initial,
      {
        save: async (input) => {
          commands.push(input);
          return commands.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
        },
        read: async () => {
          reads++;
          if (reads === 1) return { signedIn: true, preferences: initial, securityHref: null };
          if (reads === 2)
            return {
              signedIn: true,
              state: 'unavailable',
              failure: { status: 503, code: 'dependency_unavailable', requestId: 'refresh-1', retryAfter: '20' },
              securityHref: null,
            };
          return { signedIn: true, preferences: receipt, securityHref: null };
        },
      },
      {
        canRead: () => true,
        canWrite: () => true,
        version: () => version,
        onVersionChange: (next) => {
          version = next;
        },
      },
    );
    draft.edit({ layout: 'table' }, 'layout');
    await draft.submit();
    const original = draft.snapshot().pending?.input;
    await draft.reload();
    await draft.retry();

    const readDeadline = now + 20_000;
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(original);
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.snapshot().writeReceipt?.version).toBe(9);
    expect(draft.snapshot().known.shelf.layouts?.all).toBe('table');
    expect(draft.snapshot().current).toBe(false);
    expect(draft.snapshot().writeResponse.retryAt).toBe(0);
    expect(draft.snapshot().readResponse.failure?.requestId).toBe('refresh-1');
    expect(draft.snapshot().readResponse.retryAt).toBe(readDeadline);
    expect(draft.canRetryOriginal()).toBe(false);

    await draft.retry();
    await draft.reload();
    expect(commands).toHaveLength(2);
    expect(reads).toBe(2);
    now = readDeadline;
    await draft.reload();
    expect(reads).toBe(3);
    expect(draft.snapshot().readResponse.retryAt).toBe(0);
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.snapshot().comparison?.input).toBe(original);
    expect(draft.snapshot().current).toBe(true);
    expect(commands).toHaveLength(2);
    draft.useCurrent();
    expect(draft.snapshot().comparison).toBeNull();
    expect(draft.snapshot().confirmedWrite).toBeNull();
    expect(commands).toHaveLength(2);
  } finally {
    Date.now = realNow;
  }
});

test('a pending reset is retained for navigation and a retired owner cannot accept its late completion', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const { SettingsNavigationDrafts } = await import('../src/settings/reading-navigation');
  let current = true;
  let episode = 'A1';
  let finish = () => {};
  let saves = 0;
  const initial = withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version: 4, shelf: { gridSize: 'large' } });
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      read: async () => ({ signedIn: false }),
      save: async () => {
        saves++;
        await new Promise<void>((resolve) => (finish = resolve));
        return { ok: true as const, preferences: withShelfAdvice({ ...initial, version: 5, shelf: {} }) };
      },
    },
    {
      isCurrent: () => episode === 'A1',
      canRead: () => current,
      canWrite: () => current,
      version: () => 4,
      onVersionChange() {},
    },
  );
  const navigation = new SettingsNavigationDrafts();
  navigation.register({ kind: 'shelf', needsDecision: () => current && draft.needsNavigationDecision() });
  const saving = draft.submit(true);
  const capturedRetry = draft.retry.bind(draft);
  expect(draft.snapshot().pending?.input.shelf).toBeNull();
  expect(navigation.needsDecision()).toBe(true);
  const retained = draft.snapshot();
  current = false;
  episode = 'B';
  episode = 'A2';
  navigation.refresh();
  draft.dispose();
  finish();
  await saving;
  await capturedRetry();
  expect(draft.snapshot()).toBe(retained);
  expect(saves).toBe(1);
  expect(navigation.needsDecision()).toBe(false);
});

test('the native merged map bound includes preserved scopes, while removing one scope releases capacity', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const layouts = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`schema:Type${index}`, 'grid' as const]),
  );
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version: 0, shelf: { layouts } }),
    {
      read: async () => ({ signedIn: false }),
      save: async (input) => {
        commands.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    { canRead: () => true, canWrite: () => true, version: () => 0, onVersionChange() {} },
  );
  draft.editTypeLayout('schema:Extra', 'table');
  await draft.submit();
  expect(commands).toHaveLength(0);
  draft.editTypeLayout('schema:Type0', undefined);
  await draft.submit();
  expect(commands[0]?.shelf).toEqual({ layouts: { 'schema:Extra': 'table', 'schema:Type0': null } });
});

test('a confirmed receipt plus failed GET then newer current keeps a later edit on keep', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  let version = 1;
  let reads = 0;
  const initial = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' }, gridSize: 'large' },
  });
  const receipt = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 2,
    shelf: { layouts: { all: 'table' }, gridSize: 'large' },
  });
  const newer = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 3,
    shelf: { layouts: { all: 'grid' }, gridSize: 'medium' },
  });
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return commands.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
      },
      read: async () => {
        reads++;
        if (reads === 2)
          return {
            signedIn: true,
            state: 'unavailable',
            failure: { status: 503, code: 'dependency_unavailable', requestId: 'refresh-keep' },
            securityHref: null,
          };
        return { signedIn: true, preferences: reads >= 3 ? newer : initial, securityHref: null };
      },
    },
    {
      canRead: () => true,
      canWrite: () => true,
      version: () => version,
      onVersionChange: (next) => {
        version = next;
      },
    },
  );
  draft.edit({ layout: 'table' }, 'layout');
  await draft.submit();
  const original = draft.snapshot().pending?.input;
  draft.edit({ gridSize: 'small' }, 'gridSize');
  await draft.reload();
  await draft.retry();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(original);
  expect(draft.snapshot().pending).toBeNull();
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().confirmedWrite?.input).toBe(original);
  expect(draft.snapshot().comparison?.input).toBe(original);
  expect(draft.snapshot().current).toBe(false);
  expect(draft.snapshot().dirty.has('layout')).toBe(false);
  expect(draft.snapshot().dirty.has('gridSize')).toBe(true);
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(Object.isFrozen(original)).toBe(true);

  expect(reads).toBe(2);
  await draft.reload();
  expect(reads).toBe(3);
  expect(draft.snapshot().known.version).toBe(3);
  expect(draft.snapshot().current).toBe(true);
  expect(draft.snapshot().draft.layout).toBe('grid');
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.snapshot().confirmedWrite?.input).toBe(original);
  expect(draft.canSubmit()).toBe(false);
  draft.keepLocal();
  expect(commands).toHaveLength(2);
  expect(draft.snapshot().confirmedWrite).toBeNull();
  expect(draft.snapshot().comparison).toBeNull();
  expect(draft.snapshot().phase).toBe('idle');
  expect(draft.snapshot().draft.layout).toBe('grid');
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.canSubmit()).toBe(true);
  await draft.submit();
  expect(commands[2]?.expectedVersion).toBe(3);
  expect(commands[2]?.shelf).toEqual({ gridSize: 'small' });
  expect(commands[2]?.idempotencyKey).not.toBe(original?.idempotencyKey);
});

test('a retried receipt survives a stalled GET and a later current read defeats its late result', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const timers = controlledDeadlines();
  let version = 1;
  let saves = 0;
  let reads = 0;
  let finishLateRead!: (page: { signedIn: true; preferences: ReadingPreferences; securityHref: null }) => void;
  const initial = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' }, gridSize: 'large' },
  });
  const receipt = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 2,
    shelf: { layouts: { all: 'table' }, gridSize: 'large' },
  });
  const later = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 3,
    shelf: { layouts: { all: 'grid' }, gridSize: 'medium' },
  });
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      save: async (input) => {
        commands.push(input);
        return ++saves === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
      },
      read: async () => {
        reads++;
        if (reads === 1) return { signedIn: true, preferences: initial, securityHref: null };
        if (reads === 2)
          return await new Promise<{ signedIn: true; preferences: ReadingPreferences; securityHref: null }>(
            (resolve) => {
              finishLateRead = resolve;
            },
          );
        return { signedIn: true, preferences: later, securityHref: null };
      },
    },
    {
      canRead: () => true,
      canWrite: () => true,
      version: () => version,
      onVersionChange: (next) => {
        version = next;
      },
    },
  );

  try {
    draft.edit({ layout: 'table' }, 'layout');
    await draft.submit();
    const original = draft.snapshot().pending?.input;
    expect(original).toMatchObject({ expectedVersion: 1, shelf: { layouts: { all: 'table' } } });
    await draft.reload();
    expect(draft.canRetryOriginal()).toBe(true);

    const beforeRetry = timers.scheduled.length;
    let retrySettled = false;
    const retrying = draft.retry().then(() => {
      retrySettled = true;
    });
    await flushMicrotasks();
    expect(timers.scheduled.length - beforeRetry).toBe(2);
    expect(reads).toBe(2);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(original);
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.snapshot().writeReceipt).toEqual({ shelf: receipt.shelf, version: 2 });
    expect(draft.snapshot().current).toBe(false);
    expect(draft.snapshot().readBusy).toBe(true);
    expect(draft.canSubmit()).toBe(false);

    expect(timers.fireNext()).toBe(true);
    await flushMicrotasks();
    expect(retrySettled).toBe(true);
    await retrying;
    expect(draft.snapshot().readBusy).toBe(false);
    expect(draft.snapshot().readResponse.failure).toEqual({ status: null, code: 'local_timeout' });
    expect(draft.snapshot().readResponse.retryAt).toBe(0);
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().current).toBe(false);
    expect(draft.canSubmit()).toBe(false);

    await draft.reload();
    expect(reads).toBe(3);
    expect(draft.snapshot().known).toEqual({ shelf: later.shelf, version: 3 });
    expect(draft.snapshot().draft.layout).toBe('grid');
    expect(draft.snapshot().draft.gridSize).toBe('medium');
    expect(draft.snapshot().current).toBe(true);
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.canSubmit()).toBe(false);

    finishLateRead({ signedIn: true, preferences: receipt, securityHref: null });
    await flushMicrotasks();
    expect(reads).toBe(3);
    expect(draft.snapshot().known).toEqual({ shelf: later.shelf, version: 3 });
    expect(draft.snapshot().draft.layout).toBe('grid');
    expect(draft.snapshot().confirmedWrite?.input).toBe(original);
    expect(draft.snapshot().phase).toBe('review');

    const commandCount = commands.length;
    draft.keepLocal();
    expect(commands).toHaveLength(commandCount);
    expect(draft.snapshot().confirmedWrite).toBeNull();
    expect(draft.snapshot().draft.layout).toBe('grid');
    expect(draft.snapshot().draft.gridSize).toBe('medium');
  } finally {
    timers.restore();
  }
});

test('grid-only advice rejects a new table while stored tables stay inspectable and removable', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const book = 'schema:Book';
  const movie = 'schema:Movie';
  const initial = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list', [book]: 'table', [movie]: 'table' }, gridSize: 'medium' },
  });
  const advice = initial.advice!;
  let current: ReadingPreferences = {
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
    current,
    {
      read: async () => ({ signedIn: true, preferences: current, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        current = {
          ...current,
          version: 2,
          shelf: { layouts: { all: 'list', [movie]: 'table' }, gridSize: 'small' },
        };
        return { ok: true, preferences: current };
      },
    },
    { canRead: () => true, canWrite: () => true, version: () => 1, onVersionChange() {} },
  );
  draft.editTypeLayout('schema:New', 'table');
  expect(draft.snapshot().dirty.has('layout:schema:New')).toBe(false);
  draft.editTypeLayout(book, undefined);
  draft.edit({ gridSize: 'small' }, 'gridSize');
  expect(draft.snapshot().draft.layouts[book]).toBeUndefined();
  expect(draft.snapshot().draft.layouts[movie]).toBe('table');
  await draft.submit();
  expect(commands[0]?.shelf).toEqual({ layouts: { [book]: null }, gridSize: 'small' });
  expect(draft.snapshot().draft.layouts[movie]).toBe('table');
});
