import { createContentApplication } from '../application/index.ts';
import type { ContentAmbient, ContentApplication } from '../contract/index.ts';
import { bindContentApplication, tryContentApplication, unbindContentApplication } from './bind.ts';
import { createNativeContentAmbient } from './ambient.ts';
import { createNativeContentPorts } from './native.ts';

/** Construct and bind native Content ports. Composition may override ambient operands.
 * createKernel and startWorker call this so HTTP and workers share one bound application. */
export function ensureContentApplication(ambient: Partial<ContentAmbient> = {}): ContentApplication {
  const bound = tryContentApplication();
  if (bound && Object.keys(ambient).length === 0) return bound;
  return bindContentApplication(
    createContentApplication(createNativeContentPorts(createNativeContentAmbient(ambient))),
  );
}

/** Bind native Content for the process lifetime of a kernel or worker. `stop` restores the
 * previous unbound state so tests and shutdown do not leave a borrowed clock in place. */
export function startContentApplication(ambient: Partial<ContentAmbient> = {}): {
  application: ContentApplication;
  stop: () => void;
} {
  const application = ensureContentApplication(ambient);
  return {
    application,
    stop() {
      if (tryContentApplication() === application) unbindContentApplication();
    },
  };
}
