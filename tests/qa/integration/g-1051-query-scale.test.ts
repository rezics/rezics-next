import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Cell {
  name: string;
  viewer: string;
  statements: number;
  sqlFamilies: Record<string, number>;
}

/** Independent restored cuts share the same page-size invariance assertions.
 * Comparing their complete SQL-family maps also catches catalogue-driven work
 * that could pass both absolute caps. Preparation and child logs stay retained. */
test.skipIf(!Bun.env.G1051_BACKUPS)(
  'G1051: Query SQL families are identical at 1000 and 10000 Works for pages of 1, 16 and 64',
  async () => {
    const backups = JSON.parse(Bun.env.G1051_BACKUPS!) as string[];
    expect(backups).toHaveLength(2);
    const results: { catalogueScale: number; evidence: Cell[] }[] = [];
    for (const backup of backups) {
      const corpus = JSON.parse(readFileSync(join(dirname(backup), 'corpus.json'), 'utf8')) as {
        scale: number;
      };
      const directory = join(Bun.env.REZICS_QA_ARTIFACT_DIR!, `g-1051-scale-${corpus.scale}`);
      mkdirSync(directory, { recursive: true });
      const child = Bun.spawn(
        [process.execPath, 'test', './tests/qa/integration/g-1032-query-cost.test.ts'],
        {
          env: {
            ...process.env,
            G1032_BACKUP: resolve(backup),
            G1032_BASELINE: '0',
            G1051_MATRIX_ONLY: '1',
            REZICS_QA_ARTIFACT_DIR: directory,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      writeFileSync(join(directory, 'child.log'), `${output}\n${errors}`);
      expect(code, `Catalogue ${corpus.scale}: ${errors.slice(-3000)}`).toBe(0);
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
  },
  450_000,
);
