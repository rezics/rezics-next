/** A domain branch the anti-silo guard must reject. */
export function kindBranch(type: string): string {
  if (type === 'https://schema.org/VideoGame') return 'game';
  return 'shared';
}
