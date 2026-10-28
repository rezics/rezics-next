import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { readZoneHead, type ZoneHead } from './resource-store.ts';

/** Separate lifecycle evidence survives all ordinary resource state changes. */
export function zoneWithheld(row: ZoneHead, pointer: string): boolean {
  const value = row.withholding;
  if (value === null || typeof value !== 'object') return false;
  for (let path = pointer; ; path = path.slice(0, path.lastIndexOf('/'))) {
    if (Object.hasOwn(value, path)) return true;
    if (path === '') return false;
  }
}
export function zoneReadable(row: ZoneHead): boolean {
  return row.state === 'active' && row.configuration !== null && !zoneWithheld(row, '');
}
/** Prepare outside checkout; current head and public floor are verified on the reader's RR client at native T. */
export function zoneReadEligibility(resource: { route: number; id: string }) {
  return createResourcePublicEligibility({
    resource,
    action: 'zone:read',
    async prepare({ pool }) {
      const head = await readZoneHead(pool, resource.route, resource.id);
      return { revision: head?.revision ?? null };
    },
    async verify({ client, evidence }) {
      const head = await readZoneHead(client, resource.route, resource.id);
      return (
        head !== null && head.revision === evidence.revision && zoneReadable(head) && head.visibility !== 'private'
      );
    },
  });
}
