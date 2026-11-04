import type { SessionEnv } from '../../session/client';
import { cookie, SESSION_COOKIE } from '../../session/cookies';

const domain = 'rezics.private-annotations.v1';
type Identity = { viewer: string; csrfToken: string; authorization: string };
const context = (env: Partial<SessionEnv>) =>
  new TextEncoder().encode(JSON.stringify([domain, env.AUTH_ISSUER, env.API_RESOURCE, env.WEBSITE_CLIENT_ID]));
const binding = (request: Request, viewer: string, subjectId: string) => [
  new URL(request.url).origin,
  cookie(request, SESSION_COOKIE),
  viewer,
  subjectId,
];
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

/** The reviewed read captures the credential before any annotation dispatch can become uncertain. */
export async function captureAnnotationCredential(
  request: Request,
  env: Partial<SessionEnv>,
  identity: Identity,
  subjectId: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(env) },
      await key(env),
      new TextEncoder().encode(
        JSON.stringify({
          binding: binding(request, identity.viewer, subjectId),
          csrfToken: identity.csrfToken,
          authorization: identity.authorization,
        }),
      ),
    ),
  );
  const token = btoa(String.fromCharCode(...iv, ...encrypted))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (token.length > 6400) throw new Error('Annotation credential exceeds form bound');
  return token;
}

export async function originalAnnotationCredential(
  request: Request,
  env: Partial<SessionEnv>,
  identity: Identity,
  command: { viewer: string; csrfToken: string; subjectId: string; credential: string },
): Promise<string | null> {
  try {
    const bytes = Uint8Array.from(atob(command.credential.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: context(env) },
      await key(env),
      bytes.slice(12),
    );
    const captured = JSON.parse(new TextDecoder().decode(decrypted)) as {
      binding: unknown;
      csrfToken: string;
      authorization: string;
    };
    return command.viewer === identity.viewer &&
      command.csrfToken === captured.csrfToken &&
      JSON.stringify(captured.binding) === JSON.stringify(binding(request, identity.viewer, command.subjectId))
      ? captured.authorization
      : null;
  } catch {
    return null;
  }
}
