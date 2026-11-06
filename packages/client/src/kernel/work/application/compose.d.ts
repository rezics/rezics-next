import type { WorkApplicationPorts, WorkComposedRuntime, WorkComposeOptions, WorkModule, WorkSelectedRuntime } from '../contract/index.ts';
export declare class WorkCompositionError extends Error {
    constructor(message: string);
}
export declare function createComposer(ports: WorkApplicationPorts, composeSelectedRuntime: (pool: WorkComposeOptions['pool'], client: WorkComposeOptions['client']) => WorkSelectedRuntime): {
    compose(modules: readonly WorkModule[], options: WorkComposeOptions): Promise<WorkComposedRuntime>;
};
