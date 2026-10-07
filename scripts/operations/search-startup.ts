import type { StackOptions } from '../dev/config.ts';
import { withQaStackStartup, type StartupMemoryOptions } from '../qa/memory-admission.ts';

/** Reserve memory until the run deadline, then start Fuseki's readiness clock. */
export async function startSearchFuseki<T>(root: string, env: NodeJS.ProcessEnv,
  profile: StackOptions['profile'], start: (timeout: number) => T | Promise<T>,
  admission: Partial<StartupMemoryOptions> = {}): Promise<T> {
  const ready = () => start(300_000);
  return profile === 'qa'
    ? await withQaStackStartup(root, env, undefined, ready, { ...admission, services: ['fuseki'] })
    : await ready();
}
