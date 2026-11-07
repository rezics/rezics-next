/** Bind Library Collection work, mounted reads and the owner resource schema onto the Zone port. */

import { createZoneCollectionAdapter } from '../library/zone-collection-adapter.ts';
import { bindZoneCollectionPort, peekZoneCollectionPort, type ZoneCollectionPort } from '../zones/collection-port.ts';

export function composeZoneCollection(): ZoneCollectionPort {
  return peekZoneCollectionPort() ?? bindZoneCollectionPort(createZoneCollectionAdapter());
}
