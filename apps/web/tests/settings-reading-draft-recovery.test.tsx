import { expect, mock, test } from 'bun:test';
import { readingFixture } from '../src/kernel/fake/settings-preferences-reading';
import { readingNeedsNavigationDecision } from '../src/settings/reading-navigation';
import type { ReadingIO } from '../src/settings/reading-preferences';
import { managedReadTimeout } from '../src/settings/managed-read-deadline';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ReadingDraftRecovery } = await import('../src/settings/reading-card');
const owner = () => ({
  canRead: () => true,
  canWrite: () => true,
  version: () => 0,
  onVersionChange: () => {},
});
const flushPromiseJobs = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

test('rejected choices survive failed and successful reads until explicit save or discard', async () => {
  for (const scenario of ['conflict', 'denied', 'closed'] as const) {
    const fixture = readingFixture(scenario);
    let readFails = true;
    const editor = new ReadingDraftRecovery(
      fixture.initial,
      {
        ...fixture.io,
        read: async () => {
          if (readFails) throw new Error('Read unavailable');
          return {
            signedIn: true,
            preferences: fixture.current(),
            securityHref: null,
          };
        },
      },
      owner(),
    );
    await editor.edit({ spoilerLevel: 1 });
    await editor.edit({ suitability: 'show' });
    const draft = editor.snapshot().draft;
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'failed',
      failureOrigin: 'read',
      knownCurrent: false,
    });
    expect(editor.snapshot().draft).toBe(draft);
    readFails = false;
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      known: fixture.current(),
      pending: null,
      draft:
        scenario === 'conflict' ? { spoilerLevel: 1, suitability: 'show' } : { spoilerLevel: 1, suitability: 'blur' },
    });
    expect(readingNeedsNavigationDecision(editor.snapshot())).toBe(true);
    expect(fixture.calls).toHaveLength(1);
    if (scenario === 'conflict') {
      await editor.submit();
      expect(fixture.calls[1]).toMatchObject({
        expectedVersion: 1,
        spoilerLevel: 1,
      });
      expect(fixture.calls[1]).not.toHaveProperty('suitability');
      expect(fixture.calls[1]!.idempotencyKey).not.toBe(fixture.calls[0]!.idempotencyKey);
      expect(editor.snapshot().phase).toBe('saved');
      expect(fixture.current().notifications).toMatchObject({
        reply: false,
        mention: true,
      });
    } else {
      editor.useCurrent();
      expect(editor.snapshot().draft).toBe(editor.snapshot().known);
      expect(editor.snapshot().draft).toMatchObject(fixture.initial);
      expect(fixture.calls).toHaveLength(1);
    }
    expect(readingNeedsNavigationDecision(editor.snapshot())).toBe(false);
  }
});

test('a narrowed current choice keeps the old draft local until every changed value is admitted', async () => {
  const fixture = readingFixture();
  let narrowed = false;
  let readFails = true;
  const io: ReadingIO = {
    ...fixture.io,
    read: async () => {
      if (readFails) throw new Error('Read unavailable');
      const page = await fixture.io.read();
      if (!narrowed || !('preferences' in page)) return page;
      const advice = page.preferences.advice!;
      return {
        ...page,
        preferences: {
          ...page.preferences,
          advice: {
            ...advice,
            reading: {
              ...advice.reading,
              supported: { spoilerLevels: [0, 1], suitability: ['blur', 'show'] },
            },
          },
        },
      };
    },
  };
  const editor = new ReadingDraftRecovery(fixture.initial, io, owner());
  readFails = false;
  await editor.reload();
  expect(editor.snapshot().phase).toBe('idle');
  expect(readingNeedsNavigationDecision(editor.snapshot())).toBe(false);
  readFails = true;
  await editor.reload();
  await editor.edit({ spoilerLevel: 2, suitability: 'show' });
  readFails = false;
  narrowed = true;
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    knownCurrent: true,
    known: { spoilerLevel: 0, suitability: 'blur', version: 0 },
    draft: { spoilerLevel: 2, suitability: 'show' },
  });

  await editor.submit();
  expect(fixture.calls).toHaveLength(0);
  expect(editor.snapshot().draft).toMatchObject({ spoilerLevel: 2, suitability: 'show' });

  await editor.edit({ spoilerLevel: 1 });
  await editor.submit();
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({ expectedVersion: 0, spoilerLevel: 1, suitability: 'show' });
  expect(editor.snapshot().phase).toBe('saved');
});

test('loading current values retains the exact uncertain original and later edits through independent recovery', async () => {
  const fixture = readingFixture('lost');
  const editor = new ReadingDraftRecovery(fixture.initial, fixture.io, owner());
  await editor.edit({ spoilerLevel: 1 });
  const original = editor.snapshot().pending;
  await editor.edit({ suitability: 'show' });
  const finish = fixture.holdNextRead({
    signedIn: true,
    state: 'unavailable',
    failure: { status: 503 },
    securityHref: null,
  });
  const loading = editor.reload();
  await editor.edit({ spoilerLevel: 2 });
  await editor.retry(); // A read in flight cannot race the original retry.
  finish();
  await loading;
  expect(editor.snapshot()).toMatchObject({
    phase: 'uncertain',
    failureOrigin: 'read',
    pending: original,
  });
  await editor.reload();
  editor.useCurrent(); // A current GET cannot settle or discard an uncertain write.
  expect(editor.snapshot().pending).toBe(original);
  expect(editor.snapshot().draft).toMatchObject({
    spoilerLevel: 2,
    suitability: 'show',
  });
  expect(fixture.calls).toHaveLength(1);
  await editor.retry();
  expect(fixture.calls[1]).toBe(original);
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    draft: { spoilerLevel: 2, suitability: 'show' },
  });
  await editor.submit();
  expect(fixture.calls[2]).toMatchObject({
    expectedVersion: 1,
    spoilerLevel: 2,
    suitability: 'show',
  });
  expect(editor.snapshot().phase).toBe('saved');
  expect(readingNeedsNavigationDecision(editor.snapshot())).toBe(false);
});

test('a confirmed command keeps later edit-back and recovers a failed current read without replaying stale fields', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const fixture = readingFixture('lost');
    let releaseRead!: (page: Awaited<ReturnType<typeof fixture.io.read>>) => void;
    let startRead!: () => void;
    const readStarted = new Promise<void>((resolve) => (startRead = resolve));
    let reads = 0;
    const io: ReadingIO = {
      ...fixture.io,
      read: () => {
        if (++reads > 1) return fixture.io.read();
        startRead();
        return new Promise((resolve) => (releaseRead = resolve));
      },
    };
    const editor = new ReadingDraftRecovery(fixture.initial, io, owner());
    await editor.edit({ spoilerLevel: 1 });
    const original = editor.snapshot().pending;
    await editor.edit({ spoilerLevel: 0 });
    const retrying = editor.retry();
    await readStarted;
    const stalePage = await fixture.io.read();
    mock.timers.tick(managedReadTimeout);
    await flushPromiseJobs();
    expect(editor.snapshot()).toMatchObject({
      phase: 'failed',
      pending: null,
      failureOrigin: 'read',
      knownCurrent: false,
    });
    expect(editor.snapshot().confirmedReceipt).toMatchObject({ spoilerLevel: 1, suitability: 'blur', version: 1 });
    await editor.retry();
    expect(fixture.calls).toEqual([original, original]);
    await retrying;

    fixture.concurrent({ suitability: 'show' });
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      pending: null,
      knownCurrent: true,
      known: { spoilerLevel: 1, suitability: 'show', version: 2 },
      draft: { spoilerLevel: 0, suitability: 'show' },
    });
    releaseRead(stalePage);
    await flushPromiseJobs();
    expect(editor.snapshot().known).toMatchObject({ spoilerLevel: 1, suitability: 'show', version: 2 });
    expect(fixture.calls).toEqual([original, original]);
    await editor.submit();
    expect(fixture.calls[2]).toMatchObject({ expectedVersion: 2, spoilerLevel: 0 });
    expect(fixture.calls[2]).not.toHaveProperty('suitability');
    const live = readingFixture('conflict');
    const review = new ReadingDraftRecovery(live.initial, live.io, owner());
    await review.edit({ spoilerLevel: 1 });
    await review.reload();
    review.useCurrent();
    expect(review.snapshot()).toMatchObject({
      phase: 'idle',
      pending: null,
      draft: { spoilerLevel: 2, suitability: 'show' },
    });
    expect(live.calls).toHaveLength(1);
  } finally {
    mock.timers.restore();
  }
});
