import { createCommunityApplication } from '../application/index.ts';
import type { CommunityAmbient, CommunityApplication } from '../contract/index.ts';
import { bindCommunityApplication, tryCommunityApplication, unbindCommunityApplication } from './bind.ts';
import { createNativeCommunityAmbient } from './ambient.ts';
import { createNativeCommunityPorts } from './native.ts';

/** Construct and bind native Community ports. Composition may override ambient operands.
 * createKernel and startWorker call this so HTTP and workers share one bound application. */
export function ensureCommunityApplication(ambient: Partial<CommunityAmbient> = {}): CommunityApplication {
  const bound = tryCommunityApplication();
  if (bound && Object.keys(ambient).length === 0) return bound;
  return bindCommunityApplication(
    createCommunityApplication(createNativeCommunityPorts(createNativeCommunityAmbient(ambient))),
  );
}

/** Bind native Community for the process lifetime of a kernel or worker. `stop` restores the
 * previous unbound state so tests and shutdown do not leave a borrowed clock in place. */
export function startCommunityApplication(ambient: Partial<CommunityAmbient> = {}): {
  application: CommunityApplication;
  stop: () => void;
} {
  const application = ensureCommunityApplication(ambient);
  return {
    application,
    stop() {
      if (tryCommunityApplication() === application) unbindCommunityApplication();
    },
  };
}
