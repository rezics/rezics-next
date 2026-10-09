import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** QA bootstrap writes this into the stack's apps environment. Production
 * preflight refuses it. `*` opens every platform group, as a `platform:use:*`
 * grant held by every caller would. A request cannot supply it. */
export const PLATFORM_OPEN_GROUPS = 'REZICS_PLATFORM_OPEN_GROUPS';
export type PlatformOpenGroups = '*' | readonly string[];

const platformGroupName = /^[a-z][a-z0-9-]{0,63}$/;

/** Empty and omitted values stay closed. `*` is every group. Anything else is
 * a comma-separated group list; a malformed value fails closed by throwing. */
export function readPlatformOpenGroups(env: object): PlatformOpenGroups | undefined {
  if (!Object.hasOwn(env, PLATFORM_OPEN_GROUPS)) return undefined;
  const raw = (env as Record<string, unknown>)[PLATFORM_OPEN_GROUPS];
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (raw === '*') return '*';
  const groups = raw.split(',').map((group) => group.trim()).filter(Boolean);
  if (groups.length === 0 || groups.some((group) => !platformGroupName.test(group)))
    throw new Error(`Invalid ${PLATFORM_OPEN_GROUPS}`);
  return groups;
}

/** The in-process QA server starts after bootstrap has written apps.env, and
 * the runner's process environment was snapshotted before that write. */
export function qaStackPlatformOpenGroups(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string,
  cwd = process.cwd(),
): PlatformOpenGroups | undefined {
  if (env.NODE_ENV === 'production') return undefined;
  const runId = env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) return undefined;
  let text: string;
  try {
    text = read(join(cwd, '.temp', 'stack', `rezics-qa-${runId}`, 'apps.env'));
  } catch {
    return undefined;
  }
  let raw: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${PLATFORM_OPEN_GROUPS}=`)) continue;
    raw = line.slice(PLATFORM_OPEN_GROUPS.length + 1);
  }
  return raw === undefined ? undefined : readPlatformOpenGroups({ [PLATFORM_OPEN_GROUPS]: raw });
}

let processOpenGroupsKey = '';
let processOpenGroups: PlatformOpenGroups | undefined;

/** Process environment first. When the variable is absent, the QA stack file.
 * An explicit empty value stays closed and does not read the file. */
export function defaultPlatformOpenGroups(): PlatformOpenGroups | undefined {
  const key = [
    process.env.NODE_ENV ?? '',
    process.env.REZICS_QA_RUN_ID ?? '',
    Object.hasOwn(process.env, PLATFORM_OPEN_GROUPS) ? '1' : '0',
    process.env[PLATFORM_OPEN_GROUPS] ?? '',
  ].join('\0');
  if (key === processOpenGroupsKey) return processOpenGroups;
  processOpenGroupsKey = key;
  processOpenGroups = Object.hasOwn(process.env, PLATFORM_OPEN_GROUPS)
    ? readPlatformOpenGroups(process.env)
    : qaStackPlatformOpenGroups(process.env, (path) => readFileSync(path, 'utf8'));
  return processOpenGroups;
}
