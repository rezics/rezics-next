import { createHash } from 'node:crypto';

export interface SyntheticNpmVersion {
  deps?: Record<string, string>; optional?: Record<string, string>; peers?: Record<string, string>;
  peerOptional?: string[]; os?: string[]; cpu?: string[]; libc?: string[]; deprecated?: string;
  engines?: { node?: string; npm?: string }; bundled?: string[]; installScript?: boolean; tarball?: string;
  integrity?: string | null;
}
export type SyntheticNpmRegistry = Record<string, { tags?: Record<string, string>;
  versions: Record<string, SyntheticNpmVersion>; extra?: Record<string, unknown> }>;
export interface SyntheticNpmFaults {
  /** Tarball URLs whose served bytes differ from the published SRI. */
  tamper?: Set<string>; missingTarballs?: Set<string>; unavailable?: Set<string>; malformed?: Set<string>;
  oversizedTarballs?: Set<string>;
}
export function syntheticTarball(name: string, version: string): string {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}
function tarballBytes(name: string, version: string): Buffer { return Buffer.from(`synthetic ${name}@${version}\n`); }
export function syntheticIntegrity(name: string, version: string): string {
  return `sha512-${createHash('sha512').update(tarballBytes(name, version)).digest('base64')}`;
}
export function syntheticPackument(name: string, registry: SyntheticNpmRegistry): string {
  const entry = registry[name]!;
  const versions = Object.keys(entry.versions);
  const latest = entry.tags?.latest ?? versions[versions.length - 1]!;
  return JSON.stringify({ name, 'dist-tags': { ...entry.tags, latest }, modified: '2026-09-27T00:00:00.000Z',
    versions: Object.fromEntries(Object.entries(entry.versions).map(([version, item]) => [version, {
      name, version, ...item.deps ? { dependencies: item.deps } : {},
      ...item.optional ? { optionalDependencies: item.optional, dependencies: { ...item.deps, ...item.optional } } : {},
      ...item.peers ? { peerDependencies: item.peers } : {},
      ...item.peerOptional ? { peerDependenciesMeta: Object.fromEntries(item.peerOptional.map(peer => [peer, { optional: true }])) } : {},
      ...item.os ? { os: item.os } : {}, ...item.cpu ? { cpu: item.cpu } : {}, ...item.libc ? { libc: item.libc } : {},
      ...item.deprecated ? { deprecated: item.deprecated } : {}, ...item.engines ? { engines: item.engines } : {},
      ...item.bundled ? { bundleDependencies: item.bundled } : {}, ...item.installScript ? { hasInstallScript: true } : {},
      dist: { tarball: item.tarball ?? syntheticTarball(name, version),
        ...item.integrity === null ? {} : { integrity: item.integrity ?? syntheticIntegrity(name, version) } },
    }])), ...entry.extra });
}
/** A fixed-origin registry double: counts every request and serves exact SRI-consistent tarballs. */
export function syntheticNpmFetcher(registry: SyntheticNpmRegistry, faults: SyntheticNpmFaults = {}) {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (init?.redirect !== 'error') throw new Error('registry requests must refuse redirects');
    if (!url.startsWith('https://registry.npmjs.org/')) throw new Error(`unexpected origin ${url}`);
    const path = url.slice('https://registry.npmjs.org/'.length);
    if (path.includes('/-/')) {
      const match = /^(.*)\/-\/.*-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(path);
      if (!match || faults.missingTarballs?.has(url) || !registry[match[1]!]) return new Response('missing', { status: 404 });
      if (faults.oversizedTarballs?.has(url)) {
        return new Response(new Uint8Array(33 * 1024 * 1024));
      }
      const bytes = tarballBytes(match[1]!, match[2]!);
      return new Response(faults.tamper?.has(url) ? Buffer.concat([bytes, Buffer.from('tampered')]) : bytes);
    }
    const name = decodeURIComponent(path);
    if (faults.unavailable?.has(name)) return new Response('unavailable', { status: 503 });
    if (faults.malformed?.has(name)) return new Response('{"name":');
    if (!registry[name]) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(syntheticPackument(name, registry), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, requests };
}
