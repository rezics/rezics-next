import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isCheckHostRunCandidate } from '../../../scripts/check-placement.ts';

export function offHostFixtureParent(): string {
  const repository = realpathSync(join(import.meta.dir, '../../..'));
  // A fixture inside a live check run inherits its placement. TMPDIR may also be inside the run.
  return isCheckHostRunCandidate(repository) ? '/tmp' : join(repository, '.temp');
}
