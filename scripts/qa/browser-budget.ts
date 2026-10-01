/** Per-file allowances include sequential interaction work on the shared host.
 * Keep each runner's deadline separate from app startup and from the other runner. */
/** Engine projects a Playwright run repeats its files in (`REZICS_E2E_PROJECTS`, see apps/web/playwright.config.ts). */
export function browserProjectCount(selected = process.env.REZICS_E2E_PROJECTS): number {
  const value = selected?.trim();
  return !value ? 1 : value === 'all' ? 3 : value.split(',').length;
}

export function browserBudgets(playwrightFiles: number, storyFiles: number, projects = 1) {
  for (const count of [playwrightFiles, storyFiles]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Browser file counts must be positive integers');
  }
  return {
    setup: 30_000 + 90_000 + 30_000 + 240_000,
    playwright: Math.max(300_000, 30_000 + playwrightFiles * 30_000) * projects,
    // The 137-file browser tier took 156s on the shared host. Allow 3s/file
    // plus startup; individual story deadlines still bound a stuck interaction.
    storybook: Math.max(180_000, 60_000 + storyFiles * 3_000),
  };
}

export function browserFileCounts(root: string, playwrightArgs: string[]) {
  const selected = playwrightArgs.filter(arg => arg.endsWith('.e2e.ts'));
  return {
    playwright: selected.length || [...new Bun.Glob('*.e2e.ts').scanSync({ cwd: `${root}/apps/web/tests` })].length,
    // apps/web/.storybook/main.ts includes both app features and Rezics UI.
    storybook: ['apps/web/features', 'packages/ui/src'].reduce((total, directory) => total
      + [...new Bun.Glob('**/*.stories.{ts,tsx}').scanSync({ cwd: `${root}/${directory}` })].length, 0),
  };
}
