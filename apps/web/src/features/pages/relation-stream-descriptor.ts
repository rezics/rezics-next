import type { PageRead } from '@rezics/composition';

/** Compare the stream and its page bound, excluding the opaque continuation position.
 * Direction is represented by links (inverse) versus relations (forward).
 * This is publication admission only; native reads still own authorization and cursor validation.
 */
export function sameRelationStream(initial: PageRead, next: PageRead): boolean {
  if (
    (initial.kind !== 'links' && initial.kind !== 'relations') ||
    (next.kind !== 'links' && next.kind !== 'relations')
  )
    return false;
  return (
    initial.kind === next.kind &&
    initial.id === next.id &&
    initial.context === next.context &&
    initial.property === next.property &&
    initial.filter === next.filter &&
    initial.type === next.type &&
    initial.limit === next.limit
  );
}
