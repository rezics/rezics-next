import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import type { HostedOwnedBook } from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedReleasePreparationVisit, type ReleaseTransport } from '../src/studio/hosted-release-preparation';
import { createReleaseCommand } from '../src/studio/hosted-release-preparation-native';
import type { ReleaseProgress, ReleaseRequest } from '../src/studio/hosted-release-preparation-contract';
import { releaseCopy } from '../src/studio/hosted-release-preparation-copy';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { HostedReleasePreparationView } = await import('../src/studio/hosted-release-preparation-view');
afterAll(() => dom.restore());
const id = (n: number) => `00000000-0000-8000-8000-12ab${String(n).padStart(8, '0')}`;
const owner: HostedOwnedBook = {
  viewer: { accountId: id(10), authnEpoch: 2 },
  scope: { kind: 'all-homes', route: 0, crossHome: 'complete' },
  item: {
    catalogueId: id(1),
    threadId: id(2),
    postRevisionId: id(3),
    headRevisionId: id(4),
    publicationId: id(5),
    title: 'Field notes',
    postVisibility: 'published',
    createdAt: '2026-11-13T09:00:00Z',
  },
};

/** Same whole-source milestones as hosted-publication-preparation-http.test.ts: four placements, two roots/chapters. */
function progress(stageId: string, milestone = 0): ReleaseProgress {
  return {
    catalogueId: id(1),
    stageId,
    stage: {
      locator: { catalogueId: id(1), stageId },
      mode: 'whole',
      state: milestone === 0 ? 'building' : milestone === 1 ? 'ready' : 'sealed',
      inputVersion: '0',
      inputCount: '0',
      settledInputCount: '0',
      candidateCount: milestone ? '4' : '0',
      sourceFrontier: milestone ? '3' : '-1',
      sourceExhausted: milestone > 0,
      closureFrontier: '-1',
      closureCheckedCount: '0',
      closureMissingCount: '0',
      failure: null,
    },
    candidate:
      milestone < 2
        ? null
        : {
            candidateId: id(30),
            generationId: id(31),
            afterSourceOrder: milestone > 2 ? '3' : null,
            placementCount: milestone > 2 ? '4' : '0',
            rootCount: milestone > 2 ? '2' : '0',
            chapterCount: milestone > 2 ? '2' : '0',
            coverageComplete: milestone > 2,
            sealed: milestone > 3,
          },
    candidateReady: milestone > 3,
  };
}

function session() {
  let observation: HistoricalReaderObservation = {
    sourceId: 'author',
    generation: 1,
    healthy: true,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: owner.viewer.accountId,
    credentialMode: 'session',
    csrfReady: true,
  };
  const listeners = new Set<() => void>();
  const source: HistoricalReaderSource = {
    id: 'author',
    read: () => observation,
    revision: () => observation.generation,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    replace: (change: Partial<HistoricalReaderObservation>) => {
      observation = { ...observation, ...change };
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

test('native transport replays a lost step, remount resumes its stage, pause bounds work, and seal leaves the old release current', async () => {
  const identity = session();
  const calls: { url: string; body: Record<string, unknown>; key: string; signal: AbortSignal | null | undefined }[] =
    [];
  const receipts = new Map<string, ReleaseProgress>();
  let stored: ReleaseProgress | null = null;
  let milestone = 0;
  let loseAdvance = true;
  let pauseAfterAdvance: (() => void) | null = null;
  const fetcher = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    const key = new Headers(init?.headers).get('idempotency-key')!;
    calls.push({ url, body, key, signal: init?.signal });
    const replay = receipts.get(key);
    if (replay) return Response.json(replay, { status: url.endsWith(':prepareRelease') ? 202 : 200 });
    if (url.endsWith(':prepareRelease')) stored = progress(body.stageId);
    else if (url.endsWith(':advance')) stored = progress(stored!.stageId, ++milestone);
    else if (url.endsWith(':seal')) stored = progress(stored!.stageId, 4);
    else expect(url.endsWith(':progress')).toBe(true);
    receipts.set(key, structuredClone(stored!));
    if (url.endsWith(':advance') && loseAdvance) {
      loseAdvance = false;
      throw new TypeError('Lost committed reply');
    }
    if (url.endsWith(':advance')) pauseAfterAdvance?.();
    return Response.json(stored, { status: url.endsWith(':prepareRelease') ? 202 : 200 });
  }) as typeof fetch;
  const command = createReleaseCommand(createKernelClient('https://kernel.test', { fetch: fetcher }));
  const native: ReleaseTransport = { command, readOwn: mock(async () => ({ ok: true, value: owner })) };
  const locate = mock((_stage: string | null) => {});
  const options = { owner, source: identity.source, csrfToken: 'private-csrf', locale: 'en' as const, native, locate };
  const visit = new HostedReleasePreparationVisit(options);
  visit.confirmReview();
  expect(calls).toHaveLength(0);
  await visit.start();
  const started = visit.snapshot();
  expect(started).toMatchObject({
    phase: 'paused',
    review: { expectedRevisionId: id(4), expectedPublicationId: id(5) },
  });
  const stageId = started.kind === 'active' ? started.stageId! : '';
  expect(stageId.slice(24, 28)).toBe('12ab');
  expect(locate).toHaveBeenLastCalledWith(stageId);
  expect(calls[0]!.body).toEqual({ stageId, mode: 'whole', expectedRevisionId: id(4), expectedPublicationId: id(5) });
  const running = visit.resume();
  await visit.resume();
  await running;
  expect(visit.snapshot()).toMatchObject({ phase: 'unknown' });
  expect(calls).toHaveLength(2);
  expect(String(calls[1]!.body.stepId).slice(24, 28)).toBe('12ab');
  await visit.refreshReview();
  expect(native.readOwn).not.toHaveBeenCalled();
  await visit.retry();
  expect(calls[2]).toMatchObject({ url: calls[1]!.url, body: calls[1]!.body, key: calls[1]!.key });
  expect(visit.snapshot()).toMatchObject({ phase: 'paused', progress: { stage: { state: 'ready' } } });
  visit.dispose();
  expect(identity.listeners.size).toBe(0);
  // Only the locator survives remount; the old expected draft and credentials are not recovered from storage.
  const resumed = new HostedReleasePreparationVisit({ ...options, stageId });
  await resumed.readProgress();
  expect(calls.at(-1)!.url).toBe(
    `https://kernel.test/v1/hostedCatalogues/${id(1)}/publicationPreparations/${stageId}:progress`,
  );
  expect(resumed.snapshot()).toMatchObject({ review: null, phase: 'paused' });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HostedReleasePreparationView visit={resumed} locale="en" />));
    pauseAfterAdvance = resumed.pause;
    const before = calls.length;
    await act(async () => resumed.resume());
    expect(calls).toHaveLength(before + 1);
    expect(resumed.snapshot()).toMatchObject({
      phase: 'paused',
      progress: { stage: { state: 'sealed' }, candidateReady: false },
    });
    expect(queryByRole(container, 'button', { name: releaseCopy.en.seal })).toBeNull();
    pauseAfterAdvance = null;
    await act(async () => resumed.resume());
    getByRole(container, 'button', { name: releaseCopy.en.seal });
    expect(resumed.snapshot()).toMatchObject({ phase: 'ready' });
    await act(async () => resumed.seal());
    expect(getByRole(container, 'status').textContent).toBe(releaseCopy.en.prepared);
    expect(resumed.snapshot()).toMatchObject({ phase: 'prepared', progress: { candidateReady: true } });
    expect(queryByRole(container, 'button', { name: /publish|activate/i })).toBeNull();
    expect(owner.item.publicationId).toBe(id(5));
    expect(calls.every((call) => !call.url.includes('private-csrf') && !call.url.includes(':publish'))).toBe(true);
    expect(new Set(calls.map((call) => call.key)).size).toBe(calls.length - 1);
  } finally {
    await act(async () => {
      resumed.dispose();
      root.unmount();
    });
    container.remove();
  }
});

test('stale, expired and cancelled stages require fresh review; denial and identity replacement discard private state and late replies', async () => {
  const identity = session();
  let status = 412;
  const command = createReleaseCommand(
    createKernelClient('https://kernel.test', {
      fetch: (async () =>
        Response.json({ code: status === 412 ? 'precondition_failed' : 'forbidden' }, { status })) as typeof fetch,
    }),
  );
  const native: ReleaseTransport = {
    command,
    readOwn: mock(async () => ({
      ok: true,
      value: {
        ...owner,
        item: { ...owner.item, headRevisionId: id(8), publicationId: null },
      },
    })),
  };
  const options = { owner, source: identity.source, csrfToken: 'csrf', locale: 'en' as const, native };
  const visit = new HostedReleasePreparationVisit(options);
  visit.confirmReview();
  await visit.start();
  expect(visit.snapshot()).toMatchObject({ phase: 'stale', review: { expectedPublicationId: id(5) } });
  await visit.refreshReview();
  visit.confirmReview();
  expect(visit.snapshot()).toMatchObject({
    phase: 'reviewed',
    review: { expectedRevisionId: id(8), expectedPublicationId: null },
  });
  status = 403;
  await visit.start();
  expect(visit.snapshot()).toEqual({ kind: 'ended', reason: 'denied' });
  for (const terminal of ['expired', 'cancelled', 'failed'] as const) {
    const stageId = id(40);
    const stage = new HostedReleasePreparationVisit({
      ...options,
      stageId,
      native: {
        ...native,
        command: async () => ({
          ok: true,
          value: { ...progress(stageId), stage: { ...progress(stageId).stage, state: terminal } },
        }),
      },
    });
    await stage.readProgress();
    await stage.resume();
    expect(stage.snapshot()).toMatchObject({ phase: terminal });
    await stage.refreshReview();
    expect(stage.snapshot()).toMatchObject({ phase: 'review', stageId: null, review: null });
    stage.dispose();
  }
  for (const change of [{ generation: 2 }, { subject: id(80) }, { csrfReady: false }, { healthy: false }]) {
    const current = session();
    let release!: (value: { ok: true; value: ReleaseProgress }) => void;
    let seenSignal: AbortSignal | null = null;
    const pending = new HostedReleasePreparationVisit({
      ...options,
      source: current.source,
      stageId: id(50),
      native: {
        ...native,
        command: async (_input, signal) => {
          seenSignal = signal;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const reading = pending.readProgress();
    current.replace(change);
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    release({ ok: true, value: progress(id(50), 4) });
    await reading;
    expect(pending.snapshot()).toEqual({ kind: 'ended', reason: 'session' });
    expect(current.listeners.size).toBe(0);
  }
});

test('malformed or cross-stage HTTP replies remain unresolved and a successful cancel is terminal', async () => {
  const stageId = id(40);
  const request: ReleaseRequest = {
    kind: 'progress',
    catalogueId: id(1),
    stageId,
    expectedViewer: owner.viewer,
    idempotencyKey: 'progress-1',
    body: {},
  };
  for (const value of [
    { ...progress(stageId, 4), stageId: id(41) },
    {
      ...progress(stageId, 4),
      stage: { ...progress(stageId).stage, locator: { catalogueId: id(1), stageId: id(41) } },
    },
    { ...progress(stageId, 4), candidate: { ...progress(stageId, 4).candidate!, placementCount: '4.5' } },
  ]) {
    const command = createReleaseCommand(
      createKernelClient('https://kernel.test', { fetch: (async () => Response.json(value)) as typeof fetch }),
    );
    expect(await command(request, new AbortController().signal, '')).toMatchObject({
      ok: false,
      error: { kind: 'uncertain' },
    });
  }
  const commands: ReleaseRequest[] = [];
  const visit = new HostedReleasePreparationVisit({
    owner,
    source: session().source,
    csrfToken: 'csrf',
    locale: 'en',
    stageId,
    native: {
      readOwn: async () => ({ ok: true, value: owner }),
      command: async (input) => {
        commands.push(input);
        return {
          ok: true,
          value:
            input.kind === 'cancel'
              ? { ...progress(stageId), stage: { ...progress(stageId).stage, state: 'cancelled' } }
              : progress(stageId),
        };
      },
    },
  });
  await visit.readProgress();
  await visit.cancel();
  await visit.resume();
  await visit.seal();
  expect(commands.map((command) => command.kind)).toEqual(['progress', 'cancel']);
  expect(visit.snapshot()).toMatchObject({ phase: 'cancelled' });
  visit.dispose();
});
