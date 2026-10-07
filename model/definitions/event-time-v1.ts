import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const eventTimeDeclaration = {
  id: 'event-time-v1',
  canonical: {
    event: { types: ['rv:Event'] },
    slot: { types: ['rv:EventTime'] },
  },
} as const satisfies TurtleDeclaration;

export const eventTimeProfile = parseTurtleProfile(
  eventTimeDeclaration.id,
  readFileSync(new URL('./event-time-v1.ttl', import.meta.url), 'utf8'),
  eventTimeDeclaration,
);
