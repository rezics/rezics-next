/** A failed device write leaves the caller's recovery intact; only its receipt accepts the complete body. */
export function persistDraftBody<Draft extends { body: string; recoveryBody?: string }>(
  draft: Draft,
  body: string,
  persist: (next: Draft) => void,
) {
  const next = { ...draft, body, recoveryBody: undefined };
  persist(next);
  return next;
}
