import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import type { Locale } from '../src/paraglide/runtime.js';
import type { HistoricalReaderObservation, HistoricalReaderSource } from '../src/threads/historical-reader-provenance';
import type { HostedOwnedBook } from '../src/studio/hosted-contract';
import type { StudioResult } from '../src/studio/contract';
import type { ReleaseProgress } from '../src/studio/hosted-release-preparation-contract';
import type {
  ActivationProgress,
  ActivationRequest,
  HostedReleaseActivationOperations,
} from '../src/studio/hosted-release-activation-contract';
import { createHostedReleaseActivationTransport } from '../src/studio/hosted-release-activation-native';
import { HostedReleaseActivationVisit, preparedActivationReview } from '../src/studio/hosted-release-activation';
import { HostedReleasePreparationVisit } from '../src/studio/hosted-release-preparation';
import { activationCopy } from '../src/studio/hosted-release-activation-copy';
import { releaseCopy } from '../src/studio/hosted-release-preparation-copy';
import { installPostReadingDom } from './post-reading-dom';

const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { getByRole, queryByRole } = await import('@testing-library/dom');
const { HostedReleaseActivationView } = await import('../src/studio/hosted-release-activation-view');
const { HostedReleaseActivationEntry } = await import('../src/studio/hosted-release-activation-entry');
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
    title: 'Field notes from the northern coast',
    postVisibility: 'published',
    createdAt: '2026-11-13T09:00:00Z',
  },
};
const prepared: ReleaseProgress = {
  catalogueId: id(1),
  stageId: id(20),
  stage: {
    locator: { catalogueId: id(1), stageId: id(20) },
    state: 'sealed',
    mode: 'whole',
    sourceRevisionId: id(4),
    expectedHeadRevisionId: id(4),
    expectedPublicationId: id(5),
    inputVersion: '0',
    inputCount: '0',
    settledInputCount: '0',
    candidateCount: '22',
    sourceFrontier: '21',
    sourceExhausted: true,
    closureFrontier: '-1',
    closureCheckedCount: '0',
    closureMissingCount: '0',
    failure: null,
  },
  candidate: {
    candidateId: id(30),
    generationId: id(31),
    afterSourceOrder: '21',
    placementCount: '22',
    rootCount: '1',
    chapterCount: '21',
    coverageComplete: true,
    sealed: true,
  },
  candidateReady: true,
};
function progress(state: ActivationProgress['state'] = 'checking', checked = '0', passId = id(40)): ActivationProgress {
  return {
    catalogueId: id(1),
    stageId: id(20),
    state,
    passId,
    checkedTargetCount: checked,
    totalTargetCount: '22',
    candidateGenerationId: id(31),
    publicationId: state === 'activated' ? id(60) : null,
    restartRequired: state === 'restart',
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
    listeners,
    replace(change: Partial<HistoricalReaderObservation>) {
      observation = { ...observation, ...change };
      listeners.forEach((listener) => listener());
    },
  };
}
function fixture({ restart = false, lose = false } = {}) {
  const identity = session();
  const calls: { kind: string; input: Omit<ActivationRequest, 'kind'>; signal: AbortSignal; csrf: string }[] = [];
  const receipts = new Map<string, ActivationProgress>();
  let current = owner;
  let value = progress();
  let restarted = false;
  let readFailure = false;
  let admitted = true;
  const command =
    (kind: string) =>
    async (
      input: Omit<ActivationRequest, 'kind'>,
      signal: AbortSignal,
      csrf: string,
    ): Promise<StudioResult<unknown>> => {
      calls.push({ kind, input, signal, csrf });
      const replay = receipts.get(input.idempotencyKey);
      if (replay) return { ok: true, value: replay };
      if (kind === 'advance') {
        if (value.state === 'restart') {
          restarted = true;
          value = progress('checking', '20', id(41));
        } else
          value = progress(
            value.checkedTargetCount === '0' ? 'checking' : 'ready',
            value.checkedTargetCount === '0' ? '20' : '22',
            value.passId,
          );
      }
      if (kind === 'activate') {
        value = restart && !restarted ? progress('restart', '22') : progress('activated', '22', value.passId);
        if (value.state === 'activated')
          current = { ...owner, item: { ...owner.item, publicationId: value.publicationId } };
      }
      receipts.set(input.idempotencyKey, value);
      if (lose && value.state === 'activated') {
        lose = false;
        throw new TypeError('Lost committed reply');
      }
      return { ok: true, value };
    };
  const operations: HostedReleaseActivationOperations = {
    startHostedPublicationActivation: command('start'),
    advanceHostedPublicationActivationAuthority: command('advance'),
    activateHostedPublicationCandidate: command('activate'),
    readOwn: mock(async () =>
      readFailure
        ? { ok: false, error: { kind: 'unavailable', message: 'Read unavailable' } }
        : { ok: true, value: current },
    ),
    readMetadata: mock(async (input) => ({
      ok: true,
      value: {
        catalogueId: input.catalogueId,
        revisionId: input.revisionId!,
        kind: 'publication',
        sourceRevisionId: id(4),
      },
    })),
    admitPublic: mock(async () => admitted),
  };
  const native = createHostedReleaseActivationTransport(operations);
  const options = {
    owner,
    review: preparedActivationReview(owner, prepared)!,
    source: identity.source,
    csrfToken: 'original-csrf',
    locale: 'en' as const,
    native,
  };
  const visit = new HostedReleaseActivationVisit(options);
  return {
    identity,
    calls,
    operations,
    native,
    options,
    visit,
    readFailure: (next: boolean) => {
      readFailure = next;
    },
    admitted: (next: boolean) => {
      admitted = next;
    },
    current: (next: HostedOwnedBook) => {
      current = next;
    },
  };
}
async function ready(visit: HostedReleaseActivationVisit) {
  await visit.start();
  await visit.checkNext();
  await visit.checkNext();
}
async function mounted(run: (container: HTMLDivElement, root: ReturnType<typeof createRoot>) => Promise<void>) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await run(container, root);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}
async function click(container: HTMLElement, name: string) {
  await act(async () => (getByRole(container, 'button', { name }) as HTMLButtonElement).click());
}

test('the preparation composition checks one page per action, pauses, and requires explicit activation before exact reader admission', async () => {
  const f = fixture();
  const preparation = new HostedReleasePreparationVisit({
    ...f.options,
    stageId: prepared.stageId,
    native: { readOwn: f.operations.readOwn, command: async () => ({ ok: true, value: prepared }) },
  });
  await preparation.readProgress();
  await mounted(async (container, root) => {
    await act(async () => root.render(<HostedReleasePreparationView visit={preparation} locale="en" />));
    expect(queryByRole(container, 'button', { name: activationCopy.en.start })).toBeNull();
    await act(async () =>
      root.render(
        <HostedReleasePreparationView
          visit={preparation}
          locale="en"
          activation={{ source: f.identity.source, csrfToken: 'original-csrf', native: f.native }}
        />,
      ),
    );
    const copy = activationCopy.en;
    await click(container, copy.start);
    expect(f.calls.map((call) => call.kind)).toEqual(['start']);
    expect(queryByRole(container, 'button', { name: copy.activate })).toBeNull();
    await click(container, copy.next);
    await click(container, copy.pause);
    expect(container.textContent).toContain(copy.paused);
    expect(f.calls).toHaveLength(2);
    await click(container, copy.resume);
    expect(f.calls).toHaveLength(2);
    await click(container, copy.next);
    expect(f.calls.map((call) => call.kind)).toEqual(['start', 'advance', 'advance']);
    expect(f.operations.readOwn).not.toHaveBeenCalled();
    expect(f.operations.admitPublic).not.toHaveBeenCalled();
    expect(container.textContent).toContain(id(5));
    await click(container, copy.activate);
    expect(f.calls.at(-1)!.kind).toBe('activate');
    expect(container.textContent).toContain(copy.activated);
    expect(container.textContent).not.toContain(releaseCopy.en.prepared);
    expect(f.operations.readMetadata).toHaveBeenCalledWith(
      { catalogueId: id(1), kind: 'publication', revisionId: id(60) },
      expect.any(AbortSignal),
    );
    expect(f.operations.admitPublic).toHaveBeenCalledWith(
      { catalogueId: id(1), releaseRevisionId: id(60) },
      expect.any(AbortSignal),
    );
    const link = getByRole(container, 'link', { name: /View published Book/ });
    expect(link.getAttribute('href')).toContain(`release=${id(60)}`);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
    expect(
      f.calls.every((call) => call.input.body.stageId === id(20) && call.input.candidateGenerationId === id(31)),
    ).toBe(true);
  });
  preparation.dispose();
  f.visit.dispose();
});

test('authority restart preserves the candidate and uses a fresh explicit advance; a busy visit admits only one command', async () => {
  const f = fixture({ restart: true });
  await ready(f.visit);
  await f.visit.activate();
  expect(f.visit.snapshot()).toMatchObject({
    phase: 'restart',
    receipt: null,
    progress: { passId: id(40), candidateGenerationId: id(31) },
  });
  expect(f.operations.readOwn).not.toHaveBeenCalled();
  const before = f.calls.length;
  await f.visit.checkNext();
  await f.visit.activate();
  expect(f.calls).toHaveLength(before);
  await f.visit.restartAuthority();
  expect(f.visit.snapshot()).toMatchObject({
    phase: 'checking',
    progress: { passId: id(41), checkedTargetCount: '20', candidateGenerationId: id(31) },
  });
  await f.visit.checkNext();
  expect(f.visit.snapshot()).toMatchObject({ phase: 'ready', receipt: null });
  await f.visit.activate();
  expect(f.visit.readerLink.snapshot()).toEqual({ catalogueId: id(1), releaseRevisionId: id(60) });
  expect(new Set(f.calls.map((call) => call.input.idempotencyKey)).size).toBe(f.calls.length);
  f.visit.dispose();
  let reply!: (value: StudioResult<unknown>) => void;
  const slow = fixture();
  const pending = new HostedReleaseActivationVisit({
    ...slow.options,
    native: createHostedReleaseActivationTransport({
      ...slow.operations,
      advanceHostedPublicationActivationAuthority: mock(
        () =>
          new Promise((resolve) => {
            reply = resolve;
          }),
      ),
    }),
  });
  await pending.start();
  const inFlight = pending.checkNext();
  pending.pause();
  await pending.checkNext();
  await pending.activate();
  expect(pending.snapshot()).toMatchObject({ busy: true, paused: true });
  reply({ ok: true, value: progress('checking', '20') });
  await inFlight;
  expect(pending.snapshot()).toMatchObject({ phase: 'checking', paused: true, busy: false });
  await pending.checkNext();
  expect(pending.snapshot()).toMatchObject({ paused: true });
  pending.dispose();
  slow.visit.dispose();
});

test('lost activation replay retains original body/key/credential; observations never acknowledge it and readback recovery never reactivates', async () => {
  const f = fixture({ lose: true });
  await ready(f.visit);
  await f.visit.activate();
  const lost = f.calls.at(-1)!;
  expect(f.visit.snapshot()).toMatchObject({ phase: 'unknown', receipt: null, pending: { body: { stageId: id(20) } } });
  const pending = f.visit.snapshot();
  await f.visit.readPublication();
  expect(f.visit.snapshot()).toMatchObject({
    phase: 'unknown',
    receipt: null,
    observedPublicationId: id(60),
    readback: 'observed',
  });
  expect(f.operations.readMetadata).not.toHaveBeenCalled();
  expect(f.operations.admitPublic).not.toHaveBeenCalled();
  expect(f.visit.readerLink.snapshot()).toBeNull();
  if (pending.kind === 'active') expect((f.visit.snapshot() as typeof pending).pending).toBe(pending.pending);
  f.readFailure(true);
  await f.visit.retry();
  const replay = f.calls.at(-1)!;
  expect(replay.input).toEqual(lost.input);
  expect(replay.input.body).toBe(lost.input.body);
  expect(replay.csrf).toBe('original-csrf');
  expect(f.visit.snapshot()).toMatchObject({
    phase: 'activated',
    pending: null,
    receipt: { publicationId: id(60) },
    readback: 'unavailable',
  });
  const commands = f.calls.length;
  f.readFailure(false);
  f.admitted(false);
  await f.visit.readPublication();
  expect(f.visit.snapshot()).toMatchObject({ phase: 'activated', readback: 'not-public' });
  f.admitted(true);
  await f.visit.readPublication();
  expect(f.visit.snapshot()).toMatchObject({ readback: 'verified' });
  f.current({ ...owner, item: { ...owner.item, publicationId: id(70) } });
  await f.visit.readPublication();
  expect(f.visit.snapshot()).toMatchObject({ readback: 'different', receipt: { publicationId: id(60) } });
  expect(f.visit.readerLink.snapshot()).toBeNull();
  expect(f.calls).toHaveLength(commands);
  f.visit.dispose();
});

test('external activation progress is bound to the exact native intent and rejects malformed or foreign acknowledgments', async () => {
  const f = fixture();
  const request: ActivationRequest = {
    kind: 'activate',
    catalogueId: id(1),
    stageId: id(20),
    candidateGenerationId: id(31),
    expectedViewer: owner.viewer,
    idempotencyKey: crypto.randomUUID(),
    body: { stageId: id(20) },
  };
  const signal = new AbortController().signal;
  const invalid = [
    { ...progress('activated', '22'), catalogueId: id(80) },
    { ...progress('activated', '22'), stageId: id(80) },
    { ...progress('activated', '22'), candidateGenerationId: id(80) },
    { ...progress('activated', '22'), publicationId: null },
    { ...progress('ready', '20') },
    { ...progress('restart', '22'), restartRequired: false },
    { ...progress(), checkedTargetCount: '23' },
    { ...progress(), totalTargetCount: '2.2' },
  ];
  for (const value of invalid) {
    const command = createHostedReleaseActivationTransport({
      ...f.operations,
      activateHostedPublicationCandidate: async () => ({ ok: true, value }),
    }).command;
    expect(await command(request, signal, 'csrf')).toMatchObject({ ok: false, error: { kind: 'uncertain' } });
  }
  const operation = mock(async () => ({
    ok: true as const,
    value: {
      ...progress('ready', '22'),
      checkedTargetCount: '900719925474099300',
      totalTargetCount: '900719925474099300',
    },
  }));
  const native = createHostedReleaseActivationTransport({
    ...f.operations,
    advanceHostedPublicationActivationAuthority: operation,
  });
  expect(await native.command({ ...request, kind: 'advance' }, signal, 'csrf')).toMatchObject({
    ok: true,
    value: { totalTargetCount: '900719925474099300' },
  });
  const { kind: _kind, ...intent } = request;
  expect(operation).toHaveBeenCalledWith(intent, signal, 'csrf');
  const broken = createHostedReleaseActivationTransport({
    ...f.operations,
    activateHostedPublicationCandidate: async () => {
      throw new Error('Unexpected defect');
    },
  });
  await expect(broken.command(request, signal, 'csrf')).rejects.toThrow('Unexpected defect');
  f.visit.dispose();
});

test('session retirement and operand replacement abort private effects and fence late acknowledgments', async () => {
  for (const change of [
    { generation: 2 },
    { sourceId: 'replacement' },
    { subject: id(90) },
    { csrfReady: false },
    { healthy: false },
  ]) {
    const f = fixture();
    let finish!: (result: StudioResult<ActivationProgress>) => void;
    let signal!: AbortSignal;
    const visit = new HostedReleaseActivationVisit({
      ...f.options,
      native: {
        ...f.native,
        command: async (_input, next) => {
          signal = next;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    const command = visit.start();
    f.identity.replace(change);
    expect(signal.aborted).toBe(true);
    finish({ ok: true, value: progress('activated', '22') });
    await command;
    expect(visit.snapshot()).toEqual({ kind: 'ended', reason: 'session' });
    expect(visit.readerLink.snapshot()).toBeNull();
    f.visit.dispose();
    expect(f.identity.listeners.size).toBe(0);
  }
  for (const replacement of [
    'credential',
    'locale',
    'catalogue',
    'stage',
    'candidate',
    'source',
    'source-revision',
    'account',
  ]) {
    const f = fixture();
    let finish!: (result: StudioResult<ActivationProgress>) => void;
    let signal!: AbortSignal;
    const native = {
      ...f.native,
      command: async (_input: ActivationRequest, next: AbortSignal): Promise<StudioResult<ActivationProgress>> => {
        signal = next;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
    const props = {
      owner,
      prepared,
      locale: 'en' as Locale,
      source: f.identity.source,
      csrfToken: 'original-csrf',
      native,
    };
    await mounted(async (container, root) => {
      await act(async () => root.render(<HostedReleaseActivationEntry {...props} />));
      await click(container, activationCopy.en.start);
      const next = {
        ...props,
        ...(replacement === 'credential' ? { csrfToken: 'replacement-csrf' } : {}),
        ...(replacement === 'locale' ? { locale: 'de' as Locale } : {}),
        ...(replacement === 'source' ? { source: session().source } : {}),
        ...(replacement === 'account' ? { owner: { ...owner, viewer: { ...owner.viewer, accountId: id(90) } } } : {}),
        ...(replacement === 'catalogue' ? { owner: { ...owner, item: { ...owner.item, catalogueId: id(90) } } } : {}),
        ...(replacement === 'stage'
          ? {
              prepared: {
                ...prepared,
                stageId: id(90),
                stage: { ...prepared.stage, locator: { catalogueId: id(1), stageId: id(90) } },
              },
            }
          : {}),
        ...(replacement === 'candidate'
          ? { prepared: { ...prepared, candidate: { ...prepared.candidate!, generationId: id(90) } } }
          : {}),
        ...(replacement === 'source-revision'
          ? {
              prepared: {
                ...prepared,
                stage: { ...prepared.stage, sourceRevisionId: id(90), expectedHeadRevisionId: id(90) },
              },
            }
          : {}),
      };
      await act(async () => root.render(<HostedReleaseActivationEntry {...next} />));
      expect(signal.aborted).toBe(true);
      await act(async () => {
        finish({ ok: true, value: progress('activated', '22') });
      });
      expect(queryByRole(container, 'link')).toBeNull();
      expect(f.operations.readOwn).not.toHaveBeenCalled();
    });
    f.visit.dispose();
  }
});

test('only sealed candidates enter activation, private or empty releases have no reader, and denied or replaced admission retires the visit', async () => {
  expect(preparedActivationReview(owner, { ...prepared, candidateReady: false })).toBeNull();
  expect(
    preparedActivationReview(owner, { ...prepared, candidate: { ...prepared.candidate!, sealed: false } }),
  ).toBeNull();
  const laterOwner = { ...owner, item: { ...owner.item, headRevisionId: id(90), publicationId: id(91) } };
  expect(preparedActivationReview(laterOwner, prepared)).toMatchObject({
    sourceRevisionId: id(4),
    expectedPublicationId: id(5),
  });
  for (const mode of ['private', 'empty', 'foreign-publication'] as const) {
    const f = fixture();
    if (mode === 'private')
      f.current({ ...owner, item: { ...owner.item, publicationId: id(60), postVisibility: 'draft' } });
    const visit = new HostedReleaseActivationVisit({
      ...f.options,
      review: { ...f.options.review, chapterCount: mode === 'empty' ? '0' : '21' },
      native: {
        ...f.native,
        command: async () => ({ ok: true, value: progress('activated', '22') }),
        ...(mode === 'foreign-publication'
          ? {
              readMetadata: async () => ({
                ok: true as const,
                value: {
                  catalogueId: id(1),
                  kind: 'publication' as const,
                  revisionId: id(90),
                  sourceRevisionId: id(4),
                },
              }),
            }
          : {}),
      },
    });
    if (mode !== 'private') f.current({ ...owner, item: { ...owner.item, publicationId: id(60) } });
    await visit.start();
    expect(visit.snapshot()).toMatchObject({
      phase: 'activated',
      readback: mode === 'private' ? 'not-public' : mode === 'empty' ? 'empty' : 'different',
    });
    expect(visit.readerLink.snapshot()).toBeNull();
    expect(f.operations.admitPublic).not.toHaveBeenCalled();
    visit.dispose();
    f.visit.dispose();
  }
  const f = fixture();
  const denied = new HostedReleaseActivationVisit({
    ...f.options,
    native: {
      ...f.native,
      command: async () => ({ ok: false, error: { kind: 'denied', message: 'Native admission revoked' } }),
    },
  });
  await denied.start();
  expect(denied.snapshot()).toEqual({ kind: 'ended', reason: 'denied' });
  let finish!: (admitted: boolean) => void;
  let signal!: AbortSignal;
  let announce!: () => void;
  const admitting = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const late = new HostedReleaseActivationVisit({
    ...f.options,
    native: {
      ...f.native,
      admitPublic: async (_address, next) => {
        signal = next;
        announce();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  await ready(late);
  const activating = late.activate();
  await admitting;
  f.identity.replace({ generation: 2 });
  expect(signal.aborted).toBe(true);
  finish(true);
  await activating;
  expect(late.snapshot()).toEqual({ kind: 'ended', reason: 'session' });
  expect(late.readerLink.snapshot()).toBeNull();
  f.visit.dispose();
});
