import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const registryUrl = 'https://registry.npmjs.org/shadcn/latest';
const sevenDays = 7 * 24 * 60 * 60 * 1000;

export type SyncState = { syncedAt: string; version: string };
export type CommandResult = { stdout: string; stderr?: string };
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type CheckOptions = {
  root?: string;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  runCommand?: CommandRunner;
};

/** Returns true only after the last successful sync is more than seven full days old and no matching issue is open. */
export function shouldOpenShadcnSyncIssue(syncedAt: string, now: Date, hasOpenIssue: boolean): boolean {
  const timestamp = Date.parse(syncedAt);
  return Number.isFinite(timestamp) && now.getTime() - timestamp > sevenDays && !hasOpenIssue;
}

async function latestVersion(fetcher: typeof globalThis.fetch): Promise<string> {
  const response = await fetcher(registryUrl);
  if (!response.ok) throw new Error(`Could not read the latest shadcn version: ${response.status}`);
  const registry = (await response.json()) as { version?: unknown };
  if (typeof registry.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(registry.version))
    throw new Error('The shadcn registry returned an invalid latest version');
  return registry.version;
}

async function run(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command} ${args.join(' ')} failed (${exitCode}): ${stderr || stdout}`);
  return { stdout, stderr };
}

function issueBody(state: SyncState, newestVersion: string): string {
  return [
    `The last shadcn sync was on ${state.syncedAt} at version ${state.version}. The newest shadcn CLI version is ${newestVersion}.`,
    '',
    'Run the manual sync from `packages/ui`:',
    '',
    '```sh',
    'bun scripts/shadcn-sync.ts',
    '```',
    '',
    'Review the component, capability index, lockfile and pin changes, run `bun run check` in `packages/ui`, and commit the sync. Include `Closes #<issue-number>` in the commit message.',
  ].join('\n');
}

/** Checks the reminder policy, with registry and GitHub calls injectable for deterministic tests. */
export async function checkShadcnSync(options: CheckOptions = {}): Promise<'current' | 'existing' | 'created'> {
  const packageRoot = options.root ?? root;
  const state = JSON.parse(await readFile(join(packageRoot, 'shadcn-sync.json'), 'utf8')) as SyncState;
  if (!state || typeof state.syncedAt !== 'string' || typeof state.version !== 'string')
    throw new Error('shadcn-sync.json must contain syncedAt and version');

  const currentVersion = await latestVersion(options.fetch ?? globalThis.fetch);
  const runner = options.runCommand ?? run;
  const listed = await runner(
    'gh',
    ['issue', 'list', '--state', 'open', '--label', 'shadcn-sync', '--json', 'number,title', '--limit', '1'],
    { cwd: packageRoot },
  );
  const issues = JSON.parse(listed.stdout) as unknown;
  if (!Array.isArray(issues)) throw new Error('gh issue list returned an invalid response');
  if (!shouldOpenShadcnSyncIssue(state.syncedAt, (options.now ?? (() => new Date()))(), issues.length > 0))
    return issues.length > 0 ? 'existing' : 'current';

  await runner(
    'gh',
    [
      'issue',
      'create',
      '--title',
      'Sync shadcn components',
      '--label',
      'shadcn-sync',
      '--body',
      issueBody(state, currentVersion),
    ],
    { cwd: packageRoot },
  );
  return 'created';
}

if (import.meta.main) {
  const result = await checkShadcnSync();
  if (result === 'created') console.log('Opened a shadcn sync issue.');
  else if (result === 'existing') console.log('An open shadcn sync issue already exists.');
  else console.log('The last shadcn sync is less than seven days old.');
}
