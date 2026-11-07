/** Bind Library Collection work and the Zone resource Access producer onto Zone ports. */

import { createZoneCollectionAdapter } from '../library/zone-collection-adapter.ts';
import { createZoneResourceAccessProducer } from '../access/zone-resource-adapter.ts';
import { createZoneResourceAccess } from '../zones/adapters/index.ts';
import { bindZoneCollectionPort, peekZoneCollectionPort, type ZoneCollectionPort } from '../zones/collection-port.ts';
import {
  bindZoneResourceAccess,
  bindZoneResourceApplication,
  createZoneResourceApplication,
  tryZoneResourceApplication,
  type ZoneResourceApplication,
} from '../zones/resource-application.ts';

export function composeZoneCollection(): ZoneCollectionPort {
  return peekZoneCollectionPort() ?? bindZoneCollectionPort(createZoneCollectionAdapter());
}

/** Ordinary createKernel/server/worker composition binds the Access producer to Zone resource commands and reads. */
export function composeZoneResource(): ZoneResourceApplication {
  if (tryZoneResourceApplication()) return tryZoneResourceApplication()!;
  const access = bindZoneResourceAccess(createZoneResourceAccess(createZoneResourceAccessProducer()));
  return bindZoneResourceApplication(createZoneResourceApplication(access));
}

export function composeZones(): ZoneResourceApplication {
  composeZoneCollection();
  return composeZoneResource();
}
