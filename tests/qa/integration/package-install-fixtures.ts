import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { syntheticPackument, syntheticTarball, type SyntheticNpmRegistry }
  from '../fixtures/npm-registry-synthetic.ts';

/** One raw tar entry; `path` is written verbatim so hostile names can be expressed. */
export interface TarEntry {
  path: string;
  type?: '0' | '1' | '2' | '3' | '5';
  content?: string;
  link?: string;
  mode?: number;
}

function header(name: string, size: number, type: string, link: string, mode: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
  block.write('0000000\0', 108, 8);
  block.write('0000000\0', 116, 8);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  block.write('00000000000\0', 136, 12);
  block.write('        ', 148, 8);
  block.write(type, 156, 1);
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6);
  block.write('00', 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function padded(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}

/** A gzip ustar archive; names over 100 bytes use a pax `path` record. */
export function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? '0';
    const data = Buffer.from(type === '0' ? entry.content ?? '' : '');
    if (Buffer.byteLength(entry.path) > 100) {
      const record = ` path=${entry.path}\n`;
      let length = record.length + 2;
      while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
      const pax = Buffer.from(`${length}${record}`);
      blocks.push(header('PaxHeader', pax.length, 'x', '', 0o644), padded(pax));
    }
    blocks.push(header(entry.path.slice(0, 100), data.length, type, entry.link ?? '', entry.mode ?? 0o644),
      padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export function packageFiles(name: string, version: string, extra: TarEntry[] = [],
  scripts?: Record<string, string>): TarEntry[] {
  return [{ path: 'package/package.json', content: JSON.stringify({ name, version,
    ...scripts ? { scripts } : {} }) }, { path: 'package/index.js', content: `module.exports = '${name}@${version}';\n` },
  ...extra];
}

export interface ArchiveRegistry {
  packages: Record<string, { tags?: Record<string, string>;
    versions: Record<string, { deps?: Record<string, string>; entries?: TarEntry[];
      scripts?: Record<string, string>; installScript?: boolean }> }>;
  tamper: Set<string>;
  missing: Set<string>;
}

/** A fixed-origin npm registry double that serves real tarballs whose SRI matches the packument. */
export function archiveNpmFetcher(registry: ArchiveRegistry) {
  const requests: string[] = [];
  const bytes = (name: string, version: string) => {
    const item = registry.packages[name]!.versions[version]!;
    return tarGz(item.entries ?? packageFiles(name, version, [], item.scripts));
  };
  const synthetic = (): SyntheticNpmRegistry => Object.fromEntries(Object.entries(registry.packages)
    .map(([name, item]) => [name, { tags: item.tags, versions: Object.fromEntries(Object.entries(item.versions)
      .map(([version, entry]) => [version, { deps: entry.deps, installScript: entry.installScript,
        integrity: `sha512-${createHash('sha512').update(bytes(name, version)).digest('base64')}` }])) }]));
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (init?.redirect !== 'error') throw new Error('registry requests must refuse redirects');
    if (!url.startsWith('https://registry.npmjs.org/')) throw new Error(`unexpected origin ${url}`);
    const path = url.slice('https://registry.npmjs.org/'.length);
    if (path.includes('/-/')) {
      const match = /^(.*)\/-\/.*-(\d+\.\d+\.\d+)\.tgz$/.exec(path);
      if (!match || registry.missing.has(url) || !registry.packages[match[1]!]?.versions[match[2]!]) {
        return new Response('missing', { status: 404 });
      }
      const served = bytes(match[1]!, match[2]!);
      return new Response(registry.tamper.has(url) ? Buffer.concat([served, Buffer.from('changed')]) : served);
    }
    const name = decodeURIComponent(path);
    if (!registry.packages[name]) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(syntheticPackument(name, synthetic()), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, requests, tarball: syntheticTarball, bytes };
}
