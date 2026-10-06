/** Per-file allowances include sequential interaction work on the shared host.
 * Keep each runner's deadline separate from app startup and from the other runner. */
/** Engine projects a Playwright run repeats its files in (`REZICS_E2E_PROJECTS`, see apps/web/playwright.config.ts). */
export function browserProjectCount(selected = process.env.REZICS_E2E_PROJECTS): number {
  const value = selected?.trim();
  return !value ? 1 : value === 'all' ? 3 : value.split(',').length;
}

export interface E2eBrowserPlan {
  /** Journey files named on the command. Empty means every registered web journey. */
  selectedFiles: string[];
  /** The Accounts Playwright suite runs with a full e2e tier, not a selected file. */
  accountsJourneys: boolean;
  /** Web and Accounts stories each run once. */
  stories: boolean;
  /** Why stories were left out, when they were. */
  storySkipReason?: string;
}

const journeyFile = (arg: string) => arg.endsWith('.e2e.ts') && !arg.startsWith('-');

/** Storybook follows a full e2e tier, or an explicit request. Naming journey files skips it. */
export function e2eBrowserPlan(playwrightArgs: readonly string[], storybookRequested = false): E2eBrowserPlan {
  const selectedFiles = playwrightArgs.filter(journeyFile);
  const stories = selectedFiles.length === 0 || storybookRequested;
  return {
    selectedFiles,
    accountsJourneys: selectedFiles.length === 0,
    stories,
    ...(stories ? {} : { storySkipReason: 'selected journey files' }),
  };
}

/** One command per workspace. A skipped plan yields none, so a selected run cannot start either suite. */
export function storybookCommands(plan: E2eBrowserPlan): { name: string; root: string }[] {
  if (!plan.stories) return [];
  return [
    { name: 'storybook', root: 'apps/web' },
    { name: 'accounts-storybook', root: 'apps/accounts' },
  ];
}

export function browserBudgets(playwrightFiles: number, storyFiles: number, projects = 1,
  accounts: { playwright?: number; stories?: number } = {}) {
  // Explicit matrices can contain dozens of journeys in one file. Their per-test deadlines still apply.
  const minimum = Number(process.env.REZICS_E2E_PLAYWRIGHT_BUDGET_MS ?? 300_000);
  if (!Number.isSafeInteger(minimum) || minimum < 300_000 || minimum > 1_800_000)
    throw new Error('REZICS_E2E_PLAYWRIGHT_BUDGET_MS must be an integer from 300000 to 1800000');
  for (const count of [playwrightFiles, storyFiles]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Browser file counts must be positive integers');
  }
  const accountsPlaywright = accounts.playwright ?? 0;
  const accountsStories = accounts.stories ?? 0;
  for (const count of [accountsPlaywright, accountsStories]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Accounts browser file counts must be non-negative integers');
  }
  return {
    // Account ready, Accounts Worker build, Main ready, Web Worker build.
    setup: 30_000 + 240_000 + 30_000 + 240_000,
    playwright: Math.max(minimum, 30_000 + playwrightFiles * 30_000) * projects,
    // Accounts journeys allow 120s each and several share a file, so the file allowance is wider than web's.
    accountsPlaywright: accountsPlaywright === 0 ? 0
      : Math.max(minimum, 60_000 + accountsPlaywright * 120_000),
    // The 137-file browser tier took 156s on the shared host. Allow 3s/file
    // plus startup; individual story deadlines still bound a stuck interaction.
    storybook: Math.max(180_000, 60_000 + storyFiles * 3_000),
    accountsStorybook: accountsStories === 0 ? 0 : Math.max(180_000, 60_000 + accountsStories * 3_000),
  };
}

export function browserFileCounts(root: string, playwrightArgs: string[]) {
  const selected = playwrightArgs.filter(arg => arg.endsWith('.e2e.ts'));
  return {
    playwright: selected.length || [...new Bun.Glob('*.e2e.ts').scanSync({ cwd: `${root}/apps/web/tests` })].length,
    // apps/web/.storybook/main.ts includes both app features and Rezics UI.
    storybook: ['apps/web/features', 'packages/ui/src'].reduce((total, directory) => total
      + [...new Bun.Glob('**/*.stories.{ts,tsx}').scanSync({ cwd: `${root}/${directory}` })].length, 0),
    accountsPlaywright: [...new Bun.Glob('*.e2e.ts').scanSync({ cwd: `${root}/apps/accounts/tests` })].length,
    accountsStories: [...new Bun.Glob('**/*.stories.{ts,tsx}').scanSync({ cwd: `${root}/apps/accounts/features` })].length,
  };
}
