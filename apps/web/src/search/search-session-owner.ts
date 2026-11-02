import type { BrowserSession } from '../session/browser-state';

/** Retry owner identity only: credentials stay with the installed session owner. */
export function searchSessionOwner(session: BrowserSession): string | null {
  if (session.state === 'signed-out') return JSON.stringify(['signed-out']);
  if (session.state === 'signed-in' && session.subject) return JSON.stringify(['signed-in', session.subject]);
  return null;
}
