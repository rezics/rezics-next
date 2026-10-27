import { locales } from '../paraglide/runtime.js';
import { pageLinks, type PagePaths } from '../shell/head.ts';

export const sitemapNamespace = 'http://www.sitemaps.org/schemas/sitemap/0.9';
export const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>\n';

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// Characters XML 1.0 cannot carry, even escaped.
const forbidden = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => escapes[char]!);
}

/** Cuts a value for an error message so a runaway path cannot fill a log line. */
export function shown(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

export function assertXmlText(value: string, label: string): void {
  if (forbidden.test(value)) throw new Error(`${label} contains a character XML cannot carry`);
}

export function assertOrigin(origin: string): void {
  let valid = false;
  try {
    const url = new URL(origin);
    valid = url.protocol === 'https:' && url.origin === origin;
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(`Sitemap origin must be an absolute https origin without a path: ${shown(origin)}`);
}

/** Normalizes an ISO 8601 timestamp with a zone to UTC `YYYY-MM-DDThh:mm:ssZ`, or returns undefined. */
export function utcLastmod(value: string): string | undefined {
  const match = timestamp.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [1, 2, 3, 4, 5, 6, 8, 9].map((index) =>
    Number(match[index] ?? 0),
  ) as [number, number, number, number, number, number, number, number];
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  if (offsetHour > 23 || offsetMinute > 59) return undefined;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  const offset = (match[7] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60_000;
  const iso = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset).toISOString();
  return /^\d{4}-/.test(iso) ? `${iso.slice(0, 19)}Z` : undefined;
}

/** The eight `<url>` records of one page family, one per locale, each listing all eight alternates. */
export function familyXml(origin: string, paths: PagePaths, lastmod?: string): { xml: string; urls: string[] } {
  const urls: string[] = [];
  let alternates = '';
  let xml = '';
  for (const locale of locales) {
    const links = pageLinks(origin, locale, '/', paths);
    if (alternates === '') {
      alternates = links
        .filter((link) => link.rel === 'alternate' && link.hrefLang !== 'x-default')
        .map((link) => `<xhtml:link rel="alternate" hreflang="${link.hrefLang}" href="${escapeXml(link.href)}"/>`)
        .join('');
    }
    const loc = links[0]!.href;
    urls.push(loc);
    xml += `<url><loc>${escapeXml(loc)}</loc>${lastmod === undefined ? '' : `<lastmod>${lastmod}</lastmod>`}${alternates}</url>`;
  }
  return { xml, urls };
}
