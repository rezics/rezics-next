/** Constructed Zone resource command and read application over the Zone-owned Access port. */

import { createZoneCommands, zoneIfMatch, type ZoneCommandDependencies } from './resource-commands.ts';
import { createZoneReads, requireZoneAccount, type ZoneReadDependencies } from './resource-reads.ts';
import {
  bindZoneResourceAccess,
  tryZoneResourceAccess,
  zoneResourceAccess,
  type ZoneAccountActor,
  type ZoneActor,
  type ZoneResourceAccessPort,
  type ZoneResourceRuntimeDependencies,
} from './resource-access-port.ts';

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

let bound: ZoneResourceApplication | undefined;

/** Use cases over the Zone-owned Access port. Native Access is never imported here. */
export function createZoneResourceApplication(port: ZoneResourceAccessPort): ZoneResourceApplication {
  return Object.freeze({
    access: port,
    runtime(dependencies: ZoneResourceRuntimeDependencies): ZoneResourceRuntime {
      const boundDependencies = { ...dependencies, ports: port } satisfies ZoneCommandDependencies &
        ZoneReadDependencies;
      return Object.freeze({
        commands: createZoneCommands(boundDependencies),
        reads: createZoneReads(boundDependencies),
      });
    },
    requireAccount: requireZoneAccount,
    ifMatch: zoneIfMatch,
  });
}

export function bindZoneResourceApplication(application: ZoneResourceApplication): ZoneResourceApplication {
  bound = application;
  return application;
}

export function zoneResourceApplication(): ZoneResourceApplication {
  if (!bound) throw new TypeError('Zone resource application is not composed');
  return bound;
}

export function tryZoneResourceApplication(): ZoneResourceApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindZoneResourceApplication(): void {
  bound = undefined;
}

export function requireZoneResourceRuntime(dependencies: ZoneResourceRuntimeDependencies): ZoneResourceRuntime {
  return (bound ?? createZoneResourceApplication(tryZoneResourceAccess() ?? zoneResourceAccess())).runtime(
    dependencies,
  );
}

export { bindZoneResourceAccess, zoneResourceAccess, tryZoneResourceAccess };
