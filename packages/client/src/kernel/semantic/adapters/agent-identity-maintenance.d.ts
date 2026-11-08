import type { AgentIdentityMaintenancePort } from '../../access/adapters/index.ts';
import { runIdentityTerminalCommand } from '../identity-terminal-closure-command.ts';
export type IdentityTerminalCommand = typeof runIdentityTerminalCommand;
/** Constructing this adapter dispatches no work. Opaque proof validation, native
 * receipt custody, bounded terminal drain/release and frame authority remain with
 * the original producers; each selected operation runs on the supplied host.
 */
export declare function createAgentIdentityMaintenance(): AgentIdentityMaintenancePort;
