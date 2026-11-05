import { expect, mock, test } from 'bun:test';
import { withShelfAdvice, type PreferenceChange, type ReadingPreferences } from '../src/settings/preferences';
import { controlledDeadlines } from './fixtures/shelf-deadline';

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

test('a stalled reset becomes uncertain and its late receipt cannot settle the original', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const timers = controlledDeadlines();
  const initial = withShelfAdvice({ spoilerLevel: 0, suitability: 'blur', version: 1,
    shelf: { layouts: { all: 'list' }, gridSize: 'large' } });
  const receipt = withShelfAdvice({ ...initial, version: 2, shelf: {} });
  let finish!: (result: { ok: true; preferences: ReadingPreferences }) => void, reads = 0;
  let original!: Readonly<PreferenceChange>;
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      read: async () => (reads++, { signedIn: true, preferences: receipt, securityHref: null }),
      save: (input) => ((original = input), new Promise((resolve) => (finish = resolve))),
    },
    owner,
  );
  try {
    let settled = false;
    const sending = draft.submit(true).then(() => (settled = true));
    expect(timers.delays()).toEqual([10_000]);
    expect(original).toMatchObject({ expectedVersion: 1, shelf: null, idempotencyKey: expect.any(String) });
    timers.fireNext(); await timers.flush(); expect(settled).toBe(true); await sending;
    finish({ ok: true, preferences: receipt }); await timers.flush(); expect(reads).toBe(0);
    expect(draft.snapshot()).toMatchObject({ phase: 'uncertain', current: false, writeBusy: false,
      pending: { input: original }, known: { shelf: initial.shelf, version: 1 }, confirmedWrite: null,
      writeReceipt: null, writeResponse: { failure: { status: null, code: 'local_timeout' }, retryAt: 0 } });
  } finally {
    timers.restore();
  }
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

test('dirty review keep then Save uses the current version and only intended operands', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  let version = 1;
  const initial = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' }, gridSize: 'large' },
  });
  const current = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 4,
    shelf: { layouts: { all: 'grid' }, gridSize: 'small' },
  });
  const commands: Readonly<PreferenceChange>[] = [];
  const draft = new ShelfPreferenceDraftRecovery(
    initial,
    {
      read: async () => ({ signedIn: true, preferences: current, securityHref: null }),
      save: async (input) => {
        commands.push(input);
        return {
          ok: true,
          preferences: withShelfAdvice({
            ...current,
            version: input.expectedVersion + 1,
            shelf: { ...current.shelf, layouts: { all: 'table' } },
          }),
        };
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
  await draft.reload();
  expect(draft.snapshot().phase).toBe('review');
  expect(draft.snapshot().known.version).toBe(4);
  expect(draft.snapshot().draft.layout).toBe('table');
  expect(draft.snapshot().draft.gridSize).toBe('small');
  expect(draft.canSubmit()).toBe(false);
  draft.keepLocal();
  expect(commands).toHaveLength(0);
  expect(draft.snapshot().phase).toBe('idle');
  expect(draft.snapshot().comparison).toBeNull();
  expect(draft.snapshot().confirmedWrite).toBeNull();
  expect(draft.canSubmit()).toBe(true);
  await draft.submit();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.expectedVersion).toBe(4);
  expect(commands[0]?.shelf).toEqual({ layouts: { all: 'table' } });
  expect(commands[0]?.idempotencyKey).toEqual(expect.any(String));
});

test('keep cannot dispatch an unresolved original or an unsupported whole patch', async () => {
  const { ShelfPreferenceDraftRecovery } = await import('../src/settings/shelf-preferences');
  const readable = withShelfAdvice({
    spoilerLevel: 0,
    suitability: 'blur',
    version: 1,
    shelf: { layouts: { all: 'list' } },
  });
  const commands: Readonly<PreferenceChange>[] = [];
  const pending = new ShelfPreferenceDraftRecovery(
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
  pending.edit({ layout: 'table' }, 'layout');
  await pending.submit();
  const original = pending.snapshot().pending?.input;
  expect(original).toBeDefined();
  pending.keepLocal();
  expect(pending.snapshot().pending?.input).toBe(original);
  expect(pending.snapshot().phase).toBe('uncertain');
  expect(pending.snapshot().pending?.input.expectedVersion).toBe(1);
  expect(pending.snapshot().pending?.input.shelf).toEqual({ layouts: { all: 'table' } });
  await pending.submit();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toBe(original);

  const advice = readable.advice!;
  const restricted: ReadingPreferences = {
    ...readable,
    advice: {
      ...advice,
      shelfAdvice: {
        ...advice.shelfAdvice!,
        supported: { ...advice.shelfAdvice!.supported, layouts: ['grid'] },
      },
    },
  };
  const blocked: Readonly<PreferenceChange>[] = [];
  const unsupported = new ShelfPreferenceDraftRecovery(
    readable,
    {
      read: async () => ({ signedIn: true, preferences: restricted, securityHref: null }),
      save: async (input) => {
        blocked.push(input);
        return { ok: false, reason: 'unavailable' };
      },
    },
    owner,
  );
  unsupported.editTypeLayout('schema:Book', 'table');
  await unsupported.reload();
  expect(unsupported.snapshot().phase).toBe('review');
  expect(unsupported.snapshot().draft.layouts['schema:Book']).toBe('table');
  unsupported.keepLocal();
  expect(unsupported.snapshot().phase).toBe('idle');
  expect(unsupported.snapshot().draft.layouts['schema:Book']).toBe('table');
  expect(unsupported.canSubmit()).toBe(true);
  await unsupported.submit();
  expect(blocked).toHaveLength(0);
  expect(unsupported.snapshot().phase).toBe('failed');
});
