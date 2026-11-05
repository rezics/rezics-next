import type { QueryClient } from '@tanstack/react-query';
import { preparePrivateReaderRead } from './private-reader-lifetime';
import { privateReaderFingerprint, samePrivateReader } from './private-reader-origin';
import { isNotFound, notFound } from '@tanstack/react-router';
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

/** A current native source replacement belongs to a new private visit. */
export function sameDecisionObservation(a: DecisionPage, b: DecisionPage): boolean {
  if (!sameDecision(a.decision, b.decision)) return false;
  // Injected presentation fixtures do not claim native provenance. Production reads always bind it.
  if (!a.nativeSourceFingerprint && !b.nativeSourceFingerprint) return true;
  return a.nativeSourceFingerprint === b.nativeSourceFingerprint;
}

export function decisionSessionKey(session: { state: string; subject?: string | null; csrfToken: string | null }) {
  return JSON.stringify([session.state, session.subject ?? null, session.csrfToken]);
}

/** A browser's unknown identity never admits a prepared private page. Target visibility is irrelevant. */
export async function decisionSessionMatches(
  page: DecisionPage,
  session: { state: string; subject?: string | null; csrfToken: string | null },
): Promise<boolean> {
  return (
    session.state === 'signed-in' &&
    !!session.subject &&
    samePrivateReader(page.readerOrigin, {
      subject: session.subject,
      csrfFingerprint: await privateReaderFingerprint(session.csrfToken),
    })
  );
}

export async function prepareDecisionRead(
  client: QueryClient,
  id: string,
  read: (id: string) => Promise<DecisionPage>,
  signal?: AbortSignal,
) {
  const page = await preparePrivateReaderRead(client, decisionReadKey(id), () => read(id), signal);
  if (page.readerBinding.retired) throw notFound();
  if (!page.readerOrigin) throw new Error('Decision read unavailable');
  return page;
}
export const decisionReadKey = (id: string) => JSON.stringify(['decision', id]);
