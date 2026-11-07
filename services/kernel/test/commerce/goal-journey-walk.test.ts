import { expect, test } from 'bun:test';
import {
  FIRST_PUBLIC_JOURNEYS,
  publicFields,
  summarizeWalk,
  type JourneyWalkRow,
} from './support/goal-journey-walk.ts';

test('walk evidence keeps all twenty-six first-public rows', () => {
  const rows: JourneyWalkRow[] = FIRST_PUBLIC_JOURNEYS.map((journey) => ({
    journey: journey.id,
    title: journey.title,
    result: 'FAIL',
    revision: '4634deb2ed9def2f2e57bb3aa8b370c52880ad4b',
    utc: '2026-11-07T03:10:51.023Z',
    elapsedSeconds: 144,
    persona: 'setup',
    firstDiffering: {
      command: 'seeded walk setup',
      expected: 'admitted seeded walk setup',
      observed: 'seed exited 1: Cross-media vndb/entry_meta exceeded its bounded scan',
    },
    evidence: '.temp/commerce-walk/results.json',
    steps: [],
    pages: [...journey.pages],
  }));
  const report = publicFields(summarizeWalk(rows[0]!.revision, rows)) as { rows: JourneyWalkRow[]; passing: number };
  expect(FIRST_PUBLIC_JOURNEYS).toHaveLength(26);
  expect(report.rows).toHaveLength(26);
  expect(report.rows.at(-1)?.journey).toBe('follower-counts');
  expect(report.passing).toBe(0);
});
