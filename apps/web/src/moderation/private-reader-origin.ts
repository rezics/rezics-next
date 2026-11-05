import { requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';

/** Identity of the authenticated reader, never command authority or a credential. */
export type PrivateReaderOrigin = { subject: string; csrfFingerprint: string };

export async function privateReaderFingerprint(token: string | null): Promise<string> {
  const input = token === null ? 'null\u0000' : `token\u0000${token}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Call after the single preparation, with the exact authorization used for the native read. */
export async function preparedPrivateReaderOrigin(
  request: Request,
  authorization: string | null,
): Promise<PrivateReaderOrigin | null> {
  const subject = sessionSubject(request);
  if (!authorization || authorization !== viewerCredential(request) || !subject) return null;
  return { subject, csrfFingerprint: await privateReaderFingerprint(requestCsrfToken(request)) };
}

export function samePrivateReader(
  a: PrivateReaderOrigin | null | undefined,
  b: PrivateReaderOrigin | null | undefined,
) {
  return !!a && !!b && a.subject === b.subject && a.csrfFingerprint === b.csrfFingerprint;
}
