export { bindWorkApplication, tryWorkApplication, unbindWorkApplication, workApplication } from './bind.ts';
export {
  assertSelectedWorkClient,
  bindSelectedWorkClient,
  selectedWorkClientPool,
  unbindSelectedWorkClient,
} from './client-binding.ts';

import { createWorkApplication } from '../application/index.ts';
import { bindWorkApplication, tryWorkApplication } from './bind.ts';
import type { WorkApplication, WorkApplicationPorts } from '../contract/index.ts';

/** Native adapters load when composition or a facade first needs them. */
export function createNativeWorkPorts(
  authorizationFactory?: typeof import('../authorization.ts').createWorkerAuthorization,
): WorkApplicationPorts {
  return (require('./native.ts') as typeof import('./native.ts')).createNativeWorkPorts(authorizationFactory);
}

/** Bind native ports when composition has not yet installed an application. */
export function ensureNativeWorkApplication(): WorkApplication {
  return tryWorkApplication() ?? bindWorkApplication(createWorkApplication(createNativeWorkPorts()));
}
