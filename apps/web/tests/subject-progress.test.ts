import { expect, mock, test } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { KernelClient } from '@rezics/client';
import type { LibraryProfile } from '@rezics/definitions';
import type { Release } from '../src/subject/definitions';
import type { ConfiguredLibraryVisit } from '../src/library/configured-profile-controls/visit';
import * as start from '../.storybook/react-start';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const VN = 'wd:Q689445';
const ANIME = 'schema:TVSeries';
const BOOK = 'schema:Book';
const PERSON = 'schema:Person';
const SUBJECT = id(1);

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
mock.module('../src/library/progress-server', () => ({
  startProgressSession: async () => ({ ok: false, reason: 'unavailable' }),
  recordProgressSession: async () => ({ ok: false, reason: 'unavailable' }),
}));
mock.module('../src/library/configured-profile-controls/actions', () => ({
  readConfiguredLibraryVisit: async () => ({ state: 'unavailable', work: { nativeCallCount: 0 } }),
  readConfiguredProgressHistory: async () => ({ signedIn: false, idempotencyKey: id(9) }),
}));

const { loadConfiguredLibraryVisit } = await import('../src/library/configured-profile-controls/visit');
const { readConfiguredProfileCapabilities } =
  await import('../src/library/configured-profile-controls/capabilities');
const { ConfiguredProfileControls } = await import('../src/library/configured-profile-controls/view');
const { m } = await import('../src/paraglide/messages.js');

function unit(unitId: string, extra: Record<string, unknown> = {}) {
  return {
    id: unitId,
    labels: { en: unitId },
    minimum: '0',
    identity: { kind: 'none' as const },
    structure: { kind: 'none' as const },
    ...extra,
  };
}

function profile(profileId: string, unitId: string, extra: Record<string, unknown> = {}): LibraryProfile {
  return {
    id: profileId,
    entryStateSet: {
      id: `${profileId}-states`,
      states: [
        { id: 'planned', labels: { en: 'Planned' }, role: 'planned' },
        { id: 'in_progress', labels: { en: 'In progress' }, role: 'active' },
      ],
    },
    progress: { allowed: [{ mode: 'scalar_amount', units: [unit(unitId, extra)] }] },
    copies: { kinds: [] },
    importSources: [],
  };
}

const release = {
  types: {
    [VN]: { library: { profileId: 'visual-novel.reading' } },
    [ANIME]: { library: { profileId: 'anime.series' } },
    [BOOK]: { library: { profileId: 'book.reading' } },
    [PERSON]: {},
  },
  properties: {},
  libraryProfiles: {
    'visual-novel.reading': profile('visual-novel.reading', 'percent', { maximum: '100', dimension: 'percent' }),
    'anime.series': profile('anime.series', 'episode'),
    'book.reading': profile('book.reading', 'page'),
  },
} as unknown as Release;

function kernel(sessions: { id: string; subjectId: string; unit: string; amount: string | null }[]): KernelClient {
  return {
    libraryEntries: ({ subjectId }: { subjectId: string }) => ({
      get: async () =>
        subjectId === SUBJECT
          ? {
              status: 200,
              data: { libraryEntry: { subjectId, state: 'in_progress', revision: 2 } },
              error: null,
            }
          : { status: 404, data: null, error: { status: 404 } },
    }),
    copies: {
      get: async () => ({ status: 200, data: { copies: [], next: null }, error: null }),
    },
    progressSessions: {
      get: async () => ({
        status: 200,
        data: {
          progressSessions: sessions.map((session) => ({
            ...session,
            mode: 'scalar_amount' as const,
            total: null,
            state: 'active' as const,
            revision: 3,
            presentation: {
              meaning: 'known' as const,
              structure: 'unverified' as const,
              recording: { state: 'supported' as const, inputRules: { step: 'any', total: 'optional' as const } },
              unitLabel: session.unit,
            },
          })),
          next: null,
        },
        error: null,
      }),
    },
  } as KernelClient;
}

function request() {
  return new Request('https://site.test/en/library', {
    headers: { authorization: 'Bearer owner-token', 'x-csrf-token': 'csrf', 'accept-language': 'en' },
  });
}

function markup(loaded: ConfiguredLibraryVisit, type: string, label: string) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ConfiguredProfileControls, {
        subject: { id: SUBJECT, type, label },
        locale: 'en',
        session: { state: 'signed-in', subject: 'owner-1', csrfToken: 'csrf' },
        returnTo: '/en/subjects/work',
        visit: loaded,
        release,
      }),
    ),
  );
}

test('released VN, anime and book profiles admit their own states and scalar units', () => {
  const vn = readConfiguredProfileCapabilities(release, VN, 'en');
  const anime = readConfiguredProfileCapabilities(release, ANIME, 'en');
  const book = readConfiguredProfileCapabilities(release, BOOK, 'en');
  const person = readConfiguredProfileCapabilities(release, PERSON, 'en');
  expect(vn).toMatchObject({ state: 'ready', identity: null, measure: { mode: 'scalar_amount', unit: { id: 'percent' } } });
  expect(anime).toMatchObject({ state: 'ready', measure: { unit: { id: 'episode' } } });
  expect(book).toMatchObject({ state: 'ready', measure: { unit: { id: 'page' } } });
  expect(vn.state === 'ready' && vn.states.map((state) => state.id)).toEqual(['planned', 'in_progress']);
  expect(person).toMatchObject({ state: 'unsupported', identity: null });
});

test('configured Subject progress renders for VN, anime and book and stays hidden for an unprofiled type', async () => {
  const session = {
    id: id(20),
    subjectId: SUBJECT,
    unit: 'percent',
    amount: '12',
  };
  const vn = await loadConfiguredLibraryVisit(
    kernel([session]),
    request(),
    {},
    { subjectId: SUBJECT, type: VN, locale: 'en' },
    release,
  );
  const anime = await loadConfiguredLibraryVisit(
    kernel([{ ...session, unit: 'episode', amount: '3' }]),
    request(),
    {},
    { subjectId: SUBJECT, type: ANIME, locale: 'en' },
    release,
  );
  const book = await loadConfiguredLibraryVisit(
    kernel([{ ...session, unit: 'page', amount: '40' }]),
    request(),
    {},
    { subjectId: SUBJECT, type: BOOK, locale: 'en' },
    release,
  );
  const person = await loadConfiguredLibraryVisit(
    kernel([]),
    request(),
    {},
    { subjectId: SUBJECT, type: PERSON, locale: 'en' },
    release,
  );
  expect(vn).toMatchObject({
    state: 'ready',
    identity: null,
    entry: { meaning: 'current', state: 'in_progress' },
    progress: { meaning: 'recorded', measure: { unit: { id: 'percent' } } },
  });
  expect(anime.state === 'ready' && anime.progress.meaning === 'recorded' && anime.progress.measure.unit.id).toBe(
    'episode',
  );
  expect(book.state === 'ready' && book.progress.meaning === 'recorded' && book.progress.measure.unit.id).toBe('page');
  expect(person).toMatchObject({ state: 'unsupported', identity: null, work: { nativeCallCount: 0 } });
  const html = markup(vn, VN, 'Clannad');
  expect(html).toContain(m.library_configured_progress_heading());
  expect(html).toContain('percent');
  expect(html).toContain(m.library_progress_open());
  expect(html).toContain(`/en/library/progress/${id(20)}`);
  expect(html).not.toContain(m.library_configured_series());
  expect(markup(person, PERSON, 'A person')).toContain(m.library_configured_unsupported());
  expect(markup(anime, ANIME, 'A series')).toContain('episode');
  expect(markup(book, BOOK, 'A book')).toContain('page');
});
