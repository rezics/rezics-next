import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  axes,
  bounds,
  expectHistoryPage,
  expectNoHistoryListing,
  neighborhood,
  newId,
  pageLimit,
  reportGrowth,
  revisionHistoryRefusalFixture,
  routeOf,
  scales,
  type GrowthAxis,
  type RevisionHistoryRefusalFixture,
  type RevisionPage,
} from './revision-history-refusal-fixture.ts';

let db: GrowthDatabase;
let fixture: RevisionHistoryRefusalFixture;

beforeAll(async () => {
  db = await openGrowthDatabase(process.env.DATABASE_URL!);
  fixture = await revisionHistoryRefusalFixture(db);
});

afterAll(async () => {
  if (db) await db.close();
});

async function grow(
  axis: GrowthAxis,
  subject: string,
  unrelated: readonly string[],
  scale: number,
  previous: number,
): Promise<void> {
  if (axis === 'history') await fixture.growSelectedHistory(subject, previous, scale);
  else await fixture.growUnrelated(`revision-history-unrelated-${subject}`, unrelated, previous, scale);
}

function expectPage(actual: RevisionPage, expected: RevisionPage): void {
  expect(actual.revisions.map((row) => row.revision)).toEqual(expected.revisions.map((row) => row.revision));
  expect(actual.next === null).toBe(expected.next === null);
  if (expected.next !== null) expect(actual.next).toBeString();
}

for (const axis of axes) {
  test(`revision history deep page stays bounded as ${axis} grows`, async () => {
    const { subject, unrelated } = await neighborhood(fixture);
    if (axis === 'unrelated') await fixture.growSelectedHistory(subject, 0, 1);
    let prepared: { cursor: string; page: RevisionPage } | undefined;
    const report = await checkGrowth(db, {
      name: `Revision history deep page (${axis})`,
      scales,
      bounds,
      repetitions: 3,
      grow: (growthDb, scale, previous) => grow(axis, subject, unrelated, scale, previous),
      warmup: async () => {
        prepared = fixture.deepIssued(await fixture.issuedPages(subject));
        expect(prepared.page.revisions).toHaveLength(pageLimit);
        expect(prepared.page.next).toBeString();
      },
      operation: async () => {
        if (!prepared) throw new Error('Deep revision cursor was not prepared');
        const { body } = await fixture.list(subject, { cursor: prepared.cursor });
        expectPage(body as RevisionPage, prepared.page);
        return body;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const sample of report.samples) expectHistoryPage(sample);
    reportGrowth(report);
  }, 240_000);

  test(`revision history exhausted continuation stays bounded as ${axis} grows`, async () => {
    const { subject, unrelated } = await neighborhood(fixture);
    if (axis === 'unrelated') await fixture.growSelectedHistory(subject, 0, 1);
    let prepared: { cursor: string; page: RevisionPage } | undefined;
    const report = await checkGrowth(db, {
      name: `Revision history exhausted continuation (${axis})`,
      scales,
      bounds,
      repetitions: 3,
      grow: (growthDb, scale, previous) => grow(axis, subject, unrelated, scale, previous),
      warmup: async () => {
        prepared = fixture.exhaustedIssued(await fixture.issuedPages(subject));
        expect(prepared.page.next).toBeNull();
        expect(prepared.page.revisions.length).toBeLessThanOrEqual(pageLimit);
      },
      operation: async () => {
        if (!prepared) throw new Error('Exhausted revision cursor was not prepared');
        const { body } = await fixture.list(subject, { cursor: prepared.cursor });
        expectPage(body as RevisionPage, prepared.page);
        return body;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const sample of report.samples) expectHistoryPage(sample);
    reportGrowth(report);
  }, 240_000);

  test(`revision history native refusals stay bounded as ${axis} grows`, async () => {
    const hidden = await neighborhood(fixture);
    const absentNeighborhood = await neighborhood(fixture);
    const malformedNeighborhood = await neighborhood(fixture);
    const missing = newId(routeOf(absentNeighborhood.subject)!);
    if (axis === 'unrelated') {
      await fixture.growSelectedHistory(hidden.subject, 0, 1);
      await fixture.growSelectedHistory(absentNeighborhood.subject, 0, 1);
      await fixture.growSelectedHistory(malformedNeighborhood.subject, 0, 1);
    }
    await fixture.leaf.hideSubject(hidden.subject);

    const ineligible = await checkGrowth(db, {
      name: `Revision history ineligible hidden subject (${axis})`,
      scales,
      bounds,
      repetitions: 3,
      grow: (_growthDb, scale, previous) => grow(axis, hidden.subject, hidden.unrelated, scale, previous),
      operation: async () => {
        const { body } = await fixture.list(hidden.subject, { status: 404 });
        expect(body.code).toBe('not_found');
        return body;
      },
    });
    const absent = await checkGrowth(db, {
      name: `Revision history missing subject (${axis})`,
      scales,
      bounds,
      repetitions: 3,
      grow: (_growthDb, scale, previous) =>
        grow(axis, absentNeighborhood.subject, absentNeighborhood.unrelated, scale, previous),
      operation: async () => {
        const { body } = await fixture.list(missing, { status: 404 });
        expect(body.code).toBe('not_found');
        return body;
      },
    });
    const malformed = await checkGrowth(db, {
      name: `Revision history malformed cursor (${axis})`,
      scales,
      bounds,
      repetitions: 3,
      grow: (_growthDb, scale, previous) =>
        grow(axis, malformedNeighborhood.subject, malformedNeighborhood.unrelated, scale, previous),
      operation: async () => {
        const { body } = await fixture.list(malformedNeighborhood.subject, {
          cursor: `not-a-cursor-${randomUUID()}`,
          status: 400,
        });
        expect(body.code).toBe('invalid_request');
        return body;
      },
    });

    for (const report of [ineligible, absent, malformed]) {
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      for (const sample of report.samples) expectNoHistoryListing(sample);
      reportGrowth(report);
    }
  }, 360_000);
}
