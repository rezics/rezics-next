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
const notRecordedConditions = {
  mediaCondition: { state: 'not_recorded' },
  packagingCondition: { state: 'not_recorded' },
  conditionEditing: expect.objectContaining({ state: 'unavailable' }),
} as const;

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
    presentCopy({ copy, kindPin: pin, statusPin: pin }, snapshot, { ...source, kind: 'supported', profile: current }, [
      'zh-Hant-TW',
    ]),
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
    ...notRecordedConditions,
  });
  expect(copy).toEqual(before);
});

test('missing exact release is unavailable, readable retirement is unsupported, and failed current evidence is unavailable', () => {
  expect(presentCopy({ copy, kindPin: pin, statusPin: pin }, null, source)).toEqual({
    meaning: 'unavailable',
    statusEditing: { state: 'unavailable' },
    ...notRecordedConditions,
  });
  expect(
    presentCopy({ copy, kindPin: pin, statusPin: pin }, { ...snapshot, digest: 'different' }, source).meaning,
  ).toBe('unavailable');
  const retired = { ...source, kind: 'unsupported', acceptingType: 'ex:Game' } as const;
  expect(presentCopy({ copy, kindPin: pin, statusPin: pin }, snapshot, retired)).toMatchObject({
    meaning: 'known',
    kindLabel: 'Installation',
    statusEditing: { state: 'unsupported' },
    ...notRecordedConditions,
  });
  expect(
    presentCopy({ copy, kindPin: pin, statusPin: pin }, snapshot, {
      ...source,
      kind: 'supported',
      profile: { id: 'empty' },
    }).statusEditing,
  ).toEqual({ state: 'unsupported' });
  expect(presentCopy({ copy, kindPin: pin, statusPin: pin }, snapshot, null)).toMatchObject({
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
    expect(presentCopy({ copy: raw, kindPin: pin, statusPin: pin }, snapshot, source)).toEqual({
      meaning: 'unknown',
      statusEditing: { state: 'unsupported' },
      ...notRecordedConditions,
    });
    expect(raw).toEqual(before);
  }
  expect(presentCopy({ copy, kindPin: null, statusPin: null }, snapshot, source)).toEqual({
    meaning: 'unknown',
    statusEditing: { state: 'unavailable' },
    ...notRecordedConditions,
  });
  const result = JSON.stringify(presentCopy({ copy, kindPin: pin, statusPin: pin }, snapshot, source));
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

test('original kind and explicitly accepted newer status resolve separate exact releases', () => {
  const statusPin = { ...pin, releaseDigest: 'new-status' };
  const statusProfile: LibraryProfile = {
    id: profile.id,
    copies: {
      kinds: [
        {
          id: 'installation',
          labels: { en: 'Renamed kind' },
          statuses: [{ id: 'archived', labels: { en: 'Archived', fr: 'Archivée' } }],
        },
      ],
    },
  };
  const statusSnapshot = {
    digest: statusPin.releaseDigest,
    release: { ...snapshot.release, libraryProfiles: { holdings: statusProfile } },
  };
  const fact = { copy: { ...copy, status: 'archived' }, kindPin: pin, statusPin };
  const current = { ...source, kind: 'supported', pin: statusPin, profile: statusProfile } as const;
  expect(presentCopy(fact, snapshot, current, ['zh-Hant', 'fr'], statusSnapshot)).toEqual({
    meaning: 'known',
    kindLabel: '安裝',
    kindLabelLanguage: 'zh-Hant',
    statusLabel: 'Archivée',
    statusLabelLanguage: 'fr',
    statusEditing: { state: 'supported', statuses: [{ id: 'archived', label: 'Archivée', labelLanguage: 'fr' }] },
    ...notRecordedConditions,
  });
  expect(
    presentCopy(fact, snapshot, { ...current, subjectId: 'other-source' }, [], statusSnapshot).statusEditing,
  ).toEqual({ state: 'unavailable' });
  expect(presentCopy(fact, snapshot, current, [], null)).toEqual({
    meaning: 'unavailable',
    statusEditing: { state: 'unavailable' },
    ...notRecordedConditions,
  });
  expect(presentCopy(fact, null, current, [], statusSnapshot)).toEqual({
    meaning: 'unavailable',
    statusEditing: { state: 'unavailable' },
    ...notRecordedConditions,
  });
  // The old shared mutable pin supplies no creation proof, even when status resolves exactly.
  expect(presentCopy({ ...fact, kindPin: null }, null, current, [], statusSnapshot)).toEqual({
    meaning: 'unknown',
    statusEditing: { state: 'unavailable' },
    ...notRecordedConditions,
  });
});
