import type { SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { sessionSubject, viewerCredential } from '../session/request';

// Client-carried private command credentials use the same deployment key as label continuations.
// Rotation retires them. Neither a receipt lookup nor browser storage is involved.
const domain = 'rezics.library-entry-restore.v1';
const ivBytes = 12;
const gcmTagBytes = 16;
const base64urlLength = (bytes: number) => Math.ceil((4 * bytes) / 3);
const formTokenLimit = 3200;

// Use Auth's Kind consent allowance for a 16 KiB compact access token. Budget
// the Bearer prefix, 2 KiB for the serialized origin, the 43-character session
// cookie and the expected reader's 128 UTF-16 units (up to 6 JSON bytes each).
// The limit applies to the entire sealed JSON envelope.
const archiveSenderLimit = base64urlLength(
  16 * 1024 +
    'Bearer '.length +
    2048 +
    43 +
    128 * 6 +
    JSON.stringify({ binding: ['', '', ''], authorization: '' }).length +
    ivBytes +
    gcmTagBytes,
);

export function readArchiveSender(input: object): string | undefined {
  const sender = 'sender' in input ? input.sender : undefined;
  if (sender === undefined) return undefined;
  if (typeof sender !== 'string' || sender.length > archiveSenderLimit || !/^[A-Za-z0-9_-]+$/.test(sender))
    throw new Error('Invalid archive sender');
  return sender;
}

async function key(env: Partial<SessionEnv>) {
  if (!env.WEBSITE_CLIENT_KEY) throw new Error('Missing web credential');
  return crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${domain}\n${env.WEBSITE_CLIENT_KEY}`)),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}
const context = (env: Partial<SessionEnv>) =>
  new TextEncoder().encode(JSON.stringify([domain, env.AUTH_ISSUER, env.API_RESOURCE, env.WEBSITE_CLIENT_ID]));
const binding = (request: Request) => [
  new URL(request.url).origin,
  cookie(request, SESSION_COOKIE) ?? null,
  sessionSubject(request) ?? null,
];

/** Capture before the restore can be dispatched, alongside its deletion receipt. */
export function captureEntryRestoreCredential(request: Request, env: Partial<SessionEnv>) {
  return captureCredential(request, env, formTokenLimit, 'Restore credential exceeds form bound');
}

export function captureArchiveSenderCredential(request: Request, env: Partial<SessionEnv>) {
  return captureCredential(request, env, archiveSenderLimit, 'Archive sender exceeds JSON bound');
}

async function captureCredential(request: Request, env: Partial<SessionEnv>, limit: number, overflow: string) {
  // Explicit bearer clients own their credential and resubmit it themselves.
  if (request.headers.has('authorization') || !cookie(request, SESSION_COOKIE)) return undefined;
  const authorization = viewerCredential(request);
  if (!authorization || !sessionSubject(request)) throw new Error('Missing restore viewer');
  const plaintext = new TextEncoder().encode(JSON.stringify({ binding: binding(request), authorization }));
  if (base64urlLength(ivBytes + plaintext.byteLength + gcmTagBytes) > limit) throw new Error(overflow);
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(env) }, await key(env), plaintext),
  );
  return btoa(String.fromCharCode(...iv, ...encrypted))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function originalEntryRestoreCredential(request: Request, env: Partial<SessionEnv>, token?: string) {
  if (!token) return viewerCredential(request);
  const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, ivBytes), additionalData: context(env) },
    await key(env),
    bytes.slice(ivBytes),
  );
  const capture = JSON.parse(new TextDecoder().decode(decrypted)) as { binding: unknown; authorization: string };
  return JSON.stringify(capture.binding) === JSON.stringify(binding(request)) ? capture.authorization : null;
}
