import { matchesPath } from './briefs.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

export type ConfiguredPathCheck = { paths: readonly string[] };

/** Return configured checks affected by changed files, preserving configuration order and source records. */
export function selectAffectedChecks<T extends ConfiguredPathCheck>(
  changed: readonly string[],
  checks: readonly T[],
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
): T[] {
  return checks.filter((check) => changed.some((path) => matchesPath(path, check.paths, policy)));
}
