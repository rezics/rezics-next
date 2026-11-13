import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import type { HostedOutlineWindowNative, HostedOwnedBook } from '../src/studio/hosted-contract';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import { HostedReleasePreparationVisit, type ReleaseTransport } from '../src/studio/hosted-release-preparation';
import { createReleaseCommand } from '../src/studio/hosted-release-preparation-native';
import type { ReleaseProgress, ReleaseRequest } from '../src/studio/hosted-release-preparation-contract';
import { releaseCopy } from '../src/studio/hosted-release-preparation-copy';
import { releaseSelectionCopy } from '../src/studio/hosted-release-selection-copy';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole, getByText } = await import('@testing-library/dom');
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
function session() {
  let observation: HistoricalReaderObservation = {
    sourceId: 'author',
    generation: 1,
    dataUpdateCount: 1,
    dataUpdatedAt: 1,
    state: 'signed-in',
    subject: owner.viewer.accountId,
    credentialMode: 'session',
    healthy: true,
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
    replace: () => {
      observation = { ...observation, generation: observation.generation + 1 };
      for (const listener of listeners) listener();
    },
  };
}
function progress(
  stageId: string,
  count = '0',
  state: ReleaseProgress['stage']['state'] = 'collecting',
): ReleaseProgress {
  return {
    catalogueId: id(1),
    stageId,
    stage: {
      locator: { catalogueId: id(1), stageId },
      mode: 'selection',
      state,
      inputVersion: count === '0' ? '0' : '1',
      inputCount: count,
      settledInputCount: '0',
      candidateCount: '0',
      sourceFrontier: '-1',
      sourceExhausted: false,
      closureFrontier: '-1',
      closureCheckedCount: '0',
      closureMissingCount: '0',
      failure: null,
    },
    candidate: null,
    candidateReady: false,
  };
}
function pages(): HostedOutlineWindowNative {
  return {
    readOutlineWindow: mock(async ({ revision, cursor }) => ({
      ok: true,
      value: {
        ...revision,
        items:
          cursor === null
            ? [
                {
                  occurrenceId: id(60),
                  kind: 'part',
                  parentId: null,
                  position: 0,
                  availability: 'available',
                  title: 'Northern coast',
                  target: null,
                },
              ]
            : [
                {
                  occurrenceId: id(61),
                  kind: 'chapter',
                  parentId: id(60),
                  position: 0,
                  availability: 'available',
                  title: 'Tide pools',
                  target: { threadId: id(70), postId: id(71), revisionId: id(72), sha256: 'a'.repeat(64) },
                },
                { occurrenceId: id(62), kind: 'chapter', parentId: id(60), position: 1, availability: 'unavailable' },
              ],
        nextCursor: cursor === null ? 'exact-page-two' : null,
      },
    })),
  };
}

test('author adds two exact pages, replays the identical lost batch and explicitly freezes without changing the published release', async () => {
  const calls: { url: string; key: string | null; body: Record<string, unknown> }[] = [];
  let stageId = '';
  let inputs = 0;
  let lost = false;
  const receipts = new Map<string, ReleaseProgress>();
  const native: ReleaseTransport = {
    readOwn: mock(async () => ({ ok: true, value: owner })),
    command: createReleaseCommand(
      createKernelClient('https://kernel.test', {
        fetch: (async (request: Request) => {
          const url = request.url;
          const body = (await request.json()) as Record<string, unknown>;
          const key = request.headers.get('idempotency-key');
          calls.push({ url, key, body });
          const retained = receipts.get(key!);
          if (retained) return Response.json(retained);
          if (url.endsWith(':prepareRelease')) {
            stageId = body.stageId as string;
            return Response.json(progress(stageId), { status: 202 });
          }
          if (url.endsWith(':appendSelectionBatch')) {
            const ids = body.occurrenceIds as string[];
            inputs += ids.length;
            const value = {
              ...progress(stageId, String(inputs)),
              batch: {
                replayed: false,
                inputVersion: String(inputs),
                firstInputPosition: String(inputs - ids.length),
                itemCount: ids.length,
              },
            };
            receipts.set(key!, value);
            if (!lost) {
              lost = true;
              throw new TypeError('lost committed batch response');
            }
            return Response.json(value);
          }
          return Response.json(progress(stageId, String(inputs), 'building'));
        }) as typeof fetch,
      }),
    ),
  };
  const selectionNative = pages();
  const visit = new HostedReleasePreparationVisit({
    owner,
    source: session().source,
    csrfToken: 'csrf',
    locale: 'en',
    native,
    selectionNative,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const copy = releaseSelectionCopy.en;
  try {
    await act(async () => root.render(<HostedReleasePreparationView visit={visit} locale="en" />));
    await act(async () => getByRole(container, 'button', { name: releaseCopy.en.confirm }).click());
    await act(async () => getByRole(container, 'button', { name: copy.start }).click());
    expect(calls[0]!.body).toMatchObject({
      mode: 'selection',
      expectedRevisionId: id(4),
      expectedPublicationId: id(5),
    });
    await act(async () => visit.freezeSelection());
    expect(calls).toHaveLength(1);
    expect(getByRole(container, 'button', { name: copy.freeze }).hasAttribute('disabled')).toBe(true);
    await act(async () => getByRole(container, 'checkbox', { name: /Northern coast/ }).click());
    await act(async () => getByRole(container, 'button', { name: copy.add }).click());
    const pending = visit.snapshot();
    expect(pending).toMatchObject({ phase: 'unknown', pending: { kind: 'append', body: { occurrenceIds: [id(60)] } } });
    await act(async () => {
      await visit.freezeSelection();
      await visit.loadSelectionPage('next');
      visit.choosePlacement(id(60));
      await visit.readProgress();
    });
    expect(calls).toHaveLength(2);
    expect(selectionNative.readOutlineWindow).toHaveBeenCalledTimes(1);
    await act(async () => getByRole(container, 'button', { name: releaseCopy.en.retry }).click());
    expect(calls[2]).toEqual(calls[1]);
    expect(String(calls[1]!.body.batchId).slice(24, 28)).toBe('12ab');
    expect(visit.snapshot()).toMatchObject({
      phase: 'selecting',
      selection: { occurrenceIds: [] },
      progress: { stage: { inputCount: '1' } },
    });
    await act(async () => getByRole(container, 'button', { name: copy.next }).click());
    expect(queryByRole(container, 'checkbox', { name: /Northern coast/ })).toBeNull();
    expect(getByRole(container, 'checkbox', { name: /Unavailable placement/ }).hasAttribute('disabled')).toBe(true);
    await act(async () => getByRole(container, 'checkbox', { name: /Tide pools/ }).click());
    await act(async () => visit.freezeSelection());
    expect(calls).toHaveLength(3);
    await act(async () => getByRole(container, 'button', { name: copy.add }).click());
    expect(calls.at(-1)!.body.occurrenceIds).toEqual([id(61)]);
    await act(async () => getByRole(container, 'button', { name: copy.freeze }).click());
    expect(calls.at(-1)!.url).toEndWith(':freezeSelection');
    expect(calls.at(-1)!.body).toEqual({});
    expect(visit.snapshot()).toMatchObject({ phase: 'paused', selection: null });
    expect(queryByRole(container, 'checkbox')).toBeNull();
    expect(queryByRole(container, 'button', { name: /publish|activate/i })).toBeNull();
    expect(owner.item.publicationId).toBe(id(5));
    expect(selectionNative.readOutlineWindow).toHaveBeenCalledWith(
      {
        revision: { catalogueId: id(1), revisionId: id(4), kind: 'structure', sourceRevisionId: null },
        cursor: 'exact-page-two',
      },
      expect.any(AbortSignal),
    );
  } finally {
    await act(async () => {
      visit.dispose();
      root.unmount();
    });
    container.remove();
  }
});

test('locator-only resume keeps native counts, freezes retained input and explains native closure recovery', async () => {
  const stageId = id(40);
  const commands: ReleaseRequest[] = [];
  const selectionNative = pages();
  const visit = new HostedReleasePreparationVisit({
    owner,
    source: session().source,
    csrfToken: 'csrf',
    locale: 'en',
    stageId,
    selectionNative,
    native: {
      readOwn: async () => ({ ok: true, value: { ...owner, item: { ...owner.item, headRevisionId: id(9) } } }),
      command: async (input) => {
        commands.push(input);
        const value = progress(
          stageId,
          '9007199254740993',
          input.kind === 'advance' ? 'failed' : input.kind === 'freeze' ? 'building' : 'collecting',
        );
        if (input.kind === 'advance') {
          value.stage.failure = 'missing_ancestor';
          value.stage.closureMissingCount = '1';
        }
        return { ok: true, value };
      },
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<HostedReleasePreparationView visit={visit} locale="en" />);
      await visit.readProgress();
    });
    expect(getByText(container, releaseSelectionCopy.en.resumed)).toBeDefined();
    expect(getByText(container, '9,007,199,254,740,993')).toBeDefined();
    expect(selectionNative.readOutlineWindow).not.toHaveBeenCalled();
    await act(async () => visit.freezeSelection());
    await act(async () => visit.resume());
    expect(getByRole(container, 'alert').textContent).toBe(releaseSelectionCopy.en.missing);
    expect(commands.map((input) => input.kind)).toEqual(['progress', 'freeze', 'advance']);
    expect(commands[1]).toMatchObject({ expectedMode: 'selection' });
    expect(queryByRole(container, 'button', { name: releaseCopy.en.seal })).toBeNull();
    await act(async () => visit.refreshReview());
    expect(visit.snapshot()).toMatchObject({
      phase: 'review',
      stageId: null,
      owner: { item: { headRevisionId: id(9), publicationId: id(5) } },
    });
  } finally {
    await act(async () => {
      visit.dispose();
      root.unmount();
    });
    container.remove();
  }
});

test('selection transport refuses wrong stage or mode and unacknowledged batches; stale input retires pages and source replacement discards late replies', async () => {
  const stageId = id(40);
  const request: ReleaseRequest = {
    kind: 'append',
    catalogueId: id(1),
    stageId,
    expectedViewer: owner.viewer,
    expectedMode: 'selection',
    idempotencyKey: 'exact-batch',
    body: { batchId: id(50), occurrenceIds: [id(61)] },
  };
  const good = {
    ...progress(stageId, '1'),
    batch: { replayed: true, inputVersion: '1', firstInputPosition: '0', itemCount: 1 },
  };
  for (const reply of [
    { ...good, stageId: id(41) },
    { ...good, stage: { ...good.stage, mode: 'whole' } },
    progress(stageId, '1'),
    { ...good, batch: { ...good.batch, itemCount: 2 } },
  ]) {
    const command = createReleaseCommand(
      createKernelClient('https://kernel.test', { fetch: (async () => Response.json(reply)) as typeof fetch }),
    );
    expect(await command(request, new AbortController().signal, '')).toMatchObject({
      ok: false,
      error: { kind: 'uncertain' },
    });
  }
  for (const status of [412, 409]) {
    const identity = session();
    const visit = new HostedReleasePreparationVisit({
      owner,
      source: identity.source,
      csrfToken: 'csrf',
      locale: 'en',
      selectionNative: pages(),
      native: {
        readOwn: async () => ({ ok: true, value: owner }),
        command: async (input, signal, csrf) =>
          input.kind === 'start'
            ? { ok: true, value: progress(input.stageId) }
            : createReleaseCommand(
                createKernelClient('https://kernel.test', {
                  fetch: (async () => Response.json({ code: 'rejected' }, { status })) as typeof fetch,
                }),
              )(input, signal, csrf),
      },
    });
    visit.confirmReview();
    await visit.start('selection');
    visit.choosePlacement(id(60));
    await visit.appendSelection();
    expect(visit.snapshot()).toMatchObject({
      phase: status === 412 ? 'stale' : 'invalid',
      selection: null,
      pending: null,
    });
    await visit.freezeSelection();
    await visit.refreshReview();
    expect(visit.snapshot()).toMatchObject({ phase: 'review', stageId: null });
    visit.dispose();
  }
  const identity = session();
  let release!: (result: { ok: true; value: ReleaseProgress }) => void;
  let signal!: AbortSignal;
  const visit = new HostedReleasePreparationVisit({
    owner,
    source: identity.source,
    csrfToken: 'csrf',
    locale: 'en',
    selectionNative: pages(),
    native: {
      readOwn: async () => ({ ok: true, value: owner }),
      command: async (input, requestSignal) => {
        if (input.kind === 'start') return { ok: true, value: progress(input.stageId) };
        signal = requestSignal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  });
  visit.confirmReview();
  await visit.start('selection');
  visit.choosePlacement(id(60));
  const appending = visit.appendSelection();
  // The routed batch ID is prepared asynchronously before transport dispatch.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  identity.replace();
  expect(signal.aborted).toBe(true);
  release({ ok: true, value: good });
  await appending;
  expect(visit.snapshot()).toEqual({ kind: 'ended', reason: 'session' });
});
