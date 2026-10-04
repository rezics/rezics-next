import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { queryProfileProcess } from '../../../services/main/tests/g-1053-profile-process.ts';

interface Cell {
  name: string;
  viewer: string;
  statements: number;
  sqlFamilies: Record<string, number>;
}

/** Independent public-command populations share the page-size assertions.
 * Comparing their complete SQL-family maps also catches catalogue-driven work
 * that could pass both absolute caps. Preparation and child logs stay retained. */
test('G1051: Query SQL families are identical at 1000 and 10000 Works for pages of 1, 16 and 64', async () => {
  const deadline = String(Date.now() + 430_000);
  const backups = Bun.env.G1051_BACKUPS
    ? (JSON.parse(Bun.env.G1051_BACKUPS) as string[])
    : undefined;
  if (backups) expect(backups).toHaveLength(2);
  const results: { catalogueScale: number; evidence: Cell[] }[] = [];
  for (const [index, scale] of [1000, 10000].entries()) {
    const backup = backups?.[index];
    const corpus = backup
      ? (JSON.parse(readFileSync(join(dirname(backup), 'corpus.json'), 'utf8')) as {
          scale: number;
        })
      : { scale };
    const directory = join(Bun.env.REZICS_QA_ARTIFACT_DIR!, `g-1051-scale-${corpus.scale}`);
    mkdirSync(directory, { recursive: true });
    await queryProfileProcess('g-1032-query-cost.test.ts', {
      G1053_PROFILE_DEADLINE: deadline,
      G1032_BACKUP: backup ? resolve(backup) : '',
      G1053_CATALOGUE_SCALE: backup ? '' : String(scale),
      G1032_BASELINE: '0',
      G1051_MATRIX_ONLY: '1',
      REZICS_QA_ARTIFACT_DIR: directory,
    });
    results.push(JSON.parse(readFileSync(join(directory, 'g-1032-query-after.json'), 'utf8')));
  }
  expect(results.map((row) => row.catalogueScale).sort((a, b) => a - b)).toEqual([1000, 10000]);
  const matrix = (rows: Cell[]) =>
    Object.fromEntries(
      rows
        .filter((row) => row.name.startsWith('page-size-'))
        .map((row) => [
          `${row.viewer}:${row.name}`,
          { statements: row.statements, families: row.sqlFamilies },
        ]),
    );
  const first = matrix(results[0]!.evidence);
  expect(Object.keys(first)).toHaveLength(36);
  expect(matrix(results[1]!.evidence)).toEqual(first);
  writeFileSync(
    join(Bun.env.REZICS_QA_ARTIFACT_DIR!, 'g-1051-scale-matrix.json'),
    JSON.stringify({ scales: results.map((row) => row.catalogueScale), matrix: first }, null, 2),
  );
}, 450_000);
