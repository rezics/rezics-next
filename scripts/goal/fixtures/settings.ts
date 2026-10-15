import { afterEach, beforeEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keep direct calls and inherited subprocess environments independent of the operator's settings. */
export function isolateTestSettings(): void {
  let previous: string | undefined;
  let directory: string;
  beforeEach(() => {
    previous = process.env.GOAL_SETTINGS_DIRECTORY;
    const base = join(import.meta.dir, '../../../.temp/settings-fixtures');
    mkdirSync(base, { recursive: true });
    directory = mkdtempSync(join(base, 'case-'));
    writeFileSync(join(directory, 'settings.user.json'), '{"version":1}');
    process.env.GOAL_SETTINGS_DIRECTORY = directory;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.GOAL_SETTINGS_DIRECTORY;
    else process.env.GOAL_SETTINGS_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}
