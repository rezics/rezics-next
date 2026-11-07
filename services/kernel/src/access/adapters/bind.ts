import type { AccessApplication } from '../contract/index.ts';

import type { AgentIdentityMaintenancePort } from './identity-maintenance.ts';

let bound: AccessApplication | undefined;
let identityMaintenance: AgentIdentityMaintenancePort | undefined;

export function bindAccessApplication(
  application: AccessApplication,
  maintenance?: AgentIdentityMaintenancePort,
): AccessApplication {
  identityMaintenance = maintenance;
  bound = application;
  return application;
}

export function accessApplication(): AccessApplication {
  if (!bound) throw new Error('Access application is not bound');
  return bound;
}

export function tryAccessApplication(): AccessApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindAccessApplication(): void {
  bound = undefined;
  identityMaintenance = undefined;
}

/** Native identity callers share the Access composition lifetime. */
export function agentIdentityMaintenance(): AgentIdentityMaintenancePort {
  if (!identityMaintenance) throw new Error('Access agent identity maintenance is not bound');
  return identityMaintenance;
}

/** Restore the previous capability when a focused test or isolated composition ends. */
export function bindAgentIdentityMaintenance(port: AgentIdentityMaintenancePort): () => void {
  const previous = identityMaintenance;
  identityMaintenance = port;
  return () => {
    identityMaintenance = previous;
  };
}
