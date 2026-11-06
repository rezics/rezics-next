import type { WorkApplication, WorkApplicationPorts } from '../contract/index.ts';
/** Use cases over Work-owned ports. Downstream implementations are never imported here. */
export declare function createWorkApplication(ports: WorkApplicationPorts): WorkApplication;
export { SelectedRuntimeUnavailable } from './selected-runtime.ts';
export { WorkCompositionError } from './compose.ts';
export { createSelectedRuntime } from './selected-runtime.ts';
