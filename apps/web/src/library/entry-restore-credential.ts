import type { SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE } from '../session/cookies';
import { sessionSubject, viewerCredential } from '../session/request';

// Client-carried private command credentials use the same deployment key as label continuations.
// Rotation retires them. Neither a receipt lookup nor browser storage is involved.
const domain = 'rezics.library-entry-restore.v1';
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
export async function captureEntryRestoreCredential(request: Request, env: Partial<SessionEnv>) {
  // Explicit bearer clients own their credential and resubmit it themselves.
  if (!cookie(request, SESSION_COOKIE)) return undefined;
  const authorization = viewerCredential(request);
  if (!authorization || !sessionSubject(request)) throw new Error('Missing restore viewer');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(env) },
      await key(env),
      new TextEncoder().encode(JSON.stringify({ binding: binding(request), authorization })),
    ),
  );
  const token = btoa(String.fromCharCode(...iv, ...encrypted))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (token.length > 3200) throw new Error('Restore credential exceeds form bound');
  return token;
}

export async function originalEntryRestoreCredential(request: Request, env: Partial<SessionEnv>, token?: string) {
  if (!token) return viewerCredential(request);
  const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: context(env) },
    await key(env),
    bytes.slice(12),
  );
  const capture = JSON.parse(new TextDecoder().decode(decrypted)) as { binding: unknown; authorization: string };
  return JSON.stringify(capture.binding) === JSON.stringify(binding(request)) ? capture.authorization : null;
}
