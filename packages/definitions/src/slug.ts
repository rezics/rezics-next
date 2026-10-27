const limit = 60;

/** Canonical URL slug of a display label, shared by subjects and threads. */
export function slug(label: string): string {
  const words = label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const points = Array.from(words);
  if (points.length <= limit) return words || 'subject';
  const head = points.slice(0, limit);
  const cut = head.lastIndexOf('-');
  const kept = (cut > 0 ? head.slice(0, cut) : head).join('').replace(/^-+|-+$/g, '');
  return kept || 'subject';
}

export const subjectSlug = slug;
