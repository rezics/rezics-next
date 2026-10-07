import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertSavedStackRawUpdate,
  assertSavedStackStorage,
  composeProcessEnvironment,
  parseOptions,
  projectName,
  readEnv,
  stackDirectory,
  type StackOptions,
} from '../dev/config.ts';
import { loadDockerEnvironment } from '../load/docker-env.ts';

const root = resolve(import.meta.dir, '../..');
export const COMPACTION_IMAGE_GUARD = `owner=$(sha256sum /usr/local/bin/fuseki-owner)
[ "\${owner%% *}" = "$1" ] || { echo 'Rebuild the pinned Fuseki image with the current owner fence before compaction' >&2; exit 75; }
shift
exec sh "$@"`;
const USAGE =
  'Usage: task ops:compact -- compact|status|rollback|retire --window <name> [--retain-until <UTC ISO date> --reserve-bytes <n>] [--verified] --writers-stopped [--profile qa --run-id <id> --persistent]';
export interface CompactionOptions {
  mode: 'compact' | 'status' | 'rollback' | 'retire';
  window: string;
  retainUntil?: number;
  reserveBytes: number;
  verified: boolean;
  stack: StackOptions;
}

export function parseCompactionOptions(input: string[], now = Date.now()): CompactionOptions {
  const args = [...input];
  const mode = args.shift();
  if (mode !== 'compact' && mode !== 'status' && mode !== 'rollback' && mode !== 'retire')
    throw new Error(USAGE);
  function option(name: string): string | undefined {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    args.splice(at, 2);
    return value;
  }
  function flag(name: string): boolean {
    const at = args.indexOf(name);
    if (at < 0) return false;
    args.splice(at, 1);
    return true;
  }
  const window = option('--window');
  const until = option('--retain-until');
  const reserve = option('--reserve-bytes');
  const verified = flag('--verified');
  if (!flag('--writers-stopped'))
    throw new Error('Stop all writers and consumers, then acknowledge --writers-stopped');
  if (!window || !/^[a-z0-9-]{1,64}$/.test(window)) throw new Error(USAGE);
  const retainUntil = until === undefined ? undefined : Date.parse(until) / 1000;
  if (mode === 'compact') {
    if (
      !until ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(until) ||
      !Number.isSafeInteger(retainUntil) ||
      retainUntil! <= now / 1000 ||
      new Date(retainUntil! * 1000).toISOString() !== until.replace('Z', '.000Z')
    )
      throw new Error(USAGE);
  } else if (until !== undefined || reserve !== undefined) throw new Error(USAGE);
  if ((mode === 'retire') !== verified)
    throw new Error(
      'Retirement requires --verified; verify the retained cut and replacement first',
    );
  if (reserve !== undefined && !/^(0|[1-9][0-9]{0,14})$/.test(reserve)) throw new Error(USAGE);
  const stack = parseOptions(args);
  if (
    stack.rawUpdate ||
    stack.accountsApp ||
    (stack.profile === 'qa' && (!stack.runId || !stack.persistent))
  ) {
    throw new Error('Compaction requires a saved persistent stack without raw update');
  }
  return {
    mode,
    window,
    retainUntil,
    reserveBytes: reserve === undefined ? 1_073_741_824 : Number(reserve),
    verified,
    stack,
  };
}

/** The mounted script owns the lock, disk check, persistent failure fence and evidence. */
export function compactTdb2(
  options: CompactionOptions,
  compose: (args: string[]) => string,
): string {
  const ownerDigest = createHash('sha256')
    .update(readFileSync(join(root, 'infra/jena/fuseki-owner.sh')))
    .digest('hex');
  const operation = [options.mode, options.window];
  if (options.mode === 'compact')
    operation.push(String(options.retainUntil), String(options.reserveBytes));
  if (options.mode === 'retire') operation.push('--verified');
  // Do not stop or start services here. A live owner must be refused rather
  // than silently converted into an operator-approved maintenance window.
  return compose([
    'run',
    '--rm',
    '--no-deps',
    '-T',
    '--volume',
    `${join(root, 'infra/jena/compact-tdb2.sh')}:/tmp/compact-tdb2.sh:ro`,
    '--entrypoint',
    'sh',
    'fuseki',
    '-ec',
    COMPACTION_IMAGE_GUARD,
    'tdb2-compact',
    ownerDigest,
    '/tmp/compact-tdb2.sh',
    ...operation,
  ]);
}

if (import.meta.main) {
  const options = parseCompactionOptions(process.argv.slice(2));
  const directory = stackDirectory(root, options.stack);
  if (!existsSync(join(directory, 'compose.env'))) throw new Error('Saved stack is absent');
  const saved = readEnv(join(directory, 'compose.env'));
  assertSavedStackStorage(options.stack, saved);
  assertSavedStackRawUpdate(options.stack, saved);
  const environment = composeProcessEnvironment(loadDockerEnvironment(), saved);
  const result = compactTdb2(options, (args) => {
    const child = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        join(directory, 'compose.env'),
        '-f',
        join(root, 'infra/dev/compose.yaml'),
        '--project-name',
        projectName(options.stack),
        ...args,
      ],
      {
        cwd: root,
        env: environment,
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (child.error || child.status !== 0)
      throw new Error(
        `TDB2 maintenance failed: ${child.stderr || child.stdout || child.error?.message}; keep writers stopped and inspect the window; a timed-out container may still hold owner.lock`,
      );
    return child.stdout;
  });
  console.log(result.trim());
}
