import { Value } from 'typebox/value';
import { shapeSchemas } from './generated/schemas.ts';

/** Checks JSON-LD node value envelopes before submission; graph-wide validity is checked by Jena. */
export function checkNodeLocalCandidate(shapeIri: string, candidate: unknown): boolean {
  const schema = shapeSchemas[shapeIri as keyof typeof shapeSchemas];
  return schema !== undefined && Value.Check(schema, candidate);
}
