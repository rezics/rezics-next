/**
 * What a computed dynamic import can load, for affected mode. The selector cannot see through `import(expression)`, so a
 * module with such a site runs its tests on every change unless an entry here names the site. An entry gives the module
 * (repository-relative path), the exact source text of the import's argument, and the repository-relative globs the site
 * can load; the files the globs match become dependencies of the module. An entry whose module is gone, whose site text
 * no longer occurs in the module, or whose glob matches no file makes the selection the whole suite, so edit the entry
 * with the code. A computed import with no entry still runs its tests on every change.
 */
export type ReachEntry = { module: string; site: string; globs: string[] };

/** An outcome spec loads the driver its importing kernel test names, so the importer carries the edge and the globs are empty. */
const outcomeSpec = (module: string, site = 'url.href'): ReachEntry => ({ module, site, globs: [] });

export const REACH: ReachEntry[] = [
  outcomeSpec('specs/command-admission-outcomes.test.ts'),
  outcomeSpec('specs/commerce-outcomes.test.ts'),
  outcomeSpec('specs/community-outcomes.test.ts'),
  outcomeSpec('specs/content-media-outcomes.test.ts'),
  outcomeSpec('specs/content-thread-outcomes.test.ts'),
  outcomeSpec('specs/imports-identity.test.ts'),
  outcomeSpec('specs/imports-media-boundary-driver.ts'),
  outcomeSpec('specs/library-outcomes.test.ts'),
  outcomeSpec('specs/native-account-workflow-outcomes.test.ts', 'module'),
  outcomeSpec('specs/native-credential-effect-outcomes.test.ts'),
  outcomeSpec('specs/platform-gates-outcomes.test.ts'),
  // Its callers pass `src/` or `src/content/`; the wider directory is listed.
  {
    module: 'services/kernel/test/support/partition-binding.ts',
    site: 'pathToFileURL(file).href',
    globs: ['services/kernel/src/**/*.sql'],
  },
  {
    module: 'services/kernel/test/semantic/support/sql-guard.ts',
    site: 'pathToFileURL(path).href',
    globs: ['services/kernel/src/semantic/**/*.sql'],
  },
  {
    module: 'services/kernel/test/content/board-projection.test.ts',
    site: '`../../src/content/${name}.sql`',
    globs: ['services/kernel/src/content/*.sql'],
  },
  {
    module: 'services/kernel/test/content/reaction-projection.test.ts',
    site: '`../../src/content/${name}.sql`',
    globs: ['services/kernel/src/content/*.sql'],
  },
  {
    module: 'services/kernel/test/community/board-scheme.test.ts',
    site: 'modulePath',
    globs: ['services/kernel/src/community/board-scheme.ts'],
  },
];
