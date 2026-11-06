export {
  bindWorkApplication,
  tryWorkApplication,
  unbindWorkApplication,
  workApplication,
} from './bind.ts';
export { createNativeWorkPorts } from './native.ts';
export {
  assertSelectedWorkClient,
  bindSelectedWorkClient,
  selectedWorkClientPool,
  unbindSelectedWorkClient,
} from './client-binding.ts';

import { createWorkApplication } from '../application/index.ts';
import { bindWorkApplication, tryWorkApplication } from './bind.ts';
import { createNativeWorkPorts } from './native.ts';
import type { WorkApplication } from '../contract/index.ts';

/** Bind native ports when composition has not yet installed an application. */
export function ensureNativeWorkApplication(): WorkApplication {
  return tryWorkApplication() ?? bindWorkApplication(createWorkApplication(createNativeWorkPorts()));
}
