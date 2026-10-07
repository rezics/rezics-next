import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const relationOccurrenceDeclaration = {
  id: 'relation-occurrence-v1',
  canonical: {
    occurrence: { types: ['rv:RelationOccurrence'] },
    participation: { types: ['rv:RelationParticipation'] },
    revision: { types: ['rv:RelationOccurrenceRevision'] },
  },
} as const satisfies TurtleDeclaration;

export const relationOccurrenceProfile = parseTurtleProfile(
  relationOccurrenceDeclaration.id,
  readFileSync(new URL('./relation-occurrence-v1.ttl', import.meta.url), 'utf8'),
  relationOccurrenceDeclaration,
);
