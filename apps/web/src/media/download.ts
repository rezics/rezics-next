import { viewerCredential } from '../session/request.ts';
import { authorizeDownload, mediaClient, notFound, problem, problemResponse } from './kernel.ts';
import type { MediaEnv } from './index.ts';

export { validVariant } from './cover-src.ts';

function matchesValidator(header: string | null, etag: string): boolean {
  // Entity tags are quoted strings; commas inside a tag do not separate validators.
  return (header?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []).some(
    (tag) => tag === '*' || tag.replace(/^W\//, '') === etag,
  );
}

type EntityTag = { weak: boolean; opaqueTag: string };

function skipOws(value: string, offset: number): number {
  while (value[offset] === ' ' || value[offset] === '\t') offset++;
  return offset;
}

function trimOws(value: string): string {
  const start = skipOws(value, 0);
  let end = value.length;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end--;
  return value.slice(start, end);
}

function parseEntityTag(value: string): EntityTag | null {
  const weak = value.startsWith('W/');
  const quote = weak ? 2 : 0;
  if (value.length < quote + 2 || value[quote] !== '"' || value.at(-1) !== '"') return null;
  for (let index = quote + 1; index < value.length - 1; index++) {
    const code = value.charCodeAt(index);
    if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) return null;
  }
  return { weak, opaqueTag: value.slice(quote + 1, -1) };
}

function parseEntityTagList(header: string | null): '*' | EntityTag[] | null {
  if (header === null) return null;
  let offset = skipOws(header, 0);
  if (header[offset] === '*') return skipOws(header, offset + 1) === header.length ? '*' : null;

  const tags: EntityTag[] = [];
  while (offset < header.length) {
    offset = skipOws(header, offset);
    if (offset === header.length) break;
    if (header[offset] === ',') {
      offset++;
      continue;
    }

    const weak = header.startsWith('W/', offset);
    if (weak) offset += 2;
    if (header[offset] !== '"') return null;
    const quote = offset++;
    while (offset < header.length && header[offset] !== '"') {
      const code = header.charCodeAt(offset);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) return null;
      offset++;
    }
    if (offset === header.length) return null;
    tags.push({ weak, opaqueTag: header.slice(quote + 1, offset) });
    offset = skipOws(header, offset + 1);
    if (offset < header.length && header[offset] !== ',') return null;
    if (header[offset] === ',') offset++;
  }
  return tags.length > 0 ? tags : null;
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  const validators = parseEntityTagList(header);
  if (validators === '*') return true;
  if (validators === null) return false;
  // The full list was validated above, so fragment matches cannot rescue a malformed value.
  return matchesValidator(header, etag);
}

function matchesIfRange(header: string, etag: string): boolean {
  const candidate = parseEntityTag(trimOws(header));
  const current = parseEntityTag(etag);
  return (
    candidate !== null &&
    current !== null &&
    !candidate.weak &&
    !current.weak &&
    candidate.opaqueTag === current.opaqueTag
  );
}

type Range = { offset: number; length: number };
function byteRange(header: string | null, size: number): Range | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (!match[1] && !match[2])) return undefined;
  // BigInt handles arbitrarily large client-supplied offsets without rounding.
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n || total === 0n) return 'unsatisfiable';
    const length = suffix < total ? suffix : total;
    return { offset: Number(total - length), length: Number(length) };
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (match[2] && end < start) return undefined;
  if (start >= total) return 'unsatisfiable';
  return { offset: Number(start), length: Number((end < total ? end : total - 1n) - start + 1n) };
}

function extension(type: string): string {
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/tiff': 'tif',
    'image/x-icon': 'ico',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/octet-stream': 'bin',
    'text/plain': 'txt',
  };
  return extensions[type] ?? 'bin';
}

export async function download(request: Request, id: string, variant: string, env: MediaEnv): Promise<Response> {
  const decision = await authorizeDownload(mediaClient(env.KERNEL_ORIGIN), id, variant, viewerCredential(request));
  if (decision.allowed !== true) throw notFound();
  const etag = `"${decision.sha256}"`;
  const headers = new Headers({ etag, 'cache-control': decision.cacheControl });
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers });

  const metadata = await env.MEDIA.head(decision.key);
  if (!metadata) throw notFound();
  const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
  const ifRange = request.headers.get('if-range');
  const range =
    rangeHeader !== null && (ifRange === null || matchesIfRange(ifRange, etag))
      ? byteRange(rangeHeader, metadata.size)
      : undefined;
  if (range === 'unsatisfiable') {
    const response = problemResponse(problem(416, 'invalid_request', 'Invalid Request'));
    response.headers.set('content-range', `bytes */${metadata.size}`);
    response.headers.set('etag', etag);
    response.headers.set('cache-control', decision.cacheControl);
    return new Response(request.method === 'HEAD' ? null : response.body, response);
  }
  headers.set('content-type', decision.mediaType);
  headers.set('content-length', String(range?.length ?? metadata.size));
  headers.set('accept-ranges', 'bytes');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; sandbox");
  headers.set(
    'content-disposition',
    `${variant === 'original' ? 'attachment' : 'inline'}; filename="${id}-${variant}.${extension(decision.mediaType)}"`,
  );
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  let body: ReadableStream | null = null;
  if (request.method !== 'HEAD') {
    const object = await env.MEDIA.get(decision.key, range ? { range } : {});
    if (!object) throw notFound();
    body = object.body;
    // Use the actual stored object's size, never the declared byte count.
    headers.set('content-length', String(object.range && 'length' in object.range ? object.range.length : object.size));
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}
