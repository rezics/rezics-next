import { expect, test } from 'bun:test';
import type { LibraryProfile, Release } from '@rezics/definitions';
import { presentProgressSession } from '../../src/library/progress-presentation.ts';
import type { ProgressSession } from '../../src/library/progress-model.ts';
import type { LibraryProfileSource } from '../../src/library/profile-source.ts';

const unit = {
  id: 'page',
  labels: { en: 'leaf' },
  countForms: { en: { one: '{count} leaf', other: '{count} leaves' } },
  minimum: '0',
  maximum: '1000',
  precision: 2,
  totalPolicy: 'optional',
  dimension: 'pages',
  identity: { kind: 'none' },
  structure: { kind: 'none' },
} as const;
const profile: LibraryProfile = { id: 'reading', progress: { allowed: [{ mode: 'scalar_amount', units: [unit] }] } };
const pin = {
  provenance: 'profile',
  releaseDigest: 'original',
  acceptingType: 'ex:Book',
  profileId: 'reading',
} as const;
const session: ProgressSession = {
  id: 'session',
  accountId: 'owner',
  subjectId: 'book',
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'page',
  total: '999',
  amount: '950',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 2,
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  transactionId: 'transaction',
};
const snapshot = {
  digest: 'original',
  release: {
    types: { 'ex:Book': { library: { profileId: 'reading' } } },
    libraryProfiles: { reading: profile },
  } as unknown as Release,
};
const source: NonNullable<LibraryProfileSource> = {
  kind: 'supported',
  subjectId: 'book',
  requestedSubjectId: null,
  component: { partition: 0, epoch: 1, position: 1n },
  pin,
  profile,
};

test('exact accepted label and count forms survive current rename and narrowed rules without converting total or value', () => {
  const current: LibraryProfile = {
    ...profile,
    progress: { allowed: [{ mode: 'scalar_amount', units: [{ ...unit, labels: { en: 'new page' }, maximum: '10' }] }] },
  };
  const before = structuredClone(session);
  expect(
    presentProgressSession({ session, pin }, snapshot, { ...source, kind: 'supported', profile: current }),
  ).toEqual({
    meaning: 'known',
    unitLabel: 'leaf',
    unitLabelLanguage: 'en',
    unitCountForms: unit.countForms.en,
    dimension: 'pages',
    structure: 'unverified',
    recording: { state: 'supported', inputRules: { min: '0', max: '10', step: '0.01', total: 'optional' } },
  });
  expect(session).toEqual(before);
});

test('missing required original release differs from current pair absence and transient or hidden evidence', () => {
  expect(presentProgressSession({ session, pin }, null, source)).toEqual({
    meaning: 'unavailable',
    structure: 'unverified',
    recording: { state: 'unavailable' },
  });
  const absent = { ...source, kind: 'unsupported', acceptingType: 'ex:Book' } as const;
  expect(presentProgressSession({ session, pin }, snapshot, absent)).toMatchObject({
    meaning: 'known',
    unitLabel: 'leaf',
    recording: { state: 'unsupported' },
  });
  expect(presentProgressSession({ session, pin }, snapshot, null)).toMatchObject({
    meaning: 'known',
    recording: { state: 'unavailable' },
  });
  const changed: LibraryProfile = {
    ...profile,
    progress: { allowed: [{ mode: 'scalar_amount', units: [{ ...unit, dimension: 'duration' }] }] },
  };
  expect(
    presentProgressSession({ session, pin }, snapshot, { ...source, kind: 'supported', profile: changed }).recording,
  ).toEqual({ state: 'unsupported' });
});

test('raw unknown units and unpinned history acquire no current label, count, cursor conversion or legacy fallback', () => {
  for (const raw of [
    { ...session, unit: 'unknown', total: '123.456789' },
    { ...session, mode: 'completed_units' as const, unit: 'unknown', completedUnitCount: 3, total: null },
    {
      ...session,
      mode: 'cursor_position' as const,
      unit: 'unknown',
      locator: 'opaque:1:3:7',
      position: '7',
      total: null,
    },
  ]) {
    const before = structuredClone(raw);
    const result = presentProgressSession({ session: raw, pin }, snapshot, source);
    expect(result).toEqual({ meaning: 'unknown', structure: 'unverified', recording: { state: 'unsupported' } });
    expect(raw).toEqual(before);
  }
  expect(presentProgressSession({ session, pin: null }, snapshot, source)).toEqual({
    meaning: 'unknown',
    structure: 'unverified',
    recording: { state: 'unavailable' },
  });
  expect(
    presentProgressSession({ session, pin: { ...pin, releaseDigest: 'different' } }, snapshot, source).meaning,
  ).toBe('unavailable');
});
