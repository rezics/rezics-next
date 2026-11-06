import { createWorkApplication } from '../work/application/index.ts';
import { bindWorkApplication, createNativeWorkPorts } from '../work/adapters/index.ts';
import type { WorkApplication } from '../work/contract/index.ts';

let composed: WorkApplication | undefined;

/** Ordinary createKernel/server/worker composition binds the native Work adapters. */
export function composeWorkApplication(): WorkApplication {
  if (composed) return composed;
  composed = bindWorkApplication(createWorkApplication(createNativeWorkPorts()));
  return composed;
}

export function composedWorkApplication(): WorkApplication {
  return composed ?? composeWorkApplication();
}
