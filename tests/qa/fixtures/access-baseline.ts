import type { Pool } from 'pg';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';

/** Route fixtures need the same public-disclosure graph composition as Main. */
export function accessWithBaseline(pool: Pool, graph: Pick<FusekiClient, 'query'>,
  titleAdmissionKey?: string): AccessAdmissionRegistry {
  const access = new AccessAdmissionRegistry(pool, titleAdmissionKey);
  access.configureBaseline(graph);
  return access;
}
