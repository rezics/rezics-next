import { viewerCredential } from '../session/request.ts';
import { authorizeDownload, mediaClient, notFound, problem, problemResponse } from './kernel.ts';
import type { MediaEnv } from './index.ts';

export const validVariant = (variant: string) =>
  /^(?:original|(?:webp|avif)-(?:320|640|960|1280|1920|2560))$/.test(variant);

function matchesValidator(header: string | null, etag: string): boolean {
  // Entity tags are quoted strings; commas inside a tag do not separate validators.
  return (header?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) ?? []).some(
    (tag) => tag === '*' || tag.replace(/^W\//, '') === etag,
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
  if (matchesValidator(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });

  const metadata = await env.MEDIA.head(decision.key);
  if (!metadata) throw notFound();
  const range = byteRange(request.headers.get('range'), metadata.size);
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
