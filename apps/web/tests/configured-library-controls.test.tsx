import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import type { LibraryProfile } from '@rezics/definitions';
import type { Release } from '../src/subject/definitions';
import type { ConfiguredLibraryVisit, VisitProgress } from '../src/library/configured-profile-controls/visit';
import {
  CONFIGURED_PAGE_ROW_CAP,
  CONFIGURED_VISIT_NATIVE_CALLS,
} from '../src/library/configured-profile-controls/cost';
import * as start from '../.storybook/react-start';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => false,
  viewerCredential: (request: Request) => request.headers.get('authorization'),
  sessionSubject: () => 'owner-1',
}));
mock.module('../src/library/copies-actions', () => ({
  createCopy() {},
  updateCopy() {},
  deleteCopy() {},
  readCopySubject() {},
  readCopyDetail() {},
  undoCopy() {},
}));
mock.module('../src/library/copies-page', () => ({
  CopyForm: () => createElement('div', { 'data-copy-form': '1' }),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'X-CSRF-Token': 'csrf' }) }));
mock.module('../src/threads/authoring-departure', () => ({ useAuthoringDeparture() {} }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  useOperation: () => true,
}));
mock.module('../src/library/library-workspace-admission', () => ({
  useLibraryWorkspaceAdmission: () => ({ store: { allowed: () => true } }),
}));

const recordCalls: unknown[] = [];
let recordResult: { ok: true; session: { id: string; revision: number; amount: string } } | { ok: false; reason: string } =
  { ok: false, reason: 'conflict' };
mock.module('../src/library/progress-server', () => ({
  startProgressSession: async () => ({ ok: false, reason: 'unavailable' }),
  recordProgressSession: async (input: { data: unknown; headers: unknown }) => {
    recordCalls.push(input);
    return recordResult;
  },
}));
mock.module('../src/library/configured-profile-controls/actions', () => ({
  readConfiguredLibraryVisit: async () => ({ state: 'unavailable', work: { nativeCallCount: 0 } }),
  readConfiguredProgressHistory: async () => ({ signedIn: false, idempotencyKey: id(9) }),
}));

const { loadConfiguredLibraryVisit } = await import('../src/library/configured-profile-controls/visit');
const { readConfiguredProfileCapabilities, MANGA_SERIES_TYPE, MANGA_VOLUME_TYPE } =
  await import('../src/library/configured-profile-controls/capabilities');
const { ConfiguredProfileControls } = await import('../src/library/configured-profile-controls/view');
const { ConfiguredProgressPanel } = await import('../src/library/configured-profile-controls/progress-panel');
const { createGuardedCommand, dispatchGuardedCommand, progressWriteOutcome } =
  await import('../src/library/configured-profile-controls/commands');
const { m } = await import('../src/paraglide/messages.js');

const SERIES = id(1);
const VOLUME = id(2);
const OTHER = id(3);

function unit(unitId: string, label: string) {
  return {
    id: unitId,
    labels: { en: label },
    minimum: '0',
    precision: 0,
    totalPolicy: 'optional' as const,
    identity: { kind: 'none' as const },
    structure: { kind: 'none' as const },
  };
}

function mangaProfile(profileId: string, statePrefix: string, unitId: string, unitLabel: string): LibraryProfile {
  return {
    id: profileId,
    entryStateSet: {
      id: `${profileId}-states`,
      states: [
        { id: `${statePrefix}-reading`, labels: { en: `${statePrefix} reading` }, role: 'active' },
        { id: `${statePrefix}-completed`, labels: { en: `${statePrefix} completed` }, role: 'completed' },
      ],
    },
    progress: { allowed: [{ mode: 'scalar_amount', units: [unit(unitId, unitLabel)] }] },
    copies: {
      kinds: [
        {
          id: 'physical',
          labels: { en: 'Physical' },
          statuses: [
            { id: 'owned', labels: { en: 'Owned' } },
            { id: 'lent', labels: { en: 'Lent' } },
          ],
        },
        {
          id: 'digital',
          labels: { en: 'Digital' },
          statuses: [{ id: 'owned', labels: { en: 'Owned digital' } }],
        },
      ],
    },
    importSources: [],
  };
}

const seriesProfile = mangaProfile('manga.series', 'series', 'chapter', 'Chapters');
const volumeProfile = mangaProfile('manga.volume', 'volume', 'page', 'Pages');
const release = {
  types: {
    [MANGA_SERIES_TYPE]: { library: { profileId: 'manga.series' } },
    [MANGA_VOLUME_TYPE]: { library: { profileId: 'manga.volume' } },
  },
  properties: {},
  libraryProfiles: { 'manga.series': seriesProfile, 'manga.volume': volumeProfile },
} as unknown as Release;
const bareRelease = {
  types: { [MANGA_SERIES_TYPE]: {}, [MANGA_VOLUME_TYPE]: {} },
  properties: {},
} as unknown as Release;

const knownPresentation = {
  meaning: 'known' as const,
  structure: 'unverified' as const,
  recording: { state: 'supported' as const, inputRules: { step: '1', total: 'optional' as const } },
  unitLabel: 'Chapters',
  unitLabelLanguage: 'en',
};

type RawCopy = {
  id: string;
  subjectId: string;
  kind: string;
  status: string;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};
type RawSession = {
  id: string;
  subjectId: string;
  mode: 'scalar_amount';
  unit: string;
  amount: string | null;
  total: string | null;
  state: 'active';
  revision: number;
  presentation?: typeof knownPresentation;
};
type Store = {
  entries: Map<string, { subjectId: string; state: string; revision: number }>;
  copies: RawCopy[];
  sessions: RawSession[];
};

function pageSlice<T>(items: T[], cursor: string | undefined, limit: number) {
  const start = cursor ? Number(cursor) || 0 : 0;
  const slice = items.slice(start, start + limit);
  return { slice, next: start + limit < items.length ? String(start + limit) : null };
}

function kernel(store: Store): KernelClient {
  return {
    libraryEntries: ({ subjectId }: { subjectId: string }) => ({
      get: async () => {
        const entry = store.entries.get(subjectId);
        if (!entry) return { status: 404, data: null, error: { status: 404 } };
        return { status: 200, data: { libraryEntry: entry }, error: null };
      },
    }),
    copies: {
      get: async (options: { query?: { subjectId?: string; cursor?: string; limit?: number } }) => {
        const subjectId = options.query?.subjectId;
        const matched = store.copies.filter((copy) => !subjectId || copy.subjectId === subjectId);
        const { slice, next } = pageSlice(matched, options.query?.cursor, options.query?.limit ?? 100);
        return { status: 200, data: { copies: slice, next }, error: null };
      },
    },
    progressSessions: {
      get: async (options: { query?: { subjectId?: string; cursor?: string; limit?: number } }) => {
        const subjectId = options.query?.subjectId;
        const matched = store.sessions.filter((session) => !subjectId || session.subjectId === subjectId);
        const { slice, next } = pageSlice(matched, options.query?.cursor, options.query?.limit ?? 100);
        return { status: 200, data: { progressSessions: slice, next }, error: null };
      },
    },
  } as KernelClient;
}

function copyRow(n: number, subjectId: string, kind = 'physical'): RawCopy {
  return {
    id: id(100 + n),
    subjectId,
    kind,
    status: 'owned',
    revision: 1,
    location: null,
    source: null,
    acquiredOn: null,
    disposedOn: null,
    note: `note-${n}`,
  };
}

function sessionRow(n: number, subjectId: string, amount: string | null, unitId: string): RawSession {
  return {
    id: id(200 + n),
    subjectId,
    mode: 'scalar_amount',
    unit: unitId,
    amount,
    total: null,
    state: 'active',
    revision: 3,
    presentation: { ...knownPresentation, unitLabel: unitId === 'page' ? 'Pages' : 'Chapters' },
  };
}

function populate(unrelated: number, selected: { copies: RawCopy[]; sessions: RawSession[]; entryState?: string }): Store {
  const copies = [...selected.copies];
  const sessions = [...selected.sessions];
  for (let i = 0; i < unrelated; i++) {
    copies.push(copyRow(i, OTHER, i % 2 ? 'digital' : 'physical'));
    sessions.push(sessionRow(i, OTHER, String(i), 'chapter'));
  }
  const entries = new Map<string, { subjectId: string; state: string; revision: number }>();
  if (selected.entryState) entries.set(SERIES, { subjectId: SERIES, state: selected.entryState, revision: 4 });
  entries.set(VOLUME, { subjectId: VOLUME, state: 'volume-reading', revision: 2 });
  return { entries, copies, sessions };
}

function request() {
  return new Request('https://site.test/en/library', {
    headers: { authorization: 'Bearer owner-token', 'x-csrf-token': 'csrf', 'accept-language': 'en' },
  });
}

async function visit(type: string, subjectId: string, store: Store, extra: { copyCursor?: string; release?: Release } = {}) {
  return loadConfiguredLibraryVisit(
    kernel(store),
    request(),
    {},
    { subjectId, type, locale: 'en', ...(extra.copyCursor ? { copyCursor: extra.copyCursor } : {}) },
    extra.release ?? release,
  );
}

function markup(loaded: ConfiguredLibraryVisit, subject: { id: string; type: string; label: string }) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ConfiguredProfileControls, {
        subject,
        locale: 'en',
        session: { state: 'signed-in', subject: 'owner-1', csrfToken: 'csrf' },
        returnTo: '/en/subjects/series',
        visit: loaded,
        release,
      }),
    ),
  );
}

test('series and volume resolve distinct profiles, units and copy targets', async () => {
  const seriesCaps = readConfiguredProfileCapabilities(release, MANGA_SERIES_TYPE, 'en');
  const volumeCaps = readConfiguredProfileCapabilities(release, MANGA_VOLUME_TYPE, 'en');
  expect(seriesCaps.state).toBe('ready');
  expect(volumeCaps.state).toBe('ready');
  if (seriesCaps.state !== 'ready' || volumeCaps.state !== 'ready') return;
  expect(seriesCaps.identity).toBe('series');
  expect(volumeCaps.identity).toBe('volume');
  expect(seriesCaps.measure?.unit.id).toBe('chapter');
  expect(volumeCaps.measure?.unit.id).toBe('page');
  expect(seriesCaps.states.map((state) => state.id)).toEqual(['series-reading', 'series-completed']);
  expect(volumeCaps.states.map((state) => state.id)).toEqual(['volume-reading', 'volume-completed']);
  expect(seriesCaps.copies.kinds.map((kind) => kind.id)).toEqual(['physical', 'digital']);
  const store = populate(8, {
    copies: [copyRow(900, SERIES, 'physical'), copyRow(901, SERIES, 'digital')],
    sessions: [sessionRow(900, SERIES, '12', 'chapter')],
    entryState: 'series-reading',
  });
  store.copies.push(copyRow(902, VOLUME, 'physical'));
  store.sessions.push(sessionRow(902, VOLUME, '40', 'page'));
  const seriesVisit = await visit(MANGA_SERIES_TYPE, SERIES, store);
  const volumeVisit = await visit(MANGA_VOLUME_TYPE, VOLUME, store);
  expect(seriesVisit.state).toBe('ready');
  expect(volumeVisit.state).toBe('ready');
  if (seriesVisit.state !== 'ready' || volumeVisit.state !== 'ready') return;
  expect(seriesVisit.identity).toBe('series');
  expect(volumeVisit.identity).toBe('volume');
  expect(seriesVisit.entry.meaning === 'current' && seriesVisit.entry.state).toBe('series-reading');
  expect(volumeVisit.entry.meaning === 'current' && volumeVisit.entry.state).toBe('volume-reading');
  expect(seriesVisit.progress.meaning === 'recorded' && seriesVisit.progress.measure.unit.id).toBe('chapter');
  expect(volumeVisit.progress.meaning === 'recorded' && volumeVisit.progress.measure.unit.id).toBe('page');
  expect(seriesVisit.copies.items.map((item) => item.id)).toEqual([id(1000), id(1001)]);
  expect(volumeVisit.copies.items.map((item) => item.id)).toEqual([id(1002)]);
  const html = markup(seriesVisit, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' });
  expect(html).toContain(m.library_configured_series());
  expect(html).toContain('series reading');
  expect(html).not.toContain('volume reading');
});

test('unavailable release, unsupported manga type, refused owner read and historical state stay distinct', async () => {
  const store = populate(0, {
    copies: [copyRow(1, SERIES)],
    sessions: [sessionRow(1, SERIES, '3', 'chapter')],
    entryState: 'planned',
  });
  const missing = await loadConfiguredLibraryVisit(
    kernel(store),
    request(),
    {},
    { subjectId: SERIES, type: MANGA_SERIES_TYPE, locale: 'en' },
    undefined,
  );
  expect(missing).toMatchObject({ state: 'unavailable', work: { nativeCallCount: 0 } });
  const unsupported = await visit(MANGA_SERIES_TYPE, SERIES, store, { release: bareRelease });
  expect(unsupported).toMatchObject({ state: 'unsupported', identity: 'series', work: { nativeCallCount: 0 } });
  expect(markup(unsupported, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' })).toContain(
    m.library_configured_unsupported(),
  );
  const refusedClient = {
    ...kernel(store),
    libraryEntries: () => ({
      get: async () => ({ status: 403, data: null, error: { status: 403 } }),
    }),
  } as KernelClient;
  const refused = await loadConfiguredLibraryVisit(
    refusedClient,
    request(),
    {},
    { subjectId: SERIES, type: MANGA_SERIES_TYPE, locale: 'en' },
    release,
  );
  expect(refused.state).toBe('refused');
  expect(markup(refused, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' })).toContain(
    m.library_configured_refused(),
  );
  const historical = await visit(MANGA_SERIES_TYPE, SERIES, store);
  expect(historical.state === 'ready' && historical.entry.meaning).toBe('historical');
  if (historical.state === 'ready') expect(historical.entry.state).toBe('planned');
  const html = markup(historical, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' });
  expect(html).toContain(m.library_configured_historical());
  expect(html).toContain(m.library_configured_admitted_states());
});

test('zero amount, absent amount and absent session are distinct single-manual meanings', async () => {
  const zeroStore = populate(0, {
    copies: [],
    sessions: [sessionRow(1, SERIES, '0', 'chapter')],
    entryState: 'series-reading',
  });
  const zero = await visit(MANGA_SERIES_TYPE, SERIES, zeroStore);
  expect(zero.state === 'ready' && zero.progress.meaning).toBe('zero');
  expect(markup(zero, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' })).toContain(
    m.library_configured_progress_zero(),
  );
  const emptyAmount = populate(0, {
    copies: [],
    sessions: [sessionRow(1, SERIES, null, 'chapter')],
    entryState: 'series-reading',
  });
  const cleared = await visit(MANGA_SERIES_TYPE, SERIES, emptyAmount);
  expect(cleared.state === 'ready' && cleared.progress.meaning).toBe('absent');
  if (cleared.state === 'ready' && cleared.progress.meaning === 'absent') expect(cleared.progress.session?.id).toBe(id(201));
  expect(markup(cleared, { id: SERIES, type: MANGA_SERIES_TYPE, label: 'One Piece' })).toContain(
    m.library_configured_absent_progress(),
  );
  const noSession = populate(0, { copies: [], sessions: [], entryState: 'series-reading' });
  const absent = await visit(MANGA_SERIES_TYPE, SERIES, noSession);
  expect(absent.state === 'ready' && absent.progress.meaning).toBe('absent');
  if (absent.state === 'ready' && absent.progress.meaning === 'absent') expect(absent.progress.session).toBeUndefined();
});

test('unavailable retry keeps sender, credential, key and operands; conflict does not reuse that command', async () => {
  const operands = { sessionId: id(8), revision: 3, amount: '12', idempotencyKey: id(7) };
  let attempts = 0;
  const sender = async (input: { data: typeof operands; headers: HeadersInit }) => {
    attempts += 1;
    expect(input.data).toEqual(operands);
    expect(input.headers).toEqual({ 'X-CSRF-Token': 'csrf-token' });
    return attempts === 1
      ? ({ ok: false, reason: 'unavailable' } as const)
      : ({
          ok: true,
          session: { id: operands.sessionId, revision: 4, amount: '12', locator: null, position: null, completedUnitCount: 12, state: 'active' as const, completedAt: null, total: null },
        } as const);
  };
  const command = createGuardedCommand(sender, 'csrf-token', operands);
  const first = await dispatchGuardedCommand(command, () => true);
  expect(progressWriteOutcome(first!)).toEqual({ state: 'unavailable' });
  expect(command.key).toBe(operands.idempotencyKey);
  expect(command.credential).toBe('csrf-token');
  expect(command.sender).toBe(sender);
  expect(command.operands).toEqual(operands);
  const second = await dispatchGuardedCommand(command, () => true);
  expect(second && 'ok' in second && second.ok).toBe(true);
  expect(attempts).toBe(2);
  const conflictSender = async () => ({ ok: false, reason: 'conflict' as const });
  const conflict = createGuardedCommand(conflictSender, 'csrf-token', { ...operands, idempotencyKey: id(11) });
  expect(progressWriteOutcome((await dispatchGuardedCommand(conflict, () => true))!)).toEqual({ state: 'conflict' });
  expect(conflict.response).toBeUndefined();
});

test('conflict keeps the draft and the next save uses a new key', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const progress: VisitProgress = {
    meaning: 'recorded',
    measure: { mode: 'scalar_amount', unit: { id: 'chapter', minimum: '0', precision: 0, totalPolicy: 'optional' } },
    rules: { min: '0', step: '1', total: 'optional' },
    session: {
      id: id(8),
      revision: 3,
      amount: '12',
      total: null,
      unit: 'chapter',
      mode: 'scalar_amount',
      state: 'active',
      meaning: 'known',
      recordingState: 'supported',
      unitLabel: 'Chapters',
    },
  };
  recordCalls.length = 0;
  recordResult = { ok: false, reason: 'conflict' };
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(ConfiguredProgressPanel, {
        subjectId: SERIES,
        type: MANGA_SERIES_TYPE,
        locale: 'en',
        release,
        progress,
        credential: 'csrf',
        current: () => true,
        onAcknowledged() {},
      }),
    );
  });
  const save = [...host.querySelectorAll('button')].find((button) => button.textContent === m.library_configured_record_progress());
  expect(save).toBeDefined();
  await act(async () => {
    (save as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(host.textContent).toContain(m.library_configured_conflict());
  expect((host.querySelector('input') as HTMLInputElement | null)?.value).toBe('12');
  const firstKey = (recordCalls[0] as { data: { idempotencyKey: string } }).data.idempotencyKey;
  recordResult = {
    ok: true,
    session: { id: id(8), revision: 4, amount: '12' },
  };
  await act(async () => {
    (save as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(recordCalls).toHaveLength(2);
  expect((recordCalls[1] as { data: { idempotencyKey: string } }).data.idempotencyKey).not.toBe(firstKey);
  expect((recordCalls[1] as { data: { sessionId: string; revision: number; amount: string } }).data).toMatchObject({
    sessionId: id(8),
    revision: 3,
    amount: '12',
  });
  await act(async () => {
    root.unmount();
  });
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  for (const [key, descriptor] of previous)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

test('owner populations 32, 256 and 2048 keep three native calls and page-bounded work for the selected series', async () => {
  const selected = {
    copies: [copyRow(900, SERIES, 'physical'), copyRow(901, SERIES, 'digital')],
    sessions: [sessionRow(900, SERIES, '12', 'chapter')],
    entryState: 'series-reading' as const,
  };
  const seriesCaps = readConfiguredProfileCapabilities(release, MANGA_SERIES_TYPE, 'en');
  expect(seriesCaps.state).toBe('ready');
  const fields = seriesCaps.state === 'ready' ? seriesCaps.admittedFields : 0;
  const observed: { n: number; nativeCallCount: number; valuesProcessed: number; bytesRetained: number; pageRows: number }[] =
    [];
  for (const n of [32, 256, 2048]) {
    const loaded = await visit(MANGA_SERIES_TYPE, SERIES, populate(n, selected));
    expect(loaded.state).toBe('ready');
    if (loaded.state !== 'ready') return;
    expect(loaded.work.nativeCallCount).toBe(CONFIGURED_VISIT_NATIVE_CALLS);
    expect([...loaded.work.nativeCalls].sort()).toEqual(['copies.get', 'libraryEntries.get', 'progressSessions.get']);
    expect(loaded.work.pageRows).toBeLessThanOrEqual(CONFIGURED_PAGE_ROW_CAP);
    expect(loaded.work.valuesProcessed).toBe(fields + loaded.work.pageRows);
    expect(loaded.copies.items).toHaveLength(2);
    expect(loaded.progress.meaning === 'recorded' && loaded.progress.session.amount).toBe('12');
    observed.push({
      n,
      nativeCallCount: loaded.work.nativeCallCount,
      valuesProcessed: loaded.work.valuesProcessed,
      bytesRetained: loaded.work.bytesRetained,
      pageRows: loaded.work.pageRows,
    });
  }
  expect(new Set(observed.map((row) => row.nativeCallCount))).toEqual(new Set([3]));
  expect(new Set(observed.map((row) => row.valuesProcessed)).size).toBe(1);
  expect(new Set(observed.map((row) => row.bytesRetained)).size).toBe(1);
  const empty = await visit(MANGA_SERIES_TYPE, SERIES, populate(2048, { copies: [], sessions: [] }));
  expect(empty.state === 'ready' && empty.work.nativeCallCount).toBe(3);
  expect(empty.state === 'ready' && empty.work.pageRows).toBe(0);
  expect(empty.state === 'ready' && empty.work.valuesProcessed).toBe(fields);
  const deep = await visit(MANGA_SERIES_TYPE, SERIES, populate(2048, selected), { copyCursor: '1' });
  expect(deep.state === 'ready' && deep.work.nativeCallCount).toBe(3);
  expect(deep.state === 'ready' && deep.copies.items).toHaveLength(1);
  const replaced = await visit(
    MANGA_SERIES_TYPE,
    SERIES,
    populate(2048, {
      copies: [copyRow(50, SERIES, 'digital')],
      sessions: [sessionRow(50, SERIES, '1', 'chapter')],
      entryState: 'series-completed',
    }),
  );
  expect(replaced.state === 'ready' && replaced.work.nativeCallCount).toBe(3);
  expect(replaced.state === 'ready' && replaced.copies.items.map((item) => item.id)).toEqual([id(150)]);
});
