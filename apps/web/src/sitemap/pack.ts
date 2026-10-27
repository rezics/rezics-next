import { locales } from '../paraglide/runtime.js';
import type { PagePaths } from '../shell/head.ts';
import {
  assertOrigin,
  assertXmlText,
  escapeXml,
  familyXml,
  shown,
  sitemapNamespace,
  utcLastmod,
  xmlDeclaration,
} from './xml.ts';

/** One indexable page before locale expansion, with the time of the last change of what the page shows. */
export type SitemapFamily = { paths: PagePaths; lastmod: string };
export type SitemapShard = { digest: string; families: number; urls: number; bytes: number; gzip: Uint8Array };

const maxFamilies = 3_000;
const maxBytes = 40_000_000;
const maxIndexEntries = 50_000;
const header = `${xmlDeclaration}<urlset xmlns="${sitemapNamespace}" xmlns:xhtml="http://www.w3.org/1999/xhtml">`;
const footer = '</urlset>';
const encoder = new TextEncoder();
const wrapperBytes = encoder.encode(header).length + encoder.encode(footer).length;

type Open = {
  gzip: CompressionStream;
  writer: WritableStreamDefaultWriter<BufferSource>;
  output: Promise<Uint8Array>;
  families: number;
  urls: number;
  bytes: number;
};

function begin(): Open {
  const gzip = new CompressionStream('gzip');
  // Drain from the start so writes never wait on a reader that is not there yet.
  const output = new Response(gzip.readable).bytes();
  const open: Open = { gzip, writer: gzip.writable.getWriter(), output, families: 0, urls: 0, bytes: 0 };
  const head = encoder.encode(header);
  open.bytes = wrapperBytes;
  void open.writer.write(head);
  return open;
}

async function finish(open: Open): Promise<SitemapShard> {
  await open.writer.write(encoder.encode(footer));
  await open.writer.close();
  const gzip = await open.output;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', gzip));
  const digest = Array.from(hash.subarray(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { digest, families: open.families, urls: open.urls, bytes: open.bytes, gzip };
}

function label(family: SitemapFamily): string {
  const paths = family.paths as Partial<PagePaths> | undefined;
  return `family ${shown(paths?.en ?? Object.values(paths ?? {}).find((path) => typeof path === 'string') ?? '(no paths)')}`;
}

/**
 * Packs page families, in order, into gzip sitemap files of at most 3,000 families and 40,000,000 uncompressed bytes.
 * A family's eight locale records always share a file. Only the open file's compressed bytes are held.
 */
export async function packShards(origin: string, families: readonly SitemapFamily[]): Promise<SitemapShard[]> {
  assertOrigin(origin);
  const shards: SitemapShard[] = [];
  const seen = new Set<string>();
  let open: Open | undefined;
  for (const family of families) {
    const name = label(family);
    for (const locale of locales) {
      if (typeof family.paths?.[locale] !== 'string') throw new Error(`${name} has no path for locale ${locale}`);
    }
    const lastmod = utcLastmod(family.lastmod);
    if (lastmod === undefined) throw new Error(`${name} has an invalid lastmod: ${shown(String(family.lastmod))}`);
    const { xml, urls } = familyXml(origin, family.paths, lastmod);
    for (const url of urls) {
      assertXmlText(url, `${name} URL`);
      if (seen.has(url)) throw new Error(`${name} has a duplicate URL: ${shown(url)}`);
      seen.add(url);
    }
    const bytes = encoder.encode(xml);
    if (wrapperBytes + bytes.length > maxBytes) {
      throw new Error(
        `${name} is too large for an empty sitemap file: ${wrapperBytes + bytes.length} bytes, at most ${maxBytes}`,
      );
    }
    if (open && (open.families + 1 > maxFamilies || open.bytes + bytes.length > maxBytes)) {
      shards.push(await finish(open));
      open = undefined;
    }
    open ??= begin();
    await open.writer.write(bytes);
    open.families += 1;
    open.urls += urls.length;
    open.bytes += bytes.length;
  }
  if (open) shards.push(await finish(open));
  return shards;
}

/** A flat sitemap index: each entry is a root path on `origin` and the time its file last changed. */
export function sitemapIndexXml(origin: string, entries: readonly { path: string; lastmod: string }[]): string {
  assertOrigin(origin);
  if (entries.length === 0) throw new Error('A sitemap index needs at least one entry');
  if (entries.length > maxIndexEntries) {
    throw new Error(
      `A sitemap index holds at most ${maxIndexEntries.toLocaleString('en-US')} entries, got ${entries.length}`,
    );
  }
  let xml = `${xmlDeclaration}<sitemapindex xmlns="${sitemapNamespace}">`;
  for (const { path, lastmod } of entries) {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error(`Sitemap index path must be a root path: ${shown(path)}`);
    assertXmlText(path, 'Sitemap index path');
    const time = utcLastmod(lastmod);
    if (time === undefined)
      throw new Error(`Sitemap index entry ${shown(path)} has an invalid lastmod: ${shown(lastmod)}`);
    xml += `<sitemap><loc>${escapeXml(origin + path)}</loc><lastmod>${time}</lastmod></sitemap>`;
  }
  xml += '</sitemapindex>';
  if (encoder.encode(xml).length > maxBytes) throw new Error(`A sitemap index holds at most ${maxBytes} bytes`);
  return xml;
}
