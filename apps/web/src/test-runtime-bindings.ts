import { env as workerEnv, DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';

export { DurableObject, WorkflowEntrypoint };
export type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export type TestWorkerBindings = Readonly<Record<string, string>>;

declare const __REZICS_TEST_WORKER_BINDINGS__: Record<string, string>;
const testWorkerBindings: TestWorkerBindings = Object.freeze({ ...__REZICS_TEST_WORKER_BINDINGS__ });

/** Test-only Worker env bindings are fixed when this module starts; requests cannot change them. */
export const env = new Proxy(workerEnv as object, {
  get(target, property, receiver) {
    if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(testWorkerBindings, property))
      return testWorkerBindings[property];
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(testWorkerBindings, property))
      return testWorkerBindings[property] !== '';
    return Reflect.has(target, property);
  },
}) as typeof workerEnv;
