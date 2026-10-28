import { expect, mock, test } from 'bun:test';
import type { LibraryProfile } from '@rezics/definitions';
import type { Release } from '../src/subject/definitions.ts';
import {
  libraryChoices,
  libraryCopyKindLabel,
  libraryCopyStatusLabel,
  libraryProfile,
  libraryStateLabel,
  libraryStateRole,
  libraryUnitLabel,
} from '../src/library/profiles.ts';

const legacyStates = [
  { id: 'planned', labels: { en: 'Planned', ja: '予定' }, role: 'planned' },
  { id: 'in_progress', labels: { en: 'In progress', ja: '進行中' }, role: 'active' },
  { id: 'completed', labels: { en: 'Completed', ja: '完了' }, role: 'completed' },
  { id: 'paused', labels: { en: 'Paused', ja: '一時停止' }, role: 'paused' },
  { id: 'dropped', labels: { en: 'Dropped', ja: '中止' }, role: 'dropped' },
] as const;

const legacyUnits = ['page', 'chapter', 'episode', 'volume', 'minute', 'percent'] as const;
const legacyModes = ['scalar_amount', 'cursor_position', 'completed_units'] as const;
const legacyProfile: LibraryProfile = {
  id: 'legacy-fixed-v1',
  entryStateSet: { id: 'legacy-five', states: [...legacyStates] },
  progress: {
    allowed: legacyModes.map((mode) => ({
      mode,
      units: legacyUnits.map((id) => ({
        id,
        labels: { en: `${mode} ${id}`, ja: `${mode} ${id} 日本語` },
        minimum: '0',
        ...(mode === 'scalar_amount' && id === 'percent' ? { maximum: '100' } : {}),
        ...(mode === 'scalar_amount' ? { totalPolicy: 'optional' as const } : { totalPolicy: 'forbidden' as const }),
        identity: { kind: mode === 'completed_units' ? ('session_local' as const) : ('none' as const) },
        structure: { kind: 'none' as const },
      })),
    })),
  },
  copies: {
    kinds: [
      {
        id: 'legacy-unspecified',
        labels: { en: 'Unspecified copy', ja: '不明な所蔵' },
        statuses: ['ordered', 'owned', 'lent', 'disposed'].map((id) => ({
          id,
          labels: { en: id, ja: `${id} 日本語` },
        })),
      },
    ],
  },
  importSources: [],
};

const currentProfile: LibraryProfile = {
  id: 'reading-v2',
  entryStateSet: {
    id: 'reading-states',
    states: [
      { id: 'queued-now', labels: { en: 'Queued now', fr: 'À lire' }, role: 'planned' },
      { id: 'completed', labels: { en: 'Finished in this profile', fr: 'Terminé ici' } },
    ],
  },
  progress: {
    allowed: [
      {
        mode: 'completed_units',
        units: [
          {
            id: 'folio',
            labels: { en: 'Folio', fr: 'Feuillet' },
            minimum: '0.00',
            maximum: '12.5000',
            precision: 2,
            totalPolicy: 'forbidden',
            identity: { kind: 'session_local' },
            structure: { kind: 'none' },
          },
          {
            id: 'leaf',
            labels: { en: 'Leaf', fr: 'Feuille' },
            minimum: '1',
            maximum: '999.125',
            precision: 3,
            totalPolicy: 'forbidden',
            identity: { kind: 'session_local' },
            structure: { kind: 'none' },
          },
        ],
      },
      {
        mode: 'scalar_amount',
        units: [
          {
            id: 'leaf',
            labels: { en: 'Leaf amount', fr: 'Feuilles lues' },
            minimum: '0',
            maximum: '1.20',
            precision: 1,
            totalPolicy: 'required',
            identity: { kind: 'none' },
            structure: { kind: 'none' },
          },
        ],
      },
    ],
  },
  copies: {
    kinds: [
      {
        id: 'ebook-copy',
        labels: { en: 'E-book', fr: 'Livre numérique' },
        statuses: [
          { id: 'available-here', labels: { en: 'Available here', fr: 'Disponible ici' } },
          { id: 'ordered', labels: { en: 'Ordered in this profile', fr: 'Commandé ici' } },
        ],
      },
      {
        id: 'audio-copy',
        labels: { en: 'Audio copy' },
        statuses: [{ id: 'owned', labels: { en: 'Owned audio' } }],
      },
    ],
  },
  importSources: [{ id: 'catalog-one', mappingVersion: 'v1', recordKinds: ['volume'] }],
};

const release = {
  types: {
    'schema:Novel': { bases: ['schema:Thing'], library: { profileId: 'reading-v2' } },
    'schema:Edition': { bases: [], library: { profileId: 'legacy-fixed-v1' } },
    'schema:Unconfigured': { bases: ['schema:Novel'] },
    'schema:MissingProfile': { library: { profileId: 'not-in-registry' } },
  },
  properties: {},
  libraryProfiles: {
    'reading-v2': currentProfile,
    'legacy-fixed-v1': legacyProfile,
  },
} as unknown as Release;

test("a subject's library profile is the active release's libraryProfiles entry named by its type's library reference, and a type without a reference, or a reference to a missing profile, has none", () => {
  expect(libraryProfile(release, 'schema:Novel')).toBe(currentProfile);
  expect(libraryProfile(release, 'schema:Edition')).toBe(legacyProfile);
  expect(libraryProfile(release, 'schema:Unconfigured')).toBeUndefined();
  expect(libraryProfile(release, 'schema:MissingProfile')).toBeUndefined();
  expect(libraryProfile(release, 'schema:Unknown')).toBeUndefined();
});

test('stored IDs resolve in the current profile, then legacy-fixed-v1, and labels report the selected language', () => {
  expect(libraryStateLabel(release, 'schema:Novel', 'queued-now', 'fr-CA')).toEqual({ text: 'À lire', lang: 'fr' });
  expect(libraryStateLabel(release, 'schema:Novel', 'completed', 'fr')).toEqual({
    text: 'Terminé ici',
    lang: 'fr',
  });
  expect(libraryStateLabel(release, 'schema:Novel', 'planned', 'ja-JP')).toEqual({ text: '予定', lang: 'ja' });
  expect(libraryStateLabel(release, 'schema:Novel', 'not-a-state', 'en')).toBeUndefined();
  expect(libraryStateRole(release, 'schema:Novel', 'queued-now')).toBe('planned');
  expect(libraryStateRole(release, 'schema:Novel', 'completed')).toBeUndefined();
  expect(libraryStateRole(release, 'schema:Novel', 'in_progress')).toBe('active');
  expect(libraryStateRole(release, 'schema:Novel', 'not-a-state')).toBeUndefined();

  expect(libraryCopyKindLabel(release, 'schema:Novel', 'ebook-copy', 'fr')).toEqual({
    text: 'Livre numérique',
    lang: 'fr',
  });
  expect(libraryCopyKindLabel(release, 'schema:Novel', 'legacy-unspecified', 'ja')).toEqual({
    text: '不明な所蔵',
    lang: 'ja',
  });
  expect(libraryCopyKindLabel(release, 'schema:Novel', 'unknown-kind', 'en')).toBeUndefined();
  expect(libraryCopyStatusLabel(release, 'schema:Novel', 'ebook-copy', 'available-here', 'fr')).toEqual({
    text: 'Disponible ici',
    lang: 'fr',
  });
  expect(libraryCopyStatusLabel(release, 'schema:Novel', 'ebook-copy', 'ordered', 'fr')).toEqual({
    text: 'Commandé ici',
    lang: 'fr',
  });
  expect(libraryCopyStatusLabel(release, 'schema:Novel', 'legacy-unspecified', 'owned', 'ja')).toEqual({
    text: 'owned 日本語',
    lang: 'ja',
  });
  expect(libraryCopyStatusLabel(release, 'schema:Novel', 'ebook-copy', 'owned', 'en')).toBeUndefined();
  expect(libraryCopyStatusLabel(release, 'schema:Novel', 'legacy-unspecified', 'unknown-status', 'en')).toBeUndefined();

  expect(libraryUnitLabel(release, 'schema:Novel', 'scalar_amount', 'leaf', 'fr')).toEqual({
    text: 'Feuilles lues',
    lang: 'fr',
  });
  expect(libraryUnitLabel(release, 'schema:Novel', 'cursor_position', 'page', 'ja-JP')).toEqual({
    text: 'cursor_position page 日本語',
    lang: 'ja',
  });
  expect(libraryUnitLabel(release, 'schema:Novel', 'completed_units', 'not-a-unit', 'en')).toBeUndefined();
  expect(libraryUnitLabel(release, 'schema:Unconfigured', 'scalar_amount', 'page', 'en')).toBeUndefined();
});

test("a profile's choices preserve its declaration order and exact progress metadata", () => {
  const choices = libraryChoices(release, 'schema:Novel');
  expect(choices).toEqual({
    states: [{ id: 'queued-now', role: 'planned' }, { id: 'completed' }],
    copyKinds: [
      { id: 'ebook-copy', statuses: ['available-here', 'ordered'] },
      { id: 'audio-copy', statuses: ['owned'] },
    ],
    progress: [
      {
        mode: 'completed_units',
        units: [
          { id: 'folio', minimum: '0.00', maximum: '12.5000', precision: 2, totalPolicy: 'forbidden' },
          { id: 'leaf', minimum: '1', maximum: '999.125', precision: 3, totalPolicy: 'forbidden' },
        ],
      },
      {
        mode: 'scalar_amount',
        units: [{ id: 'leaf', minimum: '0', maximum: '1.20', precision: 1, totalPolicy: 'required' }],
      },
    ],
  });
  expect(libraryChoices(release, 'schema:Unconfigured')).toBeUndefined();
});

test('resolving profiles for one hundred subjects of five types reads the active release once and the release once', async () => {
  const digest = 'library-profiles-growth-release';
  const reads = { active: 0, release: 0 };
  const responseRelease = {
    types: Object.fromEntries(
      ['schema:Novel', 'schema:Edition', 'schema:Unconfigured', 'schema:MissingProfile', 'schema:Other'].map((type) => [
        type,
        { library: { profileId: type === 'schema:Novel' ? 'reading-v2' : 'legacy-fixed-v1' } },
      ]),
    ),
    properties: {},
    libraryProfiles: release.libraryProfiles,
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/definitions/active') {
        reads.active++;
        return Response.json({ digest });
      }
      if (url.pathname === `/v1/definitions/releases/${digest}`) {
        reads.release++;
        return Response.json({ digest, release: responseRelease });
      }
      return new Response(null, { status: 404 });
    },
  });

  mock.module('../src/kernel/client.ts', () => ({ requestLocale: () => 'en' }));
  mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: server.url.origin } }));
  try {
    const { readRelease } = await import('../src/subject/definitions.ts');
    const activeRelease = await readRelease();
    const types = ['schema:Novel', 'schema:Edition', 'schema:Unconfigured', 'schema:MissingProfile', 'schema:Other'];
    const subjects = Array.from({ length: 100 }, (_, index) => ({ type: types[index % types.length]! }));
    expect(subjects.map(({ type }) => libraryProfile(activeRelease, type)?.id)).toHaveLength(100);
    expect(reads).toEqual({ active: 1, release: 1 });
  } finally {
    server.stop(true);
  }
});
