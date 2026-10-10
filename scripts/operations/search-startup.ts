import type { StackOptions } from '../dev/config.ts';
import { withQaStackStartup, type StartupMemoryOptions } from '../qa/memory-admission.ts';
import { ContentRebuildUnavailable, contentRebuildStepTimedOut }
  from '../../services/main/src/modules/content-publication/rebuild.ts';

/** Reserve memory until the run deadline, then start Fuseki's readiness clock. */
export async function startSearchFuseki<T>(root: string, env: NodeJS.ProcessEnv,
  profile: StackOptions['profile'], start: (timeout: number) => T | Promise<T>,
  admission: Partial<StartupMemoryOptions> = {}): Promise<T> {
  const ready = () => start(300_000);
  try {
    return profile === 'qa'
      ? await withQaStackStartup(root, env, undefined, ready, { ...admission, services: ['fuseki'] })
      : await ready();
  } catch (error) {
    if (contentRebuildStepTimedOut(error)) {
      throw new ContentRebuildUnavailable('startup wait: timed out', { cause: error });
    }
    throw error;
  }
}
