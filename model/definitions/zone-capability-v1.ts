import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const zoneCapabilityDeclaration = {
  id: 'zone-capability-v1',
  canonical: {
    zone: {
      types: ['rv:Zone'],
    },
    mount: {
      types: ['rv:ZoneMount'],
    },
    revision: {
      types: ['rv:ZoneRevision'],
    },
  },
} as const satisfies TurtleDeclaration;

export const zoneCapabilityProfile = parseTurtleProfile(
  zoneCapabilityDeclaration.id,
  readFileSync(new URL('./zone-capability-v1.ttl', import.meta.url), 'utf8'),
  zoneCapabilityDeclaration,
);
