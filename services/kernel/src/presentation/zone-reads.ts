import canonicalize from 'canonicalize';
import { validateSearchLimit } from '../search/hits.ts';
import type { PageRead } from './reads.ts';

/** Match `readPage`'s search canonical form so Zone-restricted results cannot leak into a global TypeList dispatch. */
export function zoneObservedReadKey(descriptor: PageRead, languages?: readonly string[]): string {
  if (descriptor.kind !== 'search') return canonicalize(descriptor)!;
  return canonicalize({
    ...descriptor,
    kind: 'search',
    body: {
      ...descriptor.body,
      limit: validateSearchLimit((descriptor.body as { limit?: unknown }).limit),
      ...(languages === undefined ? {} : { languages: [...languages] }),
    },
  })!;
}
