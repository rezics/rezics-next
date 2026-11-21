import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The pack contains only the public proof producer commit, its root and scripts trees,
// the original scripts/check-custody.ts blob, and the three retained Storybook workflow blobs.
// It can be rebuilt by passing those seven object IDs to git pack-objects --stdout --window=0.
export function installHistoricalGitFixture(root: string): void {
  const result = spawnSync('git', ['unpack-objects', '-q'], {
    cwd: root,
    input: readFileSync(join(import.meta.dir, 'historical-git-fixture.pack')),
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0 || result.error)
    throw new Error(`Could not unpack historical Git fixture: ${result.error?.message ?? result.stderr.trim()}`);
}
