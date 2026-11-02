import type { StatementInput } from './statement-editor';

/** Navigation compares the full native correction and reuses localized draft/pending discard wording without changing command identity. */
export function statementDraftChanged(original: StatementInput | null, draft: StatementInput | null) {
  if (original === null) return draft !== null;
  if (draft === null) return true;
  return JSON.stringify(stable(original)) !== JSON.stringify(stable(draft));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(Reflect.get(value, key))]),
  );
}
