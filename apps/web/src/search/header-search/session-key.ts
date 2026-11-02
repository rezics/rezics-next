import type { QueryClient } from '@tanstack/react-query';
import {
  normalizeSessionObservation,
  sessionStateSnapshot,
  signedOutSession,
  unknownSession,
  type BrowserSession,
} from '../../session/browser-state';

/** Request identity only: grants and credentials still belong to the installed session owner. */
export function headerSearchSessionKey(session: BrowserSession = signedOutSession): string | null {
  if (session.state === 'signed-out') return JSON.stringify(['signed-out']);
  if (session.state !== 'signed-in' || !session.subject) return null;
  return JSON.stringify(['signed-in', session.subject, session.csrfToken]);
}

/** Event handlers and response callbacks must also see changes queued before React renders. */
export function currentHeaderSearchSession(client: QueryClient): BrowserSession {
  const snapshot = sessionStateSnapshot(client);
  return snapshot?.status === 'success' ? normalizeSessionObservation(snapshot.data) : unknownSession;
}
