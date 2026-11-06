import { env as workerEnv, DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { testFixtureEnvHeader } from './test-fixture-header.ts';

export { DurableObject, WorkflowEntrypoint, testFixtureEnvHeader };
export type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

export type TestFixtureOverlay = Record<string, string>;

let active: TestFixtureOverlay | undefined;
let depth = 0;

export function readTestFixtureOverlay(request: Request): TestFixtureOverlay | undefined {
  const raw = request.headers.get(testFixtureEnvHeader);
  if (!raw) return undefined;
  return JSON.parse(raw) as TestFixtureOverlay;
}

export async function withTestFixtureEnv<T>(
  overlay: TestFixtureOverlay | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!overlay) return await run();
  const previous = active;
  active = overlay;
  depth += 1;
  try {
    return await run();
  } finally {
    depth -= 1;
    active = depth === 0 ? undefined : previous;
  }
}

export const env = new Proxy(workerEnv as object, {
  get(target, property, receiver) {
    if (typeof property === 'string' && active && Object.prototype.hasOwnProperty.call(active, property))
      return active[property];
    return Reflect.get(target, property, receiver);
  },
  has(target, property) {
    if (typeof property === 'string' && active && Object.prototype.hasOwnProperty.call(active, property))
      return active[property] !== '';
    return Reflect.has(target, property);
  },
}) as typeof workerEnv;
