import { isolatedIntegrationFiles, planShards } from './core.ts';
import { commandOnlyIntegrationFiles } from './isolated-integration-files.ts';
import {
  integrationResourceClass,
  integrationResourceClasses,
  type QaResourceClass,
} from './resource-classes.ts';

export interface IntegrationShard {
  files: string[];
  batches: string[][];
  resourceClass: QaResourceClass;
}

/** One stack/bootstrap per worker. Fresh-state files reset that stack between
 * commands; product-assembler probes retain their own persistent project. */
export function planIntegrationShards(
  estimates: ReadonlyMap<string, number>,
  count: number,
): IntegrationShard[] {
  const ownProject = (file: string) =>
    commandOnlyIntegrationFiles.has(file) || integrationResourceClasses.has(file);
  const reusable = new Map([...estimates].filter(([file]) => !ownProject(file)));
  const persistent = [...estimates.keys()].filter(ownProject).sort();
  const plans = planShards(reusable, count).map((files) => {
    const shared = files.filter((file) => !isolatedIntegrationFiles.has(file));
    const isolated = files
      .filter((file) => isolatedIntegrationFiles.has(file))
      .sort((a, b) => estimates.get(b)! - estimates.get(a)! || a.localeCompare(b));
    return {
      files,
      resourceClass: integrationResourceClass(files),
      batches: [...(shared.length ? [shared] : []), ...isolated.map((file) => [file])],
    };
  });
  return [
    ...plans,
    ...persistent.map((file) => ({
      files: [file],
      batches: [[file]],
      resourceClass: integrationResourceClass([file]),
    })),
  ];
}
