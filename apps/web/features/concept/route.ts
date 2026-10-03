import { parseAddressSegment } from '../address/path.ts';

export function parseConceptRef(ref: string): string | null {
  const parsed = parseAddressSegment(ref);
  return parsed && parsed.kind !== 'alias' ? parsed.id : null;
}
