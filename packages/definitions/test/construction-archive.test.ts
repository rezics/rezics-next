import { expect, test } from 'bun:test';
import { createConstructionArchive } from './support/construction-archive.ts';

test('the complete original construction comparisons and native counters run in a Gitless, offline archive', async () => {
  const archive = createConstructionArchive();
  try {
    const identities = await archive.run([archive.helper, '--identities']);
    expect(identities.exitCode, identities.stderr).toBe(0);
    expect(JSON.parse(identities.stdout)).toEqual({
      revision: '2c86ce30efc2aabc94a7683bfea367a69263aa39',
      identities: 14,
      rejectedMutations: 28,
    });

    // Run the existing suites verbatim, including their real nested --probe child.
    // Listing the two files explicitly prevents archive-test recursion.
    const result = await archive.run([
      'test',
      './test/publication-construction-compatibility.test.ts',
      './test/publication-construction.test.ts',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/85 pass/);
    expect(result.stderr).toMatch(/0 fail/);
    expect(result.stderr).not.toMatch(/\d+ (?:skip|todo)/);
    const evidenceLine = result.stdout.split('\n').find((line) => line.startsWith('construction native evidence '));
    expect(evidenceLine).toBeDefined();
    const report = JSON.parse(evidenceLine!.slice('construction native evidence '.length));
    expect(report.rows).toHaveLength(119);
    expect(report.patterns).toHaveLength(4);
    for (const row of report.rows) expect(row.instrumented, row.name).toEqual(row.original);
    const modules = archive.loadedModules();
    expect(modules).toContain('packages/definitions/src/index.ts');
    expect(modules).toContain('packages/filter/src/filter.ts');
    expect(modules.some((path) => /\.temp\/publication-construction\/oracle-.*\/module-0\.ts$/.test(path))).toBe(true);
    expect(modules.some((path) => /\.temp\/publication-construction\/probe-.*\/module-0\.ts$/.test(path))).toBe(true);
    archive.assertGitless();
    archive.preserve();
  } catch (error) {
    archive.preserve(error);
    throw error;
  } finally {
    archive.close();
  }
}, 480_000);
