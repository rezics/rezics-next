import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Disposable account configuration; callers pass its path through GOAL_SETTINGS_DIRECTORY. */
type TestAccount = { engine: string; home?: string; launcher?: string; weight?: number; pastAllowance?: string[] };

export function testAccountSettings(directory: string, accounts: TestAccount[]): string {
  const settings = join(directory, '.goalctl');
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, 'settings.user.json'), JSON.stringify({ version: 1,
    accounts: accounts.map(account => ({ weight: 1, ...account })) }));
  return settings;
}

export function writeTestAccounts(directory: string, accounts: TestAccount[] = [
  { engine: 'codex', home: join(directory, '.temp/first-home') },
  { engine: 'sample-b', home: join(directory, '.temp/second-home') },
]): string {
  return testAccountSettings(directory, accounts);
}

/** Scopes direct synchronous API calls; subprocess tests should pass the returned path in their env instead. */
export function withTestAccounts<T>(callback: () => T, accounts?: TestAccount[]): T {
  const scratch = join(import.meta.dir, '../../../.temp/account-fixtures');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'case-'));
  const previous = process.env.GOAL_SETTINGS_DIRECTORY;
  process.env.GOAL_SETTINGS_DIRECTORY = writeTestAccounts(directory, accounts);
  try { return callback(); }
  finally {
    if (previous === undefined) delete process.env.GOAL_SETTINGS_DIRECTORY;
    else process.env.GOAL_SETTINGS_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}
