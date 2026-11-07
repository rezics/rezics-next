/** Compatibility entry for session query adapters. One browser cache owner lives in the reader boundary. */
export {
  sessionQueryKey,
  normalizeSessionObservation,
  subscribeBrowserSession,
  sessionStateSnapshot,
  cachedBrowserSession,
  ownedSessionCsrfToken,
  unknownSession,
  signedOutSession,
  type BrowserSession,
} from '../reader/lifetime/index';
