import type { AccessApplication } from '../contract/index.ts';
import type { AgentIdentityMaintenancePort } from './identity-maintenance.ts';
export declare function bindAccessApplication(application: AccessApplication, maintenance?: AgentIdentityMaintenancePort): AccessApplication;
export declare function accessApplication(): AccessApplication;
export declare function tryAccessApplication(): AccessApplication | undefined;
/** Tests restore the process binding; createKernel rebinds native ports. */
export declare function unbindAccessApplication(): void;
/** Native identity callers share the Access composition lifetime. */
export declare function agentIdentityMaintenance(): AgentIdentityMaintenancePort;
/** Restore the previous capability when a focused test or isolated composition ends. */
export declare function bindAgentIdentityMaintenance(port: AgentIdentityMaintenancePort): () => void;
