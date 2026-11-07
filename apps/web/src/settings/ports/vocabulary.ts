/** Installed website session query. Settings and Inbox observe this key; they do not mint another. */
export const SESSION_QUERY_KEY = ['session'] as const;

/** Personal reads must start in the browser and are immediately stale. */
export const personalRead = { staleTime: 0, enabled: typeof window !== 'undefined' } as const;

export type ReadCredentialMode = 'anonymous' | 'session';

/** Cache keys include the mode so anonymous page data cannot hide signed-in state after hydration. */
export function readQueryKey(key: readonly unknown[], mode: ReadCredentialMode) {
  return [...key, mode] as const;
}

export function isSessionQueryKey(key: readonly unknown[]) {
  return key.length === 1 && key[0] === SESSION_QUERY_KEY[0];
}

type RecordValue = Record<string, unknown>;
const serializedPlatformClosedMessage = 'rezics-platform-closed';
const SESSION_UNAVAILABLE_CODE = 'session_unavailable';

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recognizes only the kernel's account-independent platform gate refusal. */
export function isPlatformClosedProblem(status: unknown, body: unknown): boolean {
  return status === 403 && isRecord(body) && body.code === 'platform_closed';
}

export class PlatformClosedError extends Error {
  constructor(
    readonly status: number,
    readonly problem: unknown,
  ) {
    super(serializedPlatformClosedMessage);
    this.name = 'PlatformClosedError';
  }
}

export function isPlatformClosedError(error: unknown): error is PlatformClosedError {
  return (
    error instanceof PlatformClosedError ||
    (isRecord(error) && (error.name === 'PlatformClosedError' || error.message === serializedPlatformClosedMessage))
  );
}

/** Recognize only the session boundary's explicit dependency failure through server-function wrappers. */
export function isSessionUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (
      ('name' in value && value.name === 'SessionUnavailableError') ||
      ('code' in value && value.code === SESSION_UNAVAILABLE_CODE)
    )
      return true;
    pending.push(
      'problem' in value ? value.problem : undefined,
      'data' in value ? value.data : undefined,
      'cause' in value ? value.cause : undefined,
    );
  }

  return false;
}

function primarySubtag(tag: string): string {
  const dash = tag.indexOf('-');
  return (dash === -1 ? tag : tag.slice(0, dash)).toLowerCase();
}

function sameLanguageTag(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Reader fallback list copied as Settings vocabulary so verification search does not import kernel languages. */
function localeChain(locale: string): string[] {
  const primary = primarySubtag(locale);
  const chain = [locale];
  if (!sameLanguageTag(primary, locale)) chain.push(primary);
  if (primary === 'zh') {
    const scripts = /-(?:Hant|TW|HK|MO)(?:-|$)/i.test(locale) ? ['zh-Hant', 'zh-Hans'] : ['zh-Hans', 'zh-Hant'];
    for (const script of scripts) if (!chain.some((tag) => sameLanguageTag(tag, script))) chain.push(script);
  }
  if (!chain.some((tag) => sameLanguageTag(tag, 'en'))) chain.push('en');
  return chain;
}

/** Languages requested for a reader, so the work's original language can win before English. */
export function requestLanguages(locale: string): string[] {
  if (locale.split('-')[0]?.toLowerCase() === 'en') return ['en'];
  return localeChain(locale).filter((language) => language !== 'en');
}
