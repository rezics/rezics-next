import { isolatedIntegrationFiles, planShards } from './core.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';
import { scaleIntegrationFiles } from './stack-environment.ts';

export interface IntegrationShard {
  files: string[];
  batches: string[][];
}

// Complete pagination/import assertions intentionally do substantial real API
// work after their bulk setup. Give them a whole command budget: combining two
// 200-second populations with ordinary files exhausts a 480-second shard.
const largeFixtureFiles: ReadonlySet<string> = new Set([
  'tests/qa/integration/g-854-large-library.test.ts',
  'tests/qa/integration/g-852-zones.test.ts',
  'tests/qa/integration/g-556-ranked-large.test.ts',
  'tests/qa/integration/g-939-discovery.test.ts',
]);

/** One stack/bootstrap per worker. Fresh-state files reset that stack between
 * commands; product-assembler probes retain their own persistent project. */
export function planIntegrationShards(
  estimates: ReadonlyMap<string, number>,
  count: number,
): IntegrationShard[] {
  const ownProject = (file: string) =>
    commandOnlyIntegrationFiles.has(file) ||
    scaleIntegrationFiles.has(file) ||
    largeFixtureFiles.has(file);
  const reusable = new Map([...estimates].filter(([file]) => !ownProject(file)));
  const persistent = [...estimates.keys()].filter(ownProject).sort();
  const plans = planShards(reusable, count).map((files) => {
    const shared = files.filter((file) => !isolatedIntegrationFiles.has(file));
    const isolated = files
      .filter((file) => isolatedIntegrationFiles.has(file))
      .sort((a, b) => estimates.get(b)! - estimates.get(a)! || a.localeCompare(b));
    return {
      files,
      batches: [...(shared.length ? [shared] : []), ...isolated.map((file) => [file])],
    };
  });
  return [...plans, ...persistent.map((file) => ({ files: [file], batches: [[file]] }))];
}
