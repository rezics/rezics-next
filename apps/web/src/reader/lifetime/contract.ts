/** The credential actually used for a native read; browser observations never upgrade it. */
export type ReadCredentialMode = 'anonymous' | 'session';
export const anonymousReadMode: ReadCredentialMode = 'anonymous';

/** Optional host navigation. Isolated mounts use their browser address without a Router. */
export type ReaderNavigation = {
  address: () => string;
  subscribe: (changed: () => void) => () => void;
};

/** The sign-in policy for local navigation, shared by prepared reading returns. */
export function returnTarget(value: string | null, origin: string): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  try {
    const target = new URL(value, origin);
    const path = target.pathname + target.search + target.hash;
    return target.origin === origin && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
      ? path
      : '/';
  } catch {
    return '/';
  }
}

/** Pure vocabulary shared by the session cache and mounted browser readers. */
export const sessionQueryKey = ['session'] as const;

export type BrowserSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};

export type BrowserReader = { subject: string; id: number };
export type BrowserObservationSnapshot =
  | { state: 'unknown' | 'inactive' | 'signed-out' }
  | { state: 'signed-in'; observation: BrowserReader };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export const unknownSession: BrowserSession = { state: 'unknown', csrfToken: null };
const unavailableSession: BrowserSession = { state: 'unavailable', csrfToken: null, subject: null };
export const signedOutSession: BrowserSession = { state: 'signed-out', csrfToken: null, subject: null };

/** Convert an untrusted successful response into the session states the browser may observe. */
export function normalizeSessionObservation(value: unknown): BrowserSession {
  if (!isRecord(value)) return unavailableSession;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  if (!hasOwn('state')) return unavailableSession;

  if (value.state === 'signed-in') {
    const subject = value.subject;
    const csrfToken = value.csrfToken;
    if (
      !hasOwn('subject') ||
      !hasOwn('csrfToken') ||
      !nonEmptyString(subject) ||
      !(csrfToken === null || nonEmptyString(csrfToken))
    )
      return unavailableSession;
    return { state: 'signed-in', subject, csrfToken };
  }

  if (value.state === 'signed-out') return signedOutSession;
  if (value.state === 'unavailable') return unavailableSession;
  return unavailableSession;
}
