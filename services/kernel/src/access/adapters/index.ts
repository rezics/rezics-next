export { accessApplication, bindAccessApplication, tryAccessApplication, unbindAccessApplication } from './bind.ts';
export { createNativeAccessPorts, type NativeAccessLibraryBindings } from './native.ts';
/** Producer entry used by process composition; consumers depend on their own ports. */
export { readAccount } from '../account-data.ts';
export { classifyUnavailability } from '../unavailable.ts';

export { agentIdentityMaintenance, bindAgentIdentityMaintenance } from './bind.ts';
export type { AgentIdentityMaintenancePort } from './identity-maintenance.ts';
export { createNativeAccessReadingPorts } from './reading.ts';
export { createNativeCopyAccountAdmission, nativeCopyAccountWork } from './copy-account.ts';
