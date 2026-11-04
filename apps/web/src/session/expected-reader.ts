import type { SessionEnv } from './client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from './request';

/** Browser credential evidence may refuse a command; only the prepared native session authorizes it. */
export type ExpectedReader = { expectedReader: string; expectedCredential: string };
export function validExpectedReader(value: Partial<ExpectedReader>): value is ExpectedReader {
  return (
    typeof value.expectedReader === 'string' &&
    value.expectedReader.length > 0 &&
    value.expectedReader.length <= 128 &&
    typeof value.expectedCredential === 'string' &&
    value.expectedCredential.length > 0 &&
    value.expectedCredential.length <= 256
  );
}
export function matchesExpectedReader(request: Request, expected: ExpectedReader): boolean {
  return (
    sessionSubject(request) === expected.expectedReader &&
    requestCsrfToken(request) === expected.expectedCredential &&
    !!viewerCredential(request)
  );
}
export async function prepareExpectedReader(request: Request, env: Partial<SessionEnv>, expected: ExpectedReader) {
  if (!validExpectedReader(expected) || (await prepareSession(request, env, { refresh: false }))) return null;
  return matchesExpectedReader(request, expected) ? viewerCredential(request) : null;
}
