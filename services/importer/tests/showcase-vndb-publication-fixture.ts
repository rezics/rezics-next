import { emptyCrossMediaPlan, type CrossMediaPort, type CrossMediaTables } from '../src/showcase-contract.ts';
import { seedShowcaseVndbReleases } from '../src/selected-import.ts';

/** A single selected work for publication tests that start after family selection. */
export async function seedVndbPublicationFixture(path: string, port: CrossMediaPort) {
  const plan = emptyCrossMediaPlan();
  const id = 'v1';
  plan.records.vndb.push({
    source: 'vndb',
    key: id,
    revision: '1',
    payload: {
      vn: { id, olang: 'ja' },
      entry_meta: { id, revision: 1, lastmod: '2026-10-25 00:00:00+00' },
      vn_titles: [
        { id, lang: 'ja', official: true, title: 'STEINS;GATE', latin: null },
        { id, lang: 'en', official: true, title: 'Steins;Gate', latin: null },
      ],
    },
  });
  // The work has no release rows. Its source record is already in the selected plan.
  const tables: CrossMediaTables = {
    async *rows() {},
  };
  const result = await seedShowcaseVndbReleases({
    tables,
    plan,
    path,
    port,
    destination: { origin: 'https://fixture.test' },
    extras: { providers: ['vndb'], mediaDeadlineMs: 0 },
  });
  return { plan, result };
}
