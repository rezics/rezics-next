import type { ZoneData } from '../../features/wiki/selection.ts';
import franchiseWiki from './franchise-wiki/declarations.json';

// What an official package declares for reading at the reader's position (`positions`, `continuity`), as data. The
// files are JSON so that reading them evaluates no code: safe mode and the standard look switch a package's code
// off, never the reader's position and continuity. Every package directory with a `declarations.json` is listed here
// (a test fails when one is missing); the package's `index.tsx` spreads the same file.
const declarations: Record<string, ZoneData> = {
  'franchise-wiki': franchiseWiki,
};

/** What the package for `slug` declares, or null for a package that declares nothing. */
export function declaredData(slug: string): Promise<ZoneData | null> {
  return Promise.resolve(Object.hasOwn(declarations, slug) ? declarations[slug]! : null);
}
