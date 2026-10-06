import { packageDigest, type ZonePackage } from '@rezics/zone-sdk';

// The official Zone packages this build carries: reviewed first-party code,
// one directory per official route segment. A package is loaded only for a
// view where Main reports an active approval of exactly its digest
// (features/zones/execution.ts); otherwise it is never imported. Only a package's plain-data declarations
// (`declaredData`) are read when its code is switched off by the reader.

const entries = import.meta.glob<ZonePackage>('./*/index.tsx', { import: 'default' });
// A package's position and continuity declarations, in a file of plain data that imports no code of the package.
const declared = import.meta.glob<Pick<ZonePackage, 'positions' | 'continuity'>>('./*/declarations.ts', { import: 'default' });
const files = import.meta.glob<string>('./*/**/*', { query: '?raw', import: 'default' });

const digests = new Map<string, Promise<string | null>>();

async function digestOf(slug: string): Promise<string | null> {
  const prefix = `./${slug}/`;
  const paths = Object.keys(files).filter(path => path.startsWith(prefix));
  if (!paths.length) return null;
  const contents = await Promise.all(paths.map(async path => [path.slice(prefix.length), await files[path]!()] as const));
  return packageDigest(Object.fromEntries(contents));
}

/** The digest of this build's package for `slug` (`packageDigest` over its files), or null when it has none. */
export function installedDigest(slug: string): Promise<string | null> {
  let digest = digests.get(slug);
  if (!digest) digests.set(slug, digest = digestOf(slug));
  return digest;
}

/** Imports the package; call only after the execution decision allowed it. */
export async function loadPackage(slug: string): Promise<ZonePackage | null> {
  const entry = entries[`./${slug}/index.tsx`];
  return entry ? entry() : null;
}

/**
 * What the package declares for reading at the reader's position (`positions`, `continuity`), without importing
 * the package: safe mode and the standard look turn its code off, never the reader's selection. Empty for a package
 * with no declarations file.
 */
export async function declaredData(slug: string): Promise<Pick<ZonePackage, 'positions' | 'continuity'> | null> {
  const entry = declared[`./${slug}/declarations.ts`];
  return entry ? entry() : null;
}
