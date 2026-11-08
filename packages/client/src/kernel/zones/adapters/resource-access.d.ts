/** Installed native Access adapter for Zone resource operations. Composition binds the Access producer here. */
import { type ZoneResourceAccessProducer } from '../../access/zone-resource-adapter.ts';
import type { ZoneResourceAccessPort } from '../resource-access-port.ts';
/** Native Zone Access adapter. Ordinary composition supplies the Access producer. */
export declare function createZoneResourceAccess(producer?: ZoneResourceAccessProducer): ZoneResourceAccessPort;
