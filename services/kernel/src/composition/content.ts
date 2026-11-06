import { ensureContentApplication, startContentApplication, tryContentApplication } from '../content/adapters/index.ts';
import type { ContentAmbient, ContentApplication } from '../content/contract/index.ts';

export { startContentApplication };

/** Ordinary createKernel/server/worker composition binds the native Content adapters. */
export function composeContentApplication(ambient?: Partial<ContentAmbient>): ContentApplication {
  return ensureContentApplication(ambient ?? {});
}

export function composedContentApplication(): ContentApplication {
  return tryContentApplication() ?? composeContentApplication();
}
