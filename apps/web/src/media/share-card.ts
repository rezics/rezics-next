import type { CoverSummary } from '@rezics/ui/cover';
import { locales, type Locale } from '../paraglide/runtime.js';

export const shareCardSize = { width: 1200, height: 630 } as const;
export const shareCardTitleLimit = 240;
export const shareCardId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type ShareCardTarget = { id: string; locale: Locale };
/** A projection of one current anonymous page, never a request's display text. */
export type ShareCardPage = ShareCardTarget & { title: string; types: readonly string[]; cover?: CoverSummary };
export type ShareCardProjection =
  | { kind: 'ready'; page: ShareCardPage }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

export function shareCardTitle(value: string): string {
  const text = value
    .slice(0, 1024)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(text);
  return characters.length > shareCardTitleLimit ? `${characters.slice(0, shareCardTitleLimit - 1).join('')}…` : text;
}

/** Locale and identity are the entire public input. Query text, cookies and validators confer no authority. */
export function shareCardTarget(request: Request): ShareCardTarget | undefined {
  const match = /^\/([^/]+)\/cards\/([^/]+)\.png$/.exec(new URL(request.url).pathname);
  const locale = locales.find((locale) => locale === match?.[1]);
  return locale && match?.[2] && shareCardId.test(match[2]) ? { locale, id: match[2] } : undefined;
}

export type ShareCardRenderer = (page: ShareCardPage) => Promise<Uint8Array<ArrayBuffer>>;

function pngDimensions(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24 || bytes.byteLength > 4 * 1024 * 1024) return false;
  if (![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].every((byte, i) => bytes[i] === byte))
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(16) === shareCardSize.width && view.getUint32(20) === shareCardSize.height;
}

export async function shareCardResponse(
  request: Request,
  source: {
    read: (target: ShareCardTarget) => Promise<ShareCardProjection>;
    render: ShareCardRenderer;
  },
): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
  const failure = (status: number) =>
    new Response(request.method === 'HEAD' ? null : status === 404 ? 'Not found' : 'Service unavailable', {
      status,
      headers,
    });
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  const target = shareCardTarget(request);
  if (!target) return failure(404);
  try {
    const result = await source.read(target);
    if (result.kind !== 'ready') return failure(result.kind === 'missing' ? 404 : 503);
    if (result.page.id !== target.id || result.page.locale !== target.locale) return failure(503);
    // HEAD still rechecks disclosure. No page, title, PNG, ETag or 304 cache survives a request.
    const bytes = request.method === 'HEAD' ? null : await source.render(result.page);
    if (bytes && !pngDimensions(bytes)) return failure(503);
    return new Response(bytes, { headers: { ...headers, 'content-type': 'image/png' } });
  } catch {
    return failure(503);
  }
}
