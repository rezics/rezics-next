import { cookie, SESSION_COOKIE } from './cookies.ts';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const formLimit = 4 * 1024;

export function carriesSession(request: Request): boolean {
  return cookie(request, SESSION_COOKIE) !== undefined;
}

export function isUnsafeRequest(request: Request): boolean {
  return !safeMethods.has(request.method.toUpperCase());
}

export function isAllowedSiteOrigin(request: Request, origin: string | null, configured: string | undefined): boolean {
  if (origin === null) return false;
  const value = configured ?? '';
  const allowed = value.trim() === '' ? developmentOrigin(request) : configuredOrigins(value);
  return allowed.includes(origin);
}

function developmentOrigin(request: Request): string[] {
  return process.env.NODE_ENV === 'production' ? [] : [new URL(request.url).origin];
}

function configuredOrigins(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(isExactOrigin),
    ),
  ];
}

function isExactOrigin(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

export function newCsrfToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export function csrfTokenMatches(expected: string | undefined, supplied: string | null): boolean {
  const expectedBytes = decodeToken(expected);
  const suppliedBytes = decodeToken(supplied ?? undefined);
  if (!expectedBytes || !suppliedBytes) return false;
  let difference = 0;
  for (let index = 0; index < 16; index += 1) difference |= expectedBytes[index]! ^ suppliedBytes[index]!;
  return difference === 0;
}

function decodeToken(token: string | undefined): Uint8Array | undefined {
  if (!token || !/^[A-Za-z0-9_-]{22}$/.test(token)) return undefined;
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/') + '==');
    if (binary.length !== 16) return undefined;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function csrfTokenFromRequest(request: Request): Promise<string | null> {
  const header = request.headers.get('X-CSRF-Token');
  if (header !== null) return header;
  if (
    !/^\/(?:auth\/sign-out|library\/entry|(?:(?:de|en|es|fr|ja|ko|zh-Hans|zh-Hant)\/)?library\/(?:copies|labels)|(?:de|en|es|fr|ja|ko|zh-Hans|zh-Hant)\/settings)$/.test(
      new URL(request.url).pathname,
    )
  )
    return null;
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > formLimit)) return null;
  if (!request.body) return null;

  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > formLimit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const tokens = form.getAll('csrf_token');
  return tokens.length === 1 ? tokens[0]! : null;
}
