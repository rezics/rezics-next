import type { PublishedLogWriteResult } from './logs-read';

type PublicationIntent = { sessionId: string; note?: string; idempotencyKey: string };
type PublicationAttempt = { intent: PublicationIntent; credential: HeadersInit };

/** Private command custody, independent of a mounted read or operation admission. */
export type PublicationDraft = {
  sessionId: string;
  note: string;
  intent?: PublicationIntent;
  credential?: HeadersInit;
  flight?: PublicationAttempt;
  publishedId?: string;
  failure?: Extract<PublishedLogWriteResult, { ok: false }>['reason'];
  listeners: Set<() => void>;
};

export function publicationDraft(sessionId: string): PublicationDraft {
  return { sessionId, note: '', listeners: new Set() };
}

export function notifyPublication(draft: PublicationDraft) {
  draft.listeners.forEach((listener) => listener());
}

export function editPublication(draft: PublicationDraft, note: string) {
  // An unresolved publication is one explicit choice. Do not accept private edits
  // which a retry would silently ignore or a successful navigation would discard.
  if (draft.intent || draft.flight || draft.publishedId) return;
  draft.note = note;
  delete draft.failure;
  notifyPublication(draft);
}

export function beginPublication(draft: PublicationDraft, credential: HeadersInit): PublicationAttempt | undefined {
  if (draft.flight || draft.publishedId) return;
  const note = draft.note.trim();
  draft.intent ??= {
    sessionId: draft.sessionId,
    ...(note ? { note } : {}),
    idempotencyKey: crypto.randomUUID(),
  };
  const capturedCredential = (draft.credential ??= credential);
  const attempt = { intent: draft.intent, credential: capturedCredential };
  draft.flight = attempt;
  delete draft.failure;
  notifyPublication(draft);
  return attempt;
}

export function settlePublication(
  draft: PublicationDraft,
  attempt: PublicationAttempt,
  result: PublishedLogWriteResult,
) {
  if (draft.flight !== attempt) return;
  delete draft.flight;
  if (result.ok) {
    // Keep only the destination. The completed command and private input are retired,
    // even if admission changed while the response was in flight.
    draft.publishedId = result.id;
    draft.note = '';
    delete draft.intent;
    delete draft.credential;
    delete draft.failure;
  } else {
    draft.failure = result.reason;
    // Only an uncertain transport/server result retains the exact original command.
    // A definitive refusal lets the person correct their choice and submit anew.
    if (result.reason !== 'unavailable') {
      delete draft.intent;
      delete draft.credential;
    }
  }
  notifyPublication(draft);
}
