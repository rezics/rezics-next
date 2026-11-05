import type { AccessIO, AccessState } from './data';
import { AccessRecovery } from './recovery';

/** The existing controller owns the command; a route return only reattaches its view. */
export class AccessRecoveryVisits {
  private controllers = new Map<string, AccessRecovery>();

  resume(binding: string, initial: AccessState, io: AccessIO) {
    const retained = this.controllers.get(binding);
    if (retained?.snapshot().pending) return retained;
    const controller = new AccessRecovery(initial, io);
    this.controllers.set(binding, controller);
    return controller;
  }

  release(binding: string, controller: AccessRecovery) {
    controller.dispose();
    if (this.controllers.get(binding) === controller && !controller.snapshot().pending)
      this.controllers.delete(binding);
  }
}

// QueryClient is request-local on the server and belongs to one browser session owner.
const owners = new WeakMap<object, AccessRecoveryVisits>();
export function accessRecoveryVisits(owner: object) {
  let visits = owners.get(owner);
  if (!visits) {
    visits = new AccessRecoveryVisits();
    owners.set(owner, visits);
  }
  return visits;
}
