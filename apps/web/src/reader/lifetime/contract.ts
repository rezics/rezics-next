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
