import { bundledDigest } from '@rezics/definitions/bundled';
import { derivedId, partitionOf, routeOf } from '../../src/route/route.ts';
import { seed, type Population, type SeedTarget } from '../support/growth-seed.ts';

const revisionsPerOrdinal = 32;

/** Setup rows belong to the actual selected subject, rather than a neighbour on its route. */
export function subjectHistoryPopulation(subject: string, latest: number): Population {
  const route = routeOf(subject);
  if (route === null) throw new Error(`Invalid history subject: ${subject}`);
  return {
    name: `native-import-selected-subject-history:${subject}`,
    hotPartition: partitionOf(route),
    rows({ ordinal }) {
      return {
        'semantic.revision': Array.from({ length: revisionsPerOrdinal }, (_, index) => {
          const revision = latest + ordinal * revisionsPerOrdinal + index + 1;
          return {
            route,
            subject_id: subject,
            revision,
            kind: 'propose',
            release: bundledDigest,
            recorded_transaction_id: derivedId(subject, `growth-history:${revision}`, route),
            source: null,
          };
        }),
      };
    },
  };
}

/** Native revisions are immutable; a smaller target starts a new appended setup range. */
export function createSubjectHistoryPopulation(database: SeedTarget) {
  const sizes = new Map<string, number>();
  return async (subjects: readonly string[], historyRows: number) => {
    const ranges: { subject: string; added: number; population: Population }[] = [];
    for (const subject of new Set(subjects)) {
      const previous = sizes.get(subject) ?? 0;
      const added = historyRows < previous ? historyRows : historyRows - previous;
      if (added === 0) continue;
      const route = routeOf(subject);
      const result = await database.admin.query<{ revision: number }>(
        'SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1',
        [route, subject],
      );
      const latest = result.rows[0]?.revision;
      if (latest === undefined) throw new Error(`Selected history subject has no native revision: ${subject}`);
      ranges.push({ subject, added, population: subjectHistoryPopulation(subject, latest) });
    }
    if (ranges.length === 0) return;
    // One shared bulk seed also performs one ANALYZE/settle for the whole setup,
    // including the 64 replacement subjects and the private-plan subjects.
    await seed(
      database,
      {
        name: 'native-import-selected-subject-histories',
        hotPartition: ranges[0]!.population.hotPartition,
        rows(placement) {
          return {
            'semantic.revision': ranges.flatMap(({ added, population }) =>
              placement.ordinal < added ? population.rows!(placement)['semantic.revision']! : [],
            ),
          };
        },
      },
      { from: 0, to: Math.max(...ranges.map(({ added }) => added)) },
    );
    for (const { subject } of ranges) sizes.set(subject, historyRows);
  };
}
