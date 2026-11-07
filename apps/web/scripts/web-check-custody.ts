import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isCheckHostRun } from '../../../scripts/check-placement.ts';

const workspaceRoot = resolve(import.meta.dir, '../../..');

/** Physical check-host admission without loading Web's routing and stack-placement graph. */
export function hasWebCheckCustody(workspace = workspaceRoot, cwd = workspace): boolean {
  const physicalRoot = realpathSync(workspace);
  const physicalCwd = realpathSync(cwd);
  const inside = relative(physicalRoot, physicalCwd);
  return (
    isCheckHostRun(physicalRoot) &&
    isCheckHostRun(physicalCwd) &&
    inside !== '..' &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside)
  );
}

export function requireWebCheckCustody(workspace = workspaceRoot, cwd = workspace): void {
  if (!hasWebCheckCustody(workspace, cwd))
    throw new Error(
      'Web check unavailable: this callable browser/check worker requires an actual remote run directory; use its routed script entrypoint.',
    );
}
