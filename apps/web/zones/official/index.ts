import { packageDigest, type ZonePackage } from '@rezics/zone-sdk';

// The official Zone packages this build carries: reviewed first-party code,
// one directory per official route segment. A package is loaded only for a
// view where Main reports an active approval of exactly its digest
// (features/zones/execution.ts); otherwise it is never imported.

const entries = import.meta.glob<ZonePackage>('./*/index.tsx', { import: 'default' });
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
