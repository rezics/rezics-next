import { expect, test } from 'bun:test';
import type { LibraryProfile, Release } from '@rezics/definitions';
import { presentCopy } from '../../src/library/copy-presentation.ts';
import type { Copy } from '../../src/library/entry-model.ts';
import type { LibraryProfileSource } from '../../src/library/profile-source.ts';

const profile: LibraryProfile = {
  id: 'holdings',
  copies: {
    kinds: [
      {
        id: 'installation',
        labels: { en: 'Installation', 'zh-Hant': '安裝' },
        statuses: [{ id: 'licensed', labels: { en: 'Licensed', 'zh-Hant': '已授權' } }],
      },
    ],
  },
};
const pin = {
  provenance: 'profile',
  releaseDigest: 'accepted',
  acceptingType: 'ex:Game',
  profileId: 'holdings',
} as const;
const copy: Copy = {
  id: 'copy',
  accountId: 'owner',
  subjectId: 'game',
  kind: 'installation',
  status: 'licensed',
  revision: 1,
  location: 'Study',
  source: 'Shop',
  acquiredOn: '2026-01-01',
  disposedOn: null,
  note: 'Private',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  transactionId: 'tx',
};
const snapshot = {
  digest: 'accepted',
  release: {
    types: { 'ex:Game': { library: { profileId: 'holdings' } } },
    libraryProfiles: { holdings: profile },
  } as unknown as Release,
};
const source: NonNullable<LibraryProfileSource> = {
  kind: 'supported',
  subjectId: 'game',
  requestedSubjectId: null,
  component: { partition: 0, epoch: 1, position: 1n },
  pin,
  profile,
};

test('exact accepted labels survive a current rename while current native status choices use their own actual language', () => {
  const current: LibraryProfile = {
    id: 'holdings',
    copies: {
      kinds: [
        {
          id: 'installation',
          labels: { en: 'New kind' },
          statuses: [
            { id: 'licensed', labels: { en: 'Current label' } },
            { id: 'archived', labels: { en: 'Archived' } },
          ],
        },
      ],
    },
  };
  const before = structuredClone(copy);
  expect(
    presentCopy({ copy, pin }, snapshot, { ...source, kind: 'supported', profile: current }, ['zh-Hant-TW']),
  ).toEqual({
    meaning: 'known',
    kindLabel: '安裝',
    kindLabelLanguage: 'zh-Hant',
    statusLabel: '已授權',
    statusLabelLanguage: 'zh-Hant',
    statusEditing: {
      state: 'supported',
      statuses: [
        { id: 'licensed', label: 'Current label', labelLanguage: 'en' },
        { id: 'archived', label: 'Archived', labelLanguage: 'en' },
      ],
    },
  });
  expect(copy).toEqual(before);
});

test('missing exact release is unavailable, readable retirement is unsupported, and failed current evidence is unavailable', () => {
  expect(presentCopy({ copy, pin }, null, source)).toEqual({
    meaning: 'unavailable',
    statusEditing: { state: 'unavailable' },
  });
  expect(presentCopy({ copy, pin }, { ...snapshot, digest: 'different' }, source).meaning).toBe('unavailable');
  const retired = { ...source, kind: 'unsupported', acceptingType: 'ex:Game' } as const;
  expect(presentCopy({ copy, pin }, snapshot, retired)).toMatchObject({
    meaning: 'known',
    kindLabel: 'Installation',
    statusEditing: { state: 'unsupported' },
  });
  expect(
    presentCopy({ copy, pin }, snapshot, { ...source, kind: 'supported', profile: { id: 'empty' } }).statusEditing,
  ).toEqual({ state: 'unsupported' });
  expect(presentCopy({ copy, pin }, snapshot, null)).toMatchObject({
    meaning: 'known',
    statusLabel: 'Licensed',
    statusEditing: { state: 'unavailable' },
  });
});

test('unknown and unspecified historic holdings retain raw provenance without fabricated labels or current fallback', () => {
  for (const raw of [
    { ...copy, kind: 'unknown' },
    { ...copy, status: 'unknown' },
    { ...copy, kind: 'legacy-unspecified' },
    { ...copy, kind: null },
  ]) {
    const before = structuredClone(raw);
    expect(presentCopy({ copy: raw, pin }, snapshot, source)).toEqual({
      meaning: 'unknown',
      statusEditing: { state: 'unsupported' },
    });
    expect(raw).toEqual(before);
  }
  expect(presentCopy({ copy, pin: null }, snapshot, source)).toEqual({
    meaning: 'unknown',
    statusEditing: { state: 'unavailable' },
  });
  const result = JSON.stringify(presentCopy({ copy, pin }, snapshot, source));
  for (const secret of [
    'releaseDigest',
    'acceptingType',
    'profileId',
    'provenance',
    'pin',
    'accountId',
    'transactionId',
  ])
    expect(result).not.toContain(secret);
});
