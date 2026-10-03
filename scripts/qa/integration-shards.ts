import { isolatedIntegrationFiles, planShards } from './core.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';

export interface IntegrationShard {
  files: string[];
  batches: string[][];
}

/** One stack/bootstrap per worker. Fresh-state files reset that stack between
 * commands; product-assembler probes retain their own persistent project. */
export function planIntegrationShards(
  estimates: ReadonlyMap<string, number>,
  count: number,
): IntegrationShard[] {
  const reusable = new Map(
    [...estimates].filter(([file]) => !commandOnlyIntegrationFiles.has(file)),
  );
  const persistent = [...estimates.keys()]
    .filter((file) => commandOnlyIntegrationFiles.has(file))
    .sort();
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
