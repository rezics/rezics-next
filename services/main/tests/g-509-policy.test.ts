import { expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { Value } from 'typebox/value';
import { capabilityPath } from '../src/modules/target/contract.ts';
import { assessment, readAssessment, command } from '../src/modules/suitability/contract.ts';
import {
  atLeastAsRestrictive,
  eligible,
  validLabels,
  UNASSESSED,
  type Age,
  type Assessment,
  type Channel,
  type Labels,
  type RealmCeiling,
  type Viewer,
} from '../src/modules/suitability/policy.ts';

const labelSets: Labels[] = [[], ['r15'], ['r18'], ['r18g'], ['r18', 'r18g']];
const ages: Age[] = ['unknown', 'under-15', '15-17', 'adult'];
const channels: Channel[] = ['read', 'index', 'preview', 'email', 'push'];
const countries = [
  null,
  '',
  'unknown',
  'XX',
  'ZZ',
  'QQ',
  'EU',
  'UK',
  'US',
  'JP',
  'TW',
  'SG',
  'FR',
  'KR',
  'GB',
  'gb',
];
const optIns = [false, true].flatMap((sexual) =>
  [false, true].map((grotesque) => ({ sexual, grotesque })),
);
const ceilings: RealmCeiling[] = ['general', 'r15', 'adult'].flatMap((maxAge) =>
  optIns.map((options) => ({ maxAge: maxAge as RealmCeiling['maxAge'], ...options })),
);
const viewers = [false, true].flatMap((signedIn) =>
  ages.flatMap((age) =>
    countries.flatMap((country) =>
      optIns.map((options) => ({ signedIn, age, country, optIns: options })),
    ),
  ),
);

/** Independent truth table uses the audiences admitted by each assessment. */
function expected(
  labels: Labels,
  viewer: Viewer,
  channel: Channel,
  ceiling?: RealmCeiling,
): boolean {
  if (!labels.length) return true;
  if (channel === 'index' || channel === 'preview' || !viewer.signedIn) return false;
  if (!['US', 'JP', 'TW', 'SG', 'FR', 'KR', 'GB', 'gb'].includes(viewer.country ?? ''))
    return false;
  if (labels[0] === 'r15')
    return ['15-17', 'adult'].includes(viewer.age) && ceiling?.maxAge !== 'general';
  const allowedCountries = ['US', 'JP', 'TW', 'SG', 'FR'];
  const permittedChannels: Channel[] = ['read'];
  const permissions = {
    r18: viewer.optIns.sexual && (!ceiling || (ceiling.maxAge === 'adult' && ceiling.sexual)),
    r18g:
      viewer.optIns.grotesque && (!ceiling || (ceiling.maxAge === 'adult' && ceiling.grotesque)),
  };
  return (
    viewer.age === 'adult' &&
    allowedCountries.includes(viewer.country ?? '') &&
    permittedChannels.includes(channel) &&
    labels.every((label) => permissions[label as keyof typeof permissions])
  );
}

test('G-509: policy truth table covers every label, age, opt-in, country, channel and Realm ceiling', () => {
  for (const labels of labelSets)
    for (const viewer of viewers)
      for (const channel of channels)
        for (const realmCeiling of [undefined, ...ceilings]) {
          const input = {
            assessment: { status: 'assessed', labels } as Assessment,
            viewer,
            channel,
            realmCeiling,
          };
          const result = eligible(input);
          if (result.eligible !== expected(labels, viewer, channel, realmCeiling)) {
            throw new Error(`Truth table mismatch: ${JSON.stringify({ input, result })}`);
          }
          expect(result.reasons.length === 0).toBe(result.eligible);
        }
});

test('G-509: unassessed is admitted on every channel and always labelled Not assessed', () => {
  for (const viewer of viewers)
    for (const channel of channels)
      for (const realmCeiling of [undefined, ...ceilings]) {
        expect(
          eligible({ assessment: { status: 'unassessed' }, viewer, channel, realmCeiling }),
        ).toEqual({ eligible: true, reasons: [] });
      }
  expect(Value.Check(assessment, UNASSESSED)).toBe(true);
  expect(Value.Check(readAssessment, UNASSESSED)).toBe(true);
  expect(Value.Check(assessment, { status: 'unassessed' })).toBe(false);
  expect(Value.Check(assessment, { ...UNASSESSED, displayLabel: 'General' })).toBe(false);
  expect(Value.Check(assessment, { ...UNASSESSED, labels: [] })).toBe(false);
  expect(Value.Check(assessment, { status: 'general' })).toBe(false);
});

test('G-509: reads can redact an assessor while command results retain it', () => {
  const value = {
    status: 'assessed',
    revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    predecessor: null,
    labels: [],
    basis: 'platform',
    sourceId: null,
    assessor: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const { assessor: _assessor, ...redacted } = value;
  expect(Value.Check(assessment, value)).toBe(true);
  expect(Value.Check(readAssessment, value)).toBe(true);
  expect(Value.Check(assessment, redacted)).toBe(false);
  expect(Value.Check(readAssessment, redacted)).toBe(true);
});

test('G-509: independent adult opt-ins and machine-readable denial reasons', () => {
  const viewer: Viewer = {
    signedIn: true,
    age: 'adult',
    country: 'US',
    optIns: { sexual: true, grotesque: false },
  };
  const assessment: Assessment = { status: 'assessed', labels: ['r18', 'r18g'] };
  expect(eligible({ assessment, viewer, channel: 'read' })).toEqual({
    eligible: false,
    reasons: ['grotesque_opt_in_required'],
  });
  expect(
    eligible({
      assessment,
      viewer: { ...viewer, optIns: { sexual: false, grotesque: true } },
      channel: 'read',
    }),
  ).toEqual({ eligible: false, reasons: ['sexual_opt_in_required'] });
  expect(
    eligible({
      assessment: { status: 'assessed', labels: ['r15'] },
      viewer: { ...viewer, age: 'unknown' },
      channel: 'read',
    }),
  ).toEqual({ eligible: false, reasons: ['age_unknown'] });
  expect(
    eligible({
      assessment,
      viewer: { ...viewer, country: 'KR', optIns: { sexual: true, grotesque: true } },
      channel: 'read',
    }),
  ).toEqual({ eligible: false, reasons: ['market_restricted'] });
  expect(
    eligible({
      assessment,
      viewer: { ...viewer, optIns: { sexual: true, grotesque: true } },
      channel: 'push',
    }),
  ).toEqual({ eligible: false, reasons: ['channel_restricted'] });
});

test('G-509: property — adding a ceiling or strengthening labels never widens eligibility', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...viewers),
      fc.constantFrom(...channels),
      fc.constantFrom(...labelSets),
      fc.constantFrom(...labelSets),
      fc.constantFrom(...ceilings),
      fc.constantFrom(...ceilings),
      (viewer, channel, labels, stronger, realmCeiling, stricterCeiling) => {
        const base = eligible({ assessment: { status: 'assessed', labels }, viewer, channel });
        const narrowed = eligible({
          assessment: { status: 'assessed', labels },
          viewer,
          channel,
          realmCeiling,
        });
        expect(!narrowed.eligible || base.eligible).toBe(true);
        const ranks = { general: 0, r15: 1, adult: 2 };
        if (
          ranks[stricterCeiling.maxAge] <= ranks[realmCeiling.maxAge] &&
          (!stricterCeiling.sexual || realmCeiling.sexual) &&
          (!stricterCeiling.grotesque || realmCeiling.grotesque)
        ) {
          const tightened = eligible({
            assessment: { status: 'assessed', labels },
            viewer,
            channel,
            realmCeiling: stricterCeiling,
          });
          expect(!tightened.eligible || narrowed.eligible).toBe(true);
        }
        if (atLeastAsRestrictive(stronger, labels)) {
          const changed = eligible({
            assessment: { status: 'assessed', labels: stronger },
            viewer,
            channel,
            realmCeiling,
          });
          expect(!changed.eligible || narrowed.eligible).toBe(true);
        }
      },
    ),
    { seed: 509, numRuns: 10_000 },
  );
});

test('G-509: the schema and policy accept exactly one canonical label vocabulary', () => {
  const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  expect(capabilityPath(actor, 'suitability')).toBe(
    '/v1/suitability/00000000-0000-4000-8000-000000000001',
  );
  for (const labels of [
    ...labelSets,
    ['general'],
    ['r15', 'r18'],
    ['r18g', 'r18'],
    ['r18', 'r18'],
    ['unknown'],
  ]) {
    expect(
      Value.Check(command, {
        actingSubject: actor,
        expectedRevision: null,
        labels,
        basis: 'author',
      }),
    ).toBe(validLabels(labels));
  }
  expect(atLeastAsRestrictive(['r18g'], ['r18'])).toBe(false);
  expect(atLeastAsRestrictive(['r18'], ['r18g'])).toBe(false);
  expect(atLeastAsRestrictive(['r18', 'r18g'], ['r18'])).toBe(true);
});
