import { isNotFound } from '@tanstack/react-router';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { DecisionPage, ModerationDecision } from './decision-read';

export type DecisionReadState = 'loading' | 'unavailable' | 'closed' | 'platform-closed';

/** Only safe, native outcome classes cross the private read boundary. */
export function decisionReadFailure(error: unknown): Exclude<DecisionReadState, 'loading'> {
  return isPlatformClosedError(error) ? 'platform-closed' : isNotFound(error) ? 'closed' : 'unavailable';
}

export function sameDecision(a: ModerationDecision, b: ModerationDecision): boolean {
  return a.id === b.id && a.targetId === b.targetId && a.targetKind === b.targetKind;
}

export function decisionSessionKey(session: { state: string; subject?: string | null; csrfToken: string | null }) {
  return JSON.stringify([session.state, session.subject ?? null, session.csrfToken]);
}

/** A browser's unknown identity never admits a prepared private page. Target visibility is irrelevant. */
export function decisionSessionMatches(
  page: DecisionPage,
  session: { state: string; subject?: string | null; csrfToken: string | null },
): boolean {
  return Boolean(
    session.state === 'signed-in' &&
    session.subject &&
    session.csrfToken &&
    page.viewerId === session.subject &&
    page.sessionEpoch === session.csrfToken,
  );
}
