/** Constructed Zone resource command and read application over the Zone-owned Access port. */
import { createZoneCommands, zoneIfMatch } from './resource-commands.ts';
import { createZoneReads } from './resource-reads.ts';
import { bindZoneResourceAccess, tryZoneResourceAccess, zoneResourceAccess, type ZoneAccountActor, type ZoneActor, type ZoneResourceAccessPort, type ZoneResourceRuntimeDependencies } from './resource-access-port.ts';
export type ZoneResourceRuntime = Readonly<{
    commands: ReturnType<typeof createZoneCommands>;
    reads: ReturnType<typeof createZoneReads>;
}>;
/** Installed native create, configure, publish, owner reads, mutation and platform lifecycle. */
export type ZoneResourceApplication = {
    readonly access: ZoneResourceAccessPort;
    runtime(dependencies: ZoneResourceRuntimeDependencies): ZoneResourceRuntime;
    requireAccount(actor: ZoneActor): asserts actor is ZoneAccountActor;
    readonly ifMatch: typeof zoneIfMatch;
};
/** Use cases over the Zone-owned Access port. Native Access is never imported here. */
export declare function createZoneResourceApplication(port: ZoneResourceAccessPort): ZoneResourceApplication;
export declare function bindZoneResourceApplication(application: ZoneResourceApplication): ZoneResourceApplication;
export declare function zoneResourceApplication(): ZoneResourceApplication;
export declare function tryZoneResourceApplication(): ZoneResourceApplication | undefined;
/** Tests restore the process binding; createKernel rebinds native ports. */
export declare function unbindZoneResourceApplication(): void;
export declare function requireZoneResourceRuntime(dependencies: ZoneResourceRuntimeDependencies): ZoneResourceRuntime;
export { bindZoneResourceAccess, zoneResourceAccess, tryZoneResourceAccess };
